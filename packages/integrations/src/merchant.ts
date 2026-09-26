import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { IntegrationError } from "./result.js";

/** All domain types are supplied from the backend; these are persistence ports only. */
export interface MerchantContract<Offer, Mutation, Event> {
  offer: z.ZodType<Offer>;
  mutation: z.ZodType<Mutation>;
  event: z.ZodType<Event>;
  id(offer: Offer): string;
  version(offer: Offer): string;
  available(offer: Offer): boolean;
  expiresAt(offer: Offer): string;
  // Backend binding implements the shared MerchantMutation union, including restore.
  apply(current: Offer, original: Offer, mutation: Mutation): { offer: Offer; failNextBooking: boolean };
  mutationEvent(before: Offer, after: Offer, mutation: Mutation): Event;
  bookingEvent(offer: Offer, reference: string): Event;
}

export type MerchantRecord<O> = { offer: O; original: O; failNextBooking: boolean; booked: boolean };
export type MerchantReceipt = {
  mode: "SIMULATED"; status: "CONFIRMED"; bookingReference: string;
  offerId: string; offerVersion: string; idempotencyKey: string; confirmedAt: string;
};
export interface MerchantTransaction<O, E> {
  getOffer(id: string): Promise<MerchantRecord<O> | undefined>;
  putOffer(id: string, record: MerchantRecord<O>): Promise<void>;
  getBooking(key: string): Promise<MerchantReceipt | undefined>;
  putBooking(receipt: MerchantReceipt): Promise<void>;
  enqueue(eventId: string, event: E): Promise<void>;
}
export interface MerchantStore<O, E> {
  // MUST provide serializable/transactional conflict handling across processes.
  transaction<T>(run: (tx: MerchantTransaction<O, E>) => Promise<T>): Promise<T>;
}

export class Merchant<O, M, E> {
  constructor(private readonly store: MerchantStore<O, E>, private readonly contract: MerchantContract<O, M, E>, private readonly now = () => new Date()) {}

  async seed(offers: readonly O[]) {
    await this.store.transaction(async tx => {
      for (const value of offers) {
        const offer = this.contract.offer.parse(value), id = this.contract.id(offer);
        if (!await tx.getOffer(id)) await tx.putOffer(id, { offer, original: structuredClone(offer), failNextBooking: false, booked: false });
      }
    });
  }

  /** Internal only: the backend must authenticate admin access before invoking this. */
  mutate(offerId: string, value: M) {
    const mutation = this.contract.mutation.parse(value);
    return this.store.transaction(async tx => {
      const record = await tx.getOffer(offerId);
      if (!record) throw new IntegrationError("OFFER_NOT_FOUND");
      const before = this.contract.offer.parse(record.offer);
      const changed = this.contract.apply(structuredClone(before), structuredClone(record.original), mutation);
      const after = this.contract.offer.parse(changed.offer);
      if (this.contract.id(after) !== offerId || this.contract.version(after) === this.contract.version(before)) {
        throw new IntegrationError("MUTATION_MUST_ADVANCE_VERSION");
      }
      await tx.putOffer(offerId, { ...record, offer: after, failNextBooking: changed.failNextBooking });
      await tx.enqueue(randomUUID(), this.contract.event.parse(this.contract.mutationEvent(before, after, mutation)));
      return after;
    });
  }

  /** This is the merchant boundary, NOT consent/payment permission. Invoke only from domain execute. */
  async execute(input: { offerId: string; expectedOfferVersion: string; idempotencyKey: string }) {
    if (!input.offerId || !input.expectedOfferVersion || !input.idempotencyKey) throw new IntegrationError("INVALID_EXECUTION");
    const result = await this.store.transaction(async tx => {
      const previous = await tx.getBooking(input.idempotencyKey);
      if (previous) {
        if (previous.offerId !== input.offerId || previous.offerVersion !== input.expectedOfferVersion) throw new IntegrationError("IDEMPOTENCY_CONFLICT");
        return { receipt: previous };
      }
      const record = await tx.getOffer(input.offerId);
      if (!record) throw new IntegrationError("OFFER_NOT_FOUND");
      const offer = this.contract.offer.parse(record.offer);
      if (this.contract.version(offer) !== input.expectedOfferVersion) throw new IntegrationError("OFFER_VERSION_MISMATCH");
      if (record.booked || !this.contract.available(offer)) throw new IntegrationError("OFFER_UNAVAILABLE");
      const expires = Date.parse(this.contract.expiresAt(offer));
      if (!Number.isFinite(expires) || expires <= this.now().getTime()) throw new IntegrationError("OFFER_EXPIRED");
      if (record.failNextBooking) {
        await tx.putOffer(input.offerId, { ...record, failNextBooking: false });
        return { failed: true as const }; // Commit consumption of the one-shot failure.
      }
      const receipt: MerchantReceipt = {
        mode: "SIMULATED", status: "CONFIRMED", bookingReference: `demo-${randomUUID()}`,
        offerId: input.offerId, offerVersion: input.expectedOfferVersion,
        idempotencyKey: input.idempotencyKey, confirmedAt: this.now().toISOString(),
      };
      await tx.putOffer(input.offerId, { ...record, booked: true });
      await tx.putBooking(receipt);
      await tx.enqueue(randomUUID(), this.contract.event.parse(this.contract.bookingEvent(offer, receipt.bookingReference)));
      return { receipt };
    });
    if (result.failed) throw new IntegrationError("DEMO_BOOKING_FAILURE");
    return result.receipt!;
  }
}
