import { OfferSchema, type Offer } from "./schemas.js";

const stay = { checkInAt: "2027-03-10T21:00:00.000Z", checkOutAt: "2027-03-14T15:00:00.000Z" };
const base = {
  offerVersion: "v1", merchantId: "accord-demo-merchant", merchantName: "Accord Demo Merchant",
  ...stay, guestCapacity: 4, stepFreeVerified: true, cancellationPolicyCode: "FULL_CASH_REFUND" as const,
  fullRefundDeadline: "2027-03-01T17:00:00.000Z", currency: "USD" as const,
  available: true, expiresAt: "2027-03-09T17:00:00.000Z",
  walkable: false, nearActivities: false, quiet: false,
};
function offer(value: Partial<Offer> & Pick<Offer, "offerId" | "propertyId" | "propertyName" | "city" | "roomType" | "totalCents">): Offer {
  return OfferSchema.parse({ ...base, ...value, subtotalCents: value.totalCents - (value.mandatoryFeesCents ?? 8000), mandatoryFeesCents: value.mandatoryFeesCents ?? 8000 });
}

/** Controlled synthetic inventory, visibly labeled as demo merchant data. */
export function demoCatalog(): Offer[] {
  return [
    offer({ offerId: "miami-ocean-walk", propertyId: "miami-apartment", propertyName: "Miami Ocean Walk", city: "Miami", roomType: "Shared apartment", totalCents: 120000, mandatoryFeesCents: 10000, walkable: true, nearActivities: true }),
    offer({ offerId: "tampa-river-court", propertyId: "tampa-apartment", propertyName: "Tampa River Court", city: "Tampa", roomType: "Shared apartment", totalCents: 112000, quiet: true }),
    offer({ offerId: "miami-bay-view", propertyId: "miami-bay", propertyName: "Miami Bay View", city: "Miami", roomType: "Suite", totalCents: 155000, walkable: true, nearActivities: true }),
    offer({ offerId: "tampa-three-bed", propertyId: "tampa-three", propertyName: "Tampa Three Bed", city: "Tampa", roomType: "Apartment", totalCents: 108000, guestCapacity: 3, quiet: true }),
    offer({ offerId: "miami-credit-stay", propertyId: "miami-credit", propertyName: "Miami Credit Stay", city: "Miami", roomType: "Shared apartment", totalCents: 116000, cancellationPolicyCode: "TRAVEL_CREDIT", walkable: true }),
    offer({ offerId: "tampa-access-unknown", propertyId: "tampa-unknown", propertyName: "Tampa Access Unknown", city: "Tampa", roomType: "Shared apartment", totalCents: 109000, stepFreeVerified: null, quiet: true }),
    offer({ offerId: "orlando-late-checkout", propertyId: "orlando-late", propertyName: "Orlando Late Checkout", city: "Orlando", roomType: "Shared apartment", totalCents: 113000, checkOutAt: "2027-03-14T18:00:00.000Z", nearActivities: true }),
    offer({ offerId: "st-pete-sold-out", propertyId: "st-pete", propertyName: "St. Pete Courtyard", city: "St. Petersburg", roomType: "Shared apartment", totalCents: 111000, available: false, quiet: true }),
  ];
}
