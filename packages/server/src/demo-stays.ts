import { createHash } from "node:crypto";
import { addDays, daysBetween, DESTINATIONS, OfferSchema, type Offer, type Trip, type TripStyle } from "@accord/domain";
import { localToInstant } from "./stays.js";

/**
 * Rehearsal stays for any destination and dates, so trip planning plays out without provider keys.
 * Deterministic: the same destination and dates always produce the same three stays, which book
 * through the controlled demo merchant like the fixed catalog does.
 */
const names: Record<TripStyle, [string, string, string]> = {
  BEACH: ["Dune Grass Cottages", "Seaside Terrace Suites", "Palm Court Beach House"],
  MOUNTAINS: ["Ridgeline Cabin", "Creekside Lodge", "Pine Hollow Retreat"],
  SKI: ["Slopeside Lodge", "Alpine Chalet", "Summit House"],
  CITY: ["Old Town Lofts", "Park Row Flats", "Downtown Suites"],
  NATURE: ["Trailhead Cabins", "Wildflower Lodge", "Stillwater Retreat"],
  THEME_PARKS: ["Parkside Villas", "Resort Row Suites", "Lakeview Condos"],
  LAKE: ["Lakefront Cabin", "Dockside Cottages", "Harbor Lights Inn"],
};

export function demoStays(trip: Trip, now = Date.now()): Offer[] {
  const known = DESTINATIONS.find(item => item.name.toLowerCase() === trip.destination.toLowerCase());
  const styles = known?.styles ?? ["CITY"];
  const priceIndex = known?.priceIndex ?? 1;
  const nights = daysBetween(trip.checkIn, trip.checkOut);
  const seed = createHash("sha256").update(`${trip.destination}|${trip.checkIn}|${trip.checkOut}`).digest();
  const slug = trip.destination.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const city = trip.destination.split(",")[0]!.trim();
  const checkInAt = localToInstant(trip.checkIn, "4:00 PM", trip.timeZone);
  const refundBy = localToInstant(addDays(trip.checkIn, now + 10 * 86_400_000 < Date.parse(checkInAt) ? -7 : -1), "11:59 PM", trip.timeZone);
  const expiresAt = new Date(Math.min(Date.parse(checkInAt), now + 7 * 86_400_000)).toISOString();
  // Three price tiers per place. The cheapest trades away refunds and verified access, like real listings often do.
  const tiers = [
    { multiplier: 0.8, policy: "TRAVEL_CREDIT" as const, stepFree: null, checkout: "10:00 AM", walkable: false, quiet: true, nearActivities: false, capacity: 6 },
    { multiplier: 1, policy: "FULL_CASH_REFUND" as const, stepFree: true, checkout: "11:00 AM", walkable: true, quiet: seed[0]! % 2 === 0, nearActivities: seed[1]! % 2 === 0, capacity: 8 },
    { multiplier: 1.35, policy: "FULL_CASH_REFUND" as const, stepFree: true, checkout: "12:00 PM", walkable: true, quiet: false, nearActivities: true, capacity: 10 },
  ];
  return tiers.map((tier, index) => {
    const jitter = 0.9 + (seed[2 + index]! / 255) * 0.2;
    const nightly = Math.round(260 * priceIndex * tier.multiplier * jitter) * 100;
    const subtotal = nightly * nights, fees = Math.round(subtotal * 0.08 / 100) * 100;
    const style = styles[index % styles.length]!;
    return OfferSchema.parse({
      offerId: `demo-${slug}-${trip.checkIn}-${nights}n-${index + 1}`, offerVersion: "v1",
      merchantId: "accord-rehearsal", merchantName: "Accord rehearsal stays",
      propertyId: `demo-${slug}-${index + 1}`, propertyName: `${city} ${names[style][index]}`,
      city: trip.destination, roomType: index === 2 ? "Four-bedroom house" : index === 1 ? "Three-bedroom suite" : "Two-bedroom apartment",
      checkInAt, checkOutAt: localToInstant(trip.checkOut, tier.checkout, trip.timeZone),
      guestCapacity: tier.capacity, stepFreeVerified: tier.stepFree, cancellationPolicyCode: tier.policy,
      ...(tier.policy === "FULL_CASH_REFUND" ? { fullRefundDeadline: refundBy } : {}),
      subtotalCents: subtotal, mandatoryFeesCents: fees, totalCents: subtotal + fees, currency: "USD",
      available: true, expiresAt, walkable: tier.walkable, nearActivities: tier.nearActivities, quiet: tier.quiet,
      source: "DEMO", bookingMode: "SIMULATED",
    });
  });
}
