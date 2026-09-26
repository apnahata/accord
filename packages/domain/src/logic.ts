import { createHash } from "node:crypto";
import type { Constraints, MerchantMutation, Offer } from "./schemas.js";
import { OfferSchema } from "./schemas.js";

export function equalShares(totalCents: number, memberIds: readonly string[]) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !memberIds.length || new Set(memberIds).size !== memberIds.length) throw new Error("INVALID_SPLIT");
  const ids = [...memberIds].sort();
  const base = Math.floor(totalCents / ids.length), remainder = totalCents % ids.length;
  return Object.fromEntries(ids.map((id, index) => [id, base + Number(index < remainder)]));
}

export type Check = { kind: "BUDGET" | "CHECKOUT" | "REFUND" | "STEP_FREE" | "CAPACITY" | "AVAILABLE" | "EXPIRED"; label: string; status: "PASS" | "FAIL" | "UNKNOWN"; privateExplanation: string };
export function checkMember(offer: Offer, constraints: Constraints, contributionCents: number, memberCount: number, now = new Date()): Check[] {
  const cents = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
  return [
    { kind: "BUDGET", label: "Your contribution", status: contributionCents <= constraints.maxContributionCents ? "PASS" : "FAIL", privateExplanation: contributionCents <= constraints.maxContributionCents ? `Your ${cents(contributionCents)} share is within your confirmed maximum.` : `Your ${cents(contributionCents)} share exceeds your confirmed maximum of ${cents(constraints.maxContributionCents)}.` },
    { kind: "CHECKOUT", label: "Latest checkout", status: !constraints.latestCheckOutAt || Date.parse(offer.checkOutAt) <= Date.parse(constraints.latestCheckOutAt) ? "PASS" : "FAIL", privateExplanation: !constraints.latestCheckOutAt || Date.parse(offer.checkOutAt) <= Date.parse(constraints.latestCheckOutAt) ? "Checkout meets your confirmed time." : "Checkout is later than your confirmed latest time." },
    { kind: "REFUND", label: "Full cash refund", status: !constraints.requiresFullCashRefund || (offer.cancellationPolicyCode === "FULL_CASH_REFUND" && !!offer.fullRefundDeadline && Date.parse(offer.fullRefundDeadline) > now.getTime()) ? "PASS" : "FAIL", privateExplanation: !constraints.requiresFullCashRefund ? "You did not require a full cash refund." : offer.cancellationPolicyCode === "FULL_CASH_REFUND" ? "The full cash refund requirement is satisfied." : "This offer no longer provides the full cash refund you required." },
    { kind: "STEP_FREE", label: "Verified step-free access", status: !constraints.requiresStepFreeAccess ? "PASS" : offer.stepFreeVerified === null ? "UNKNOWN" : offer.stepFreeVerified ? "PASS" : "FAIL", privateExplanation: !constraints.requiresStepFreeAccess ? "You did not require verified step-free access." : offer.stepFreeVerified ? "The demo merchant reports verified step-free access." : "Verified step-free access is unavailable or unknown for this offer." },
    { kind: "CAPACITY", label: "Guest capacity", status: offer.guestCapacity >= memberCount ? "PASS" : "FAIL", privateExplanation: offer.guestCapacity >= memberCount ? "The stay can hold the group." : "This stay cannot hold the full group." },
    { kind: "AVAILABLE", label: "Current availability", status: offer.available ? "PASS" : "FAIL", privateExplanation: offer.available ? "The demo merchant reports availability." : "The demo merchant reports this stay is sold out." },
    { kind: "EXPIRED", label: "Offer deadline", status: Date.parse(offer.expiresAt) > now.getTime() ? "PASS" : "FAIL", privateExplanation: Date.parse(offer.expiresAt) > now.getTime() ? "The offer has not expired." : "This offer has expired." },
  ];
}

export function assessOffer(offer: Offer, members: readonly { id: string; constraints: Constraints }[], now = new Date()) {
  const shares = equalShares(offer.totalCents, members.map(member => member.id));
  const checks = Object.fromEntries(members.map(member => [member.id, checkMember(offer, member.constraints, shares[member.id]!, members.length, now)])) as Record<string, Check[]>;
  return { shares, checks, feasible: members.length > 0 && Object.values(checks).every(items => items.every(item => item.status === "PASS")) };
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
