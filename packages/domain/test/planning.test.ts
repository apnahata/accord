import test from "node:test";
import assert from "node:assert/strict";
import { checkMember, dateWindows, demoCatalog, isHome, mentions, nearMisses, planningSpan, preferredNights, rankDestinations, regionFor, TripPlanSchema } from "../src/index.js";

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
  assert.deepEqual(result.near, [{ checkIn: "2027-03-08", checkOut: "2027-03-10", memberId: "c" }], "the ask is the smallest stretch, not the earliest date");
});

test("a date nudge asks for the fewest extra days", () => {
  const plan = { earliest: "2026-11-01", latest: "2026-11-22", nights: 3 };
  const members = [
    { id: "alex", constraints: { availability: [{ from: "2026-11-06", to: "2026-11-15" }] } },
    { id: "mateo", constraints: { availability: [{ from: "2026-11-01", to: "2026-11-13" }] } },
    { id: "priya", constraints: { availability: [{ from: "2026-11-11", to: "2026-11-20" }] } },
    { id: "jordan", constraints: {} },
  ];
  // Priya leaving a day early or Mateo staying a day longer would each unblock the trip.
  assert.deepEqual(dateWindows(plan, members).near, [
    { checkIn: "2026-11-10", checkOut: "2026-11-13", memberId: "priya" },
    { checkIn: "2026-11-11", checkOut: "2026-11-14", memberId: "mateo" },
  ]);
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

test("the host sets nothing about when or where; the group's answers decide", () => {
  assert.deepEqual(TripPlanSchema.parse({}), { countryCode: "US" });
  assert.equal(TripPlanSchema.safeParse({ earliest: "2027-03-01", latest: "2027-03-31", nights: 3 }).success, false);

  const free = (from: string, to: string, nights?: number) => ({ constraints: { availability: [{ from, to }], ...(nights ? { nights } : {}) } });
  assert.deepEqual(planningSpan([free("2027-03-05", "2027-03-12"), free("2027-03-08", "2027-03-20")], "2027-01-10"), { earliest: "2027-03-05", latest: "2027-03-20" });
  assert.deepEqual(planningSpan([free("2027-01-01", "2027-01-20")], "2027-01-10"), { earliest: "2027-01-11", latest: "2027-01-20" }, "nothing before tomorrow");
  assert.equal(planningSpan([free("2027-01-01", "2027-01-20")], "2027-02-01"), undefined, "dates that have passed can't be planned");
  assert.equal(planningSpan([free("2027-06-01", "2027-12-31")], "2027-01-10")!.latest, "2027-07-09", "nothing past six months");

  assert.equal(preferredNights([free("a", "b", 4), free("a", "b", 2), free("a", "b", 4), free("a", "b")]), 4);
  assert.equal(preferredNights([free("a", "b", 5), free("a", "b", 2)]), 2, "a tie goes to the shorter trip");
  assert.equal(preferredNights([free("a", "b")]), 3);

  assert.equal(regionFor(["Seattle", "Los Angeles, California"]), "WEST");
  assert.equal(regionFor(["New York", "Boston"]), "EAST", "unrecognized places don't count against the ones Accord knows");
  assert.equal(regionFor(["New York", "California"]), "ANY", "a spread-out group looks everywhere");
  assert.equal(regionFor(["LA"]), "ANY", "a state code isn't a place someone lives");
  assert.equal(regionFor([]), "ANY");
  assert.equal(regionFor(["LA", "New York", "Midwest"]), "ANY", "a named region that disagrees with a recognized city is a real disagreement, not silence");
  assert.equal(regionFor(["New York", "Midwest"]), "ANY", "New York and the Midwest are not the same region");
  assert.equal(regionFor(["Midwest", "the midwest"]), "CENTRAL");

  const fromNewYork = rankDestinations({ region: "EAST", styleCounts: { CITY: 2, LAKE: 1 }, ideas: [], avoid: [], from: ["New York"], months: [7] }).map(pick => pick.name);
  assert.ok(!fromNewYork.includes("New York, NY"), "a group isn't sent to where someone lives");
  assert.ok(fromNewYork.includes("Lake George, NY"), "the rest of the state is still fair game");
  assert.equal(isHome("Washington, DC", "Washington, DC"), true);
  assert.equal(isHome("Washington, DC", "Seattle, WA"), false);
});
