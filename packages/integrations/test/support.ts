import type { MerchantReceipt, MerchantRecord, MerchantStore, MerchantTransaction } from "../src/merchant.js";

/** Test double only. Production uses MongoMerchantStore. */
export class TestStore<O, E> implements MerchantStore<O, E> {
  offers = new Map<string, MerchantRecord<O>>();
  bookings = new Map<string, MerchantReceipt>();
  events = new Map<string, E>();
  private tail = Promise.resolve();
  transaction<T>(run: (tx: MerchantTransaction<O, E>) => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      const offers = structuredClone(this.offers), bookings = structuredClone(this.bookings), events = structuredClone(this.events);
      const result = await run({
        getOffer: async id => offers.get(id), putOffer: async (id, record) => { offers.set(id, record); },
        getBooking: async key => bookings.get(key), putBooking: async receipt => { bookings.set(receipt.idempotencyKey, receipt); },
        enqueue: async (id, event) => { events.set(id, event); },
      });
      this.offers = offers; this.bookings = bookings; this.events = events;
      return result;
    });
    this.tail = task.then(() => {}, () => {});
    return task;
  }
}
