import type { Collection, Db, MongoClient } from "mongodb";
import type { MerchantRecord, MerchantReceipt, MerchantStore, MerchantTransaction } from "./merchant.js";

type OfferDocument<O> = { _id: string; record: MerchantRecord<O> };
type BookingDocument = { _id: string; receipt: MerchantReceipt };
type OutboxDocument<E> = { _id: string; event: E; createdAt: Date; deliveredAt?: Date };

/** Mongo replica set/Atlas required. No nontransactional fallback. */
export class MongoMerchantStore<O, E> implements MerchantStore<O, E> {
  private readonly offers: Collection<OfferDocument<O>>;
  private readonly bookings: Collection<BookingDocument>;
  private readonly outbox: Collection<OutboxDocument<E>>;
  constructor(private readonly client: MongoClient, db: Db) {
    this.offers = db.collection("merchant_offers");
    this.bookings = db.collection("merchant_bookings");
    this.outbox = db.collection("merchant_outbox");
  }
  async transaction<T>(run: (tx: MerchantTransaction<O, E>) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      const result = await session.withTransaction(async () => run({
        getOffer: async id => (await this.offers.findOne({ _id: id }, { session }))?.record,
        putOffer: async (id, record) => { await this.offers.replaceOne({ _id: id }, { record }, { session, upsert: true }); },
        getBooking: async key => (await this.bookings.findOne({ _id: key }, { session }))?.receipt,
        putBooking: async receipt => { await this.bookings.insertOne({ _id: receipt.idempotencyKey, receipt }, { session }); },
        enqueue: async (id, event) => { await this.outbox.insertOne({ _id: id, event, createdAt: new Date() }, { session }); },
      }), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10_000 });
      return result as T;
    } finally { await session.endSession(); }
  }

  /** At-least-once. Backend handler must be idempotent by event ID and do stale/replan before optional sponsors. */
  async drain(deliver: (eventId: string, event: E) => Promise<void>, limit = 100) {
    const pending = await this.outbox.find({ deliveredAt: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).limit(limit).toArray();
    for (const item of pending) {
      await deliver(item._id, item.event);
      await this.outbox.updateOne({ _id: item._id }, { $set: { deliveredAt: new Date() } });
    }
    return pending.length;
  }
}
