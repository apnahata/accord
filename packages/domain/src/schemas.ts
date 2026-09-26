import { z } from "zod";

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });

/** The only authoritative business input schemas. Frontend and providers import these. */
export const ConstraintsSchema = z.object({
  maxContributionCents: money,
  latestCheckOutAt: instant.optional(),
  requiresFullCashRefund: z.boolean(),
  requiresStepFreeAccess: z.boolean(),
  softPreference: z.string().max(1000),
}).strict();
export type Constraints = z.infer<typeof ConstraintsSchema>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Public trip parameters the host sets. Private limits never go here. */
export const TripSchema = z.object({
  destination: z.string().trim().min(2).max(120),
  countryCode: z.string().regex(/^[A-Z]{2}$/).default("US"),
  checkIn: day, checkOut: day,
  guests: z.number().int().min(1).max(8),
  timeZone: z.string().min(1).max(64).default("America/New_York"),
}).strict().refine(trip => trip.checkOut > trip.checkIn, "Check-out must be after check-in")
  .refine(trip => (Date.parse(trip.checkOut) - Date.parse(trip.checkIn)) / 86_400_000 <= 14, "Stays are limited to 14 nights");
export type Trip = z.infer<typeof TripSchema>;

export const OfferSchema = z.object({
  offerId: z.string().min(1),
  offerVersion: z.string().min(1),
  merchantId: z.string().min(1),
  merchantName: z.string().min(1),
  propertyId: z.string().min(1),
  propertyName: z.string().min(1),
  city: z.string().min(1),
  roomType: z.string().min(1),
  checkInAt: instant,
  checkOutAt: instant,
  guestCapacity: z.number().int().nonnegative(),
  stepFreeVerified: z.boolean().nullable(),
  cancellationPolicyCode: z.enum(["FULL_CASH_REFUND", "TRAVEL_CREDIT", "NON_REFUNDABLE"]),
  fullRefundDeadline: instant.optional(),
  subtotalCents: money,
  mandatoryFeesCents: money,
  totalCents: money,
  currency: z.literal("USD"),
  available: z.boolean(),
  expiresAt: instant,
  walkable: z.boolean(),
  nearActivities: z.boolean(),
  quiet: z.boolean(),
  /** Provenance. Absent on the controlled demo catalog. */
  source: z.enum(["DEMO", "LITEAPI", "GOOGLE_HOTELS"]).optional(),
  bookingMode: z.enum(["SIMULATED", "SANDBOX", "EXTERNAL"]).optional(),
  externalUrl: z.url().optional(),
  imageUrl: z.url().optional(),
  address: z.string().max(300).optional(),
  rating: z.number().min(0).max(10).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
}).strict().refine(value => value.subtotalCents + value.mandatoryFeesCents === value.totalCents, "Total must include mandatory fees");
export type Offer = z.infer<typeof OfferSchema>;

export const MerchantMutationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("INCREASE_PRICE"), newTotalCents: money }).strict(),
  z.object({ type: z.literal("CHANGE_CANCELLATION"), code: z.enum(["FULL_CASH_REFUND", "TRAVEL_CREDIT", "NON_REFUNDABLE"]) }).strict(),
  z.object({ type: z.literal("CHANGE_ROOM"), roomType: z.string().min(1).max(120), propertyId: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal("CHANGE_CAPACITY"), guestCapacity: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("CHANGE_STEP_FREE"), value: z.boolean().nullable() }).strict(),
  z.object({ type: z.literal("SELL_OUT") }).strict(),
  z.object({ type: z.literal("RESTORE") }).strict(),
  z.object({ type: z.literal("ADD_MANDATORY_FEE"), feeDeltaCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ type: z.literal("FAIL_NEXT_BOOKING") }).strict(),
]);
export type MerchantMutation = z.infer<typeof MerchantMutationSchema>;

export const PublicEventSchema = z.object({ roomId: z.string(), type: z.string(), proposalId: z.string().optional(), at: instant }).strict();
export const PrivateEventSchema = z.object({ roomId: z.string(), type: z.string(), proposalId: z.string().optional(), at: instant }).strict();
export type PublicEvent = z.infer<typeof PublicEventSchema>;
export type PrivateEvent = z.infer<typeof PrivateEventSchema>;
export const MerchantEventSchema = z.object({
  type: z.enum(["MERCHANT_OFFER_MUTATED", "BOOKING_CONFIRMED"]),
  offerId: z.string().min(1),
  beforeVersion: z.string().optional(), afterVersion: z.string().optional(),
  bookingReference: z.string().optional(),
}).strict();
export type MerchantEvent = z.infer<typeof MerchantEventSchema>;

export const ExtractionSchema = z.object({
  proposed: z.object({
    maxContributionCents: money.optional(), latestCheckOutAt: instant.optional(),
    requiresFullCashRefund: z.boolean().optional(), requiresStepFreeAccess: z.boolean().optional(),
    softPreferences: z.array(z.object({ kind: z.enum(["LOWEST_PRICE", "WALKABLE", "NEAR_ACTIVITIES", "QUIET"]), weight: z.number().min(0).max(1) })).optional(),
  }).strict(),
  privacy: z.object({ reasonPrivate: z.boolean() }).strict(),
  unsupportedHardRequirements: z.array(z.object({ rawText: z.string(), reason: z.string() }).strict()),
  ambiguities: z.array(z.object({ field: z.string(), question: z.string() }).strict()),
}).strict();
export type Extraction = z.infer<typeof ExtractionSchema>;
