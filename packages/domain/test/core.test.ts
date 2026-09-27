import test from "node:test";
import assert from "node:assert/strict";
import { assessOffer, demoCatalog, equalShares, proposalHash, checkMember, nearMisses } from "../src/index.js";

test("near misses name only a sole blocker, never renegotiate accessibility, and cap how far a budget is stretched", () => {
  const [miami, tampa] = demoCatalog();
  const open = { requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "" };
  const others = [{ id: "b", constraints: { ...open, maxContributionCents: 90000 } }, { id: "c", constraints: { ...open, maxContributionCents: 90000 } }, { id: "d", constraints: { ...open, maxContributionCents: 90000 } }];
  assert.deepEqual(nearMisses([miami!, tampa!], [{ id: "a", constraints: { ...open, maxContributionCents: 27000 } }, ...others]),
    [{ memberId: "a", offerId: "tampa-river-court", offerVersion: "v1", check: "BUDGET", shareCents: 28000, gapCents: 1000 }]);
  assert.deepEqual(nearMisses([tampa!], [{ id: "a", constraints: { ...open, maxContributionCents: 20000 } }, ...others]), []);
  assert.deepEqual(nearMisses([{ ...tampa!, stepFreeVerified: false }], [{ id: "a", constraints: { ...open, maxContributionCents: 90000, requiresStepFreeAccess: true } }, ...others]), []);
  assert.deepEqual(nearMisses([tampa!], [{ id: "a", constraints: { ...open, maxContributionCents: 27000 } }, { id: "b", constraints: { ...open, maxContributionCents: 27000 } }, ...others.slice(1)]), []);
});

test("equal shares preserve cents and canonical member order", () => {
  assert.deepEqual(equalShares(120001, ["d", "b", "a", "c"]), { a: 30001, b: 30000, c: 30000, d: 30000 });
  assert.equal(Object.values(equalShares(120001, ["d", "b", "a", "c"])).reduce((a, b) => a + b, 0), 120001);
});

test("canonical hashes change with offer version and ignore object key order", () => {
  assert.equal(proposalHash({ b: 2, a: 1 }), proposalHash({ a: 1, b: 2 }));
  assert.notEqual(proposalHash({ offerVersion: "v4" }), proposalHash({ offerVersion: "v5" }));
});

test("hard checks keep private budget, refund and unknown accessibility authoritative", () => {
  const [miami, , , , credit, unknown] = demoCatalog();
  const alex = { maxContributionCents: 35000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "price" };
  const jordan = { maxContributionCents: 45000, requiresFullCashRefund: true, requiresStepFreeAccess: false, softPreference: "activities" };
  const mateo = { maxContributionCents: 45000, requiresFullCashRefund: false, requiresStepFreeAccess: true, softPreference: "quiet" };
  assert.equal(checkMember(miami!, alex, 30000, 4).every(c => c.status === "PASS"), true);
  assert.equal(checkMember({ ...miami!, subtotalCents: 134000, totalCents: 144000 }, alex, 36000, 4).find(c => c.kind === "BUDGET")!.status, "FAIL");
  assert.equal(checkMember(credit!, jordan, 29000, 4).find(c => c.kind === "REFUND")!.status, "FAIL");
  assert.equal(checkMember(unknown!, mateo, 27250, 4).find(c => c.kind === "STEP_FREE")!.status, "UNKNOWN");
  const result = assessOffer(miami!, [{ id: "alex", constraints: alex }, { id: "jordan", constraints: jordan }, { id: "mateo", constraints: mateo }, { id: "priya", constraints: { ...jordan, requiresFullCashRefund: false } }]);
  assert.equal(result.feasible, true);
  assert.deepEqual(Object.values(result.shares), [30000, 30000, 30000, 30000]);
});

test("check-in windows are enforced as hard constraints", () => {
  const [offer] = demoCatalog();
  const base = { maxContributionCents: 100000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "" };
  const tooEarly = checkMember(offer!, { ...base, earliestCheckInAt: "2027-03-10T22:00:00.000Z" }, 30000, 4);
  const tooLate = checkMember(offer!, { ...base, latestCheckInAt: "2027-03-10T20:00:00.000Z" }, 30000, 4);
  const inWindow = checkMember(offer!, { ...base, earliestCheckInAt: "2027-03-10T20:00:00.000Z", latestCheckInAt: "2027-03-10T22:00:00.000Z" }, 30000, 4);
  assert.equal(tooEarly.find(check => check.kind === "CHECKIN_EARLIEST")!.status, "FAIL");
  assert.equal(tooLate.find(check => check.kind === "CHECKIN_LATEST")!.status, "FAIL");
  assert.equal(inWindow.find(check => check.kind === "CHECKIN_EARLIEST")!.status, "PASS");
  assert.equal(inWindow.find(check => check.kind === "CHECKIN_LATEST")!.status, "PASS");
});

test("date-only availability never invents a hotel time", () => {
  const [offer] = demoCatalog();
  const base = { maxContributionCents: 100000, requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "" };
  const dateOnly = checkMember({ ...offer!, checkInTimeKnown: false, checkOutTimeKnown: false }, {
    ...base, earliestCheckInDate: "2027-03-10", latestCheckOutDate: "2027-03-14",
  }, 30000, 4);
  assert.equal(dateOnly.find(check => check.kind === "CHECKIN_DATE_EARLIEST")!.status, "PASS");
  assert.equal(dateOnly.find(check => check.kind === "CHECKOUT_DATE")!.status, "PASS");
  assert.equal(dateOnly.find(check => check.kind === "CHECKIN_EARLIEST")!.status, "PASS", "no time preference means an unknown hotel time is acceptable");
  const explicitTime = checkMember({ ...offer!, checkInTimeKnown: false }, { ...base, earliestCheckInAt: "2027-03-10T20:00:00.000Z" }, 30000, 4);
  assert.equal(explicitTime.find(check => check.kind === "CHECKIN_EARLIEST")!.status, "UNKNOWN", "an explicit time cannot pass without provider evidence");
});
