import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelCheckout } from "../src/model-time.js";

test("model checkout uses the correct Eastern daylight-saving offset", () => {
  assert.equal(normalizeModelCheckout("2027-03-14T12:00:00-05:00"), "2027-03-14T16:00:00.000Z");
  assert.equal(normalizeModelCheckout("2027-03-14T12:00:00-04:00"), "2027-03-14T16:00:00.000Z");
  assert.throws(() => normalizeModelCheckout("2027-03-14T17:00:00.000Z"), /MODEL_CHECKOUT_MUST_BE_LOCAL/);
});

test("nonexistent Eastern wall times fail closed", () => {
  assert.throws(() => normalizeModelCheckout("2027-03-14T02:30:00-05:00"), /INVALID_MODEL_CHECKOUT_TIME/);
});
