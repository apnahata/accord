import test from "node:test";
import assert from "node:assert/strict";
import { assessOffer, demoCatalog, equalShares, proposalHash, checkMember } from "../src/index.js";

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
