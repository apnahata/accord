import test from "node:test";
import assert from "node:assert/strict";
import { checkMember, dateWindows, demoCatalog, mentions, nearMisses, rankDestinations, TripPlanSchema } from "../src/index.js";

const open = { requiresFullCashRefund: false, requiresStepFreeAccess: false, softPreference: "", maxContributionCents: 90000 };

test("date windows are the trip-length stretches everyone can make, earliest first and non-overlapping", () => {
  const plan = { earliest: "2027-03-01", latest: "2027-03-31", nights: 3 };
  const members = [
    { id: "a", constraints: { availability: [{ from: "2027-03-05", to: "2027-03-20" }] } },
    { id: "b", constraints: { availability: [{ from: "2027-03-01", to: "2027-03-12" }, { from: "2027-03-15", to: "2027-03-31" }] } },
    { id: "c", constraints: {} },
  ];
  const result = dateWindows(plan, members);
  assert.deepEqual(result.windows, [{ checkIn: "2027-03-05", checkOut: "2027-03-08" }, { checkIn: "2027-03-08", checkOut: "2027-03-11" }]);
  // Mar 5-12 has 5 start days, Mar 15-20 has 3.
  assert.equal(result.sharedCount, 8);
  assert.deepEqual(result.near.map(window => window.memberId).sort(), ["a", "b"]);
});

test("with no shared dates, each near window names the single member who would need to adjust", () => {
  const plan = { earliest: "2027-03-01", latest: "2027-03-31", nights: 2 };
  const members = [
    { id: "a", constraints: { availability: [{ from: "2027-03-01", to: "2027-03-10" }] } },
    { id: "b", constraints: { availability: [{ from: "2027-03-01", to: "2027-03-10" }] } },
    { id: "c", constraints: { availability: [{ from: "2027-03-20", to: "2027-03-31" }] } },
  ];
  const result = dateWindows(plan, members);
  assert.deepEqual(result.windows, []);
  assert.deepEqual(result.near, [{ checkIn: "2027-03-01", checkOut: "2027-03-03", memberId: "c" }]);
});

test("the DATES check only appears for members who gave dates, and dates are negotiable near misses", () => {
  const [, tampa] = demoCatalog();
  assert.equal(checkMember(tampa!, open, 28000, 4).some(check => check.kind === "DATES"), false);
  const fits = checkMember(tampa!, { ...open, availability: [{ from: "2027-03-09", to: "2027-03-15" }] }, 28000, 4);
  assert.equal(fits.find(check => check.kind === "DATES")!.status, "PASS");
  const misses = checkMember(tampa!, { ...open, availability: [{ from: "2027-03-11", to: "2027-03-15" }] }, 28000, 4);
  assert.equal(misses.find(check => check.kind === "DATES")!.status, "FAIL");
  const others = ["b", "c", "d"].map(id => ({ id, constraints: open }));
  assert.deepEqual(nearMisses([tampa!], [{ id: "a", constraints: { ...open, availability: [{ from: "2027-03-11", to: "2027-03-15" }] } }, ...others]).map(miss => miss.check), ["DATES"]);
});

test("Accord's own destination picks follow the group's styles, skip ruled-out places, and leave room for a minority wish", () => {
  const picks = rankDestinations({ region: "ANY", styleCounts: { BEACH: 3, CITY: 1, SKI: 1 }, ideas: [], avoid: ["anywhere in Florida please"] });
  assert.equal(picks.length, 3);
  assert.ok(picks.every(pick => !pick.name.endsWith(", FL")));
  assert.ok(picks.some(pick => pick.styles.includes("BEACH")));
  assert.ok(picks.some(pick => pick.styles.includes("SKI")), "the one skier still gets an option");
  const east = rankDestinations({ region: "EAST", styleCounts: { MOUNTAINS: 2 }, ideas: ["Asheville maybe?"], avoid: [] });
  assert.equal(east[0]!.name, "Asheville, NC");
  assert.ok(east.every(pick => pick.region === "EAST"));
  const november = rankDestinations({ region: "ANY", styleCounts: { SKI: 2, CITY: 1 }, ideas: [], avoid: [], months: [11] });
  assert.ok(november.every(pick => !pick.styles.includes("SKI") || pick.name === "Breckenridge, CO"), "no ski pitch before the season opens");
  assert.equal(november[0]!.name, "Breckenridge, CO");
  const states = rankDestinations({ region: "ANY", styleCounts: { SKI: 2, BEACH: 1, CITY: 1 }, ideas: [], avoid: [], months: [11] }).map(pick => pick.state);
  assert.equal(new Set(states).size, states.length, "the shortlist spreads across states");
  const march = rankDestinations({ region: "EAST", styleCounts: { SKI: 2 }, ideas: [], avoid: [], months: [3] });
  assert.ok(march[0]!.styles.includes("SKI"));
  assert.equal(mentions("not Miami", "Miami, FL"), true);
  assert.equal(mentions("no FL", "Tampa, FL"), true);
  assert.equal(mentions("somewhere cold", "Tampa, FL"), false);
});

test("a planning window must fit the trip and stay under four months", () => {
  assert.equal(TripPlanSchema.safeParse({ earliest: "2027-03-01", latest: "2027-03-03", nights: 3 }).success, false);
  assert.equal(TripPlanSchema.safeParse({ earliest: "2027-03-01", latest: "2027-08-01", nights: 3 }).success, false);
  assert.deepEqual(TripPlanSchema.parse({ earliest: "2027-03-01", latest: "2027-03-31", nights: 3 }), { earliest: "2027-03-01", latest: "2027-03-31", nights: 3, region: "ANY", countryCode: "US" });
});
