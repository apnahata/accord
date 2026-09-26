import type { MerchantRecord, MerchantReceipt, MerchantStore, MerchantTransaction } from "../../integrations/src/merchant.js";

/** Local demo storage. Real deployment requires the Mongo transactional store. */
export class MemoryMerchantStore<O, E> implements MerchantStore<O, E> {
  #offers = new Map<string, MerchantRecord<O>>();
  #bookings = new Map<string, MerchantReceipt>();
  #outbox = new Map<string, E>();
  #pending = Promise.resolve();

  async transaction<T>(run: (tx: MerchantTransaction<O, E>) => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const previous = this.#pending;
    this.#pending = next;
    await previous;
    const offers = new Map([...this.#offers].map(([key, value]) => [key, structuredClone(value)]));
    const bookings = new Map([...this.#bookings].map(([key, value]) => [key, structuredClone(value)]));
    const outbox = new Map([...this.#outbox].map(([key, value]) => [key, structuredClone(value)]));
    try {
      const result = await run({
        getOffer: async id => structuredClone(offers.get(id)),
        putOffer: async (id, record) => { offers.set(id, structuredClone(record)); },
        getBooking: async key => structuredClone(bookings.get(key)),
        putBooking: async receipt => { if (bookings.has(receipt.idempotencyKey)) throw new Error("DUPLICATE_BOOKING"); bookings.set(receipt.idempotencyKey, structuredClone(receipt)); },
        enqueue: async (id, event) => { outbox.set(id, structuredClone(event)); },
      });
      this.#offers = offers; this.#bookings = bookings; this.#outbox = outbox;
      return result;
    } finally { release(); }
  }

  async drain(deliver: (id: string, event: E) => Promise<void>) {
    const items = [...this.#outbox];
    for (const [id, event] of items) { await deliver(id, structuredClone(event)); this.#outbox.delete(id); }
    return items.length;
  }
}
