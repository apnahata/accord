import { createHash } from "node:crypto";
import type { Availability, Constraints, MerchantMutation, Offer, TripPlan } from "./schemas.js";
import { OfferSchema } from "./schemas.js";

export function equalShares(totalCents: number, memberIds: readonly string[]) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !memberIds.length || new Set(memberIds).size !== memberIds.length) throw new Error("INVALID_SPLIT");
  const ids = [...memberIds].sort();
  const base = Math.floor(totalCents / ids.length), remainder = totalCents % ids.length;
  return Object.fromEntries(ids.map((id, index) => [id, base + Number(index < remainder)]));
}

/** Calendar day (YYYY-MM-DD) of an instant in the given time zone. */
export function localDay(instant: string, timeZone = "America/New_York") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}
export function addDays(day: string, days: number) {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
export const fitsAvailability = (availability: readonly Availability[] | undefined, checkIn: string, checkOut: string) =>
  !availability?.length || availability.some(range => range.from <= checkIn && checkOut <= range.to);

export type Check = { kind: "BUDGET" | "CHECKOUT" | "REFUND" | "STEP_FREE" | "CAPACITY" | "AVAILABLE" | "EXPIRED" | "DATES"; label: string; status: "PASS" | "FAIL" | "UNKNOWN"; privateExplanation: string };
export function checkMember(offer: Offer, constraints: Constraints, contributionCents: number, memberCount: number, now = new Date(), timeZone = "America/New_York"): Check[] {
  const cents = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
  const dates: Check[] = constraints.availability?.length ? [(() => {
    const ok = fitsAvailability(constraints.availability, localDay(offer.checkInAt, timeZone), localDay(offer.checkOutAt, timeZone));
    return { kind: "DATES" as const, label: "Your dates", status: ok ? "PASS" as const : "FAIL" as const,
      privateExplanation: ok ? "The stay falls within the dates you said you can travel." : "The stay falls outside the dates you said you can travel." };
  })()] : [];
  return [...dates,
    { kind: "BUDGET", label: "Your contribution", status: contributionCents <= constraints.maxContributionCents ? "PASS" : "FAIL", privateExplanation: contributionCents <= constraints.maxContributionCents ? `Your ${cents(contributionCents)} share is within your confirmed maximum.` : `Your ${cents(contributionCents)} share exceeds your confirmed maximum of ${cents(constraints.maxContributionCents)}.` },
    { kind: "CHECKOUT", label: "Latest checkout", status: !constraints.latestCheckOutAt || Date.parse(offer.checkOutAt) <= Date.parse(constraints.latestCheckOutAt) ? "PASS" : "FAIL", privateExplanation: !constraints.latestCheckOutAt || Date.parse(offer.checkOutAt) <= Date.parse(constraints.latestCheckOutAt) ? "Checkout meets your confirmed time." : "Checkout is later than your confirmed latest time." },
    { kind: "REFUND", label: "Full cash refund", status: !constraints.requiresFullCashRefund || (offer.cancellationPolicyCode === "FULL_CASH_REFUND" && !!offer.fullRefundDeadline && Date.parse(offer.fullRefundDeadline) > now.getTime()) ? "PASS" : "FAIL", privateExplanation: !constraints.requiresFullCashRefund ? "You did not require a full cash refund." : offer.cancellationPolicyCode === "FULL_CASH_REFUND" ? "The full cash refund requirement is satisfied." : "This offer no longer provides the full cash refund you required." },
    { kind: "STEP_FREE", label: "Verified step-free access", status: !constraints.requiresStepFreeAccess ? "PASS" : offer.stepFreeVerified === null ? "UNKNOWN" : offer.stepFreeVerified ? "PASS" : "FAIL", privateExplanation: !constraints.requiresStepFreeAccess ? "You did not require verified step-free access." : offer.stepFreeVerified ? "The listing reports step-free or wheelchair access." : "Step-free access is not confirmed for this stay." },
    { kind: "CAPACITY", label: "Guest capacity", status: offer.guestCapacity >= memberCount ? "PASS" : "FAIL", privateExplanation: offer.guestCapacity >= memberCount ? "The stay can hold the group." : "This stay cannot hold the full group." },
    { kind: "AVAILABLE", label: "Current availability", status: offer.available ? "PASS" : "FAIL", privateExplanation: offer.available ? "The provider reports availability." : "The provider reports this stay is no longer available." },
    { kind: "EXPIRED", label: "Offer deadline", status: Date.parse(offer.expiresAt) > now.getTime() ? "PASS" : "FAIL", privateExplanation: Date.parse(offer.expiresAt) > now.getTime() ? "The offer has not expired." : "This offer has expired." },
  ];
}

export function assessOffer(offer: Offer, members: readonly { id: string; constraints: Constraints }[], now = new Date()) {
  const shares = equalShares(offer.totalCents, members.map(member => member.id));
  const checks = Object.fromEntries(members.map(member => [member.id, checkMember(offer, member.constraints, shares[member.id]!, members.length, now)])) as Record<string, Check[]>;
  return { shares, checks, feasible: members.length > 0 && Object.values(checks).every(items => items.every(item => item.status === "PASS")) };
}

export type NearMiss = { memberId: string; offerId: string; offerVersion: string; check: "BUDGET" | "REFUND" | "CHECKOUT" | "DATES"; shareCents: number; gapCents?: number };
const negotiable = new Set<Check["kind"]>(["BUDGET", "REFUND", "CHECKOUT", "DATES"]);

/**
 * Offers blocked by exactly one member on exactly one check that member could choose to relax.
 * Accessibility needs are never offered for renegotiation. Returns at most one (the cheapest) per member.
 */
export function nearMisses(offers: readonly Offer[], members: readonly { id: string; constraints: Constraints }[], now = new Date(), maxBudgetStretch = 0.2): NearMiss[] {
  const best = new Map<string, NearMiss>();
  for (const offer of offers) {
    const { shares, checks } = assessOffer(offer, members, now);
    const failing = Object.entries(checks).filter(([, items]) => items.some(item => item.status !== "PASS"));
    if (failing.length !== 1) continue;
    const [memberId, items] = failing[0]!;
    const blocked = items.filter(item => item.status !== "PASS");
    if (blocked.length !== 1 || blocked[0]!.status !== "FAIL" || !negotiable.has(blocked[0]!.kind)) continue;
    const check = blocked[0]!.kind as NearMiss["check"];
    const cap = members.find(member => member.id === memberId)!.constraints.maxContributionCents;
    const share = shares[memberId]!;
    if (check === "BUDGET" && share > cap * (1 + maxBudgetStretch)) continue;
    const candidate: NearMiss = { memberId, offerId: offer.offerId, offerVersion: offer.offerVersion, check, shareCents: share, ...(check === "BUDGET" ? { gapCents: share - cap } : {}) };
    const previous = best.get(memberId);
    if (!previous || candidate.shareCents < previous.shareCents) best.set(memberId, candidate);
  }
  return [...best.values()];
}

export type DateWindow = { checkIn: string; checkOut: string };
/**
 * Every trip-length window inside the plan, split into windows everyone can make and windows exactly one
 * member can't. Members who gave no dates are free throughout. Picks up to `limit` non-overlapping
 * shared windows, earliest first; near windows name the one member who would need to adjust.
 */
export function dateWindows(plan: Pick<TripPlan, "earliest" | "latest" | "nights">, members: readonly { id: string; constraints: Pick<Constraints, "availability"> }[], limit = 2) {
  const shared: DateWindow[] = [], near: Array<DateWindow & { memberId: string }> = [];
  for (let checkIn = plan.earliest; addDays(checkIn, plan.nights) <= plan.latest; checkIn = addDays(checkIn, 1)) {
    const window = { checkIn, checkOut: addDays(checkIn, plan.nights) };
    const blocked = members.filter(member => !fitsAvailability(member.constraints.availability, window.checkIn, window.checkOut));
    if (!blocked.length) shared.push(window);
    else if (blocked.length === 1 && members.length > 1) near.push({ ...window, memberId: blocked[0]!.id });
  }
  const picked: DateWindow[] = [];
  for (const window of shared) {
    if (picked.length >= limit) break;
    if (picked.every(other => window.checkIn >= other.checkOut || window.checkOut <= other.checkIn)) picked.push(window);
  }
  const nearest = new Map<string, DateWindow & { memberId: string }>();
  for (const window of near) if (!nearest.has(window.memberId)) nearest.set(window.memberId, window);
  return { windows: picked, sharedCount: shared.length, near: [...nearest.values()] };
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function proposalHash(snapshot: unknown) { return createHash("sha256").update(canonicalize(snapshot)).digest("hex"); }

export function materialOfferEquals(a: Offer, b: Offer) {
  const fields: Array<keyof Offer> = ["offerId", "offerVersion", "merchantId", "propertyId", "roomType", "checkInAt", "checkOutAt", "guestCapacity", "stepFreeVerified", "cancellationPolicyCode", "fullRefundDeadline", "mandatoryFeesCents", "totalCents", "currency", "available", "expiresAt"];
  return fields.every(key => a[key] === b[key]);
}

export function applyMerchantMutation(current: Offer, original: Offer, mutation: MerchantMutation): { offer: Offer; failNextBooking: boolean } {
  const nextVersion = `v${Number(current.offerVersion.slice(1)) + 1}`;
  if (!Number.isSafeInteger(Number(current.offerVersion.slice(1)))) throw new Error("INVALID_VERSION");
  let next: Offer = { ...current, offerVersion: nextVersion };
  switch (mutation.type) {
    case "INCREASE_PRICE":
      if (mutation.newTotalCents <= current.totalCents || mutation.newTotalCents < current.mandatoryFeesCents) throw new Error("PRICE_MUST_INCREASE");
      next = { ...next, totalCents: mutation.newTotalCents, subtotalCents: mutation.newTotalCents - current.mandatoryFeesCents }; break;
    case "CHANGE_CANCELLATION": next = { ...next, cancellationPolicyCode: mutation.code }; break;
    case "CHANGE_ROOM": next = { ...next, roomType: mutation.roomType, propertyId: mutation.propertyId ?? current.propertyId }; break;
    case "CHANGE_CAPACITY": next = { ...next, guestCapacity: mutation.guestCapacity }; break;
    case "CHANGE_STEP_FREE": next = { ...next, stepFreeVerified: mutation.value }; break;
    case "SELL_OUT": next = { ...next, available: false }; break;
    case "RESTORE": next = { ...original, offerVersion: nextVersion }; break;
    case "ADD_MANDATORY_FEE": next = { ...next, mandatoryFeesCents: current.mandatoryFeesCents + mutation.feeDeltaCents, totalCents: current.totalCents + mutation.feeDeltaCents }; break;
    case "FAIL_NEXT_BOOKING": break;
  }
  return { offer: OfferSchema.parse(next), failNextBooking: mutation.type === "FAIL_NEXT_BOOKING" };
}
