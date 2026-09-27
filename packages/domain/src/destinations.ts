import type { Region, TripStyle } from "./schemas.js";

export type Destination = {
  name: string; state: string; styles: TripStyle[]; timeZone: string;
  region: Exclude<Region, "ANY">;
  /** Relative stay prices; 1 is a typical mid-priced US destination. */
  priceIndex: number;
  /** Months (1-12) a style is actually on offer; styles not listed work year-round. */
  seasons?: Partial<Record<TripStyle, number[]>>;
};

const d = (name: string, state: string, styles: TripStyle[], timeZone: string, region: Destination["region"], priceIndex: number, seasons?: Destination["seasons"]): Destination =>
  ({ name, state, styles, timeZone, region, priceIndex, ...(seasons ? { seasons } : {}) });
const ET = "America/New_York", CT = "America/Chicago", MT = "America/Denver", PT = "America/Los_Angeles";
const SKI = [12, 1, 2, 3], WARM = [5, 6, 7, 8, 9, 10], SUMMER = [6, 7, 8, 9];

/** The destination's styles that are in season for any of these months. */
export function stylesInSeason(destination: Destination, months: readonly number[]) {
  return destination.styles.filter(style => !destination.seasons?.[style] || !months.length || months.some(month => destination.seasons![style]!.includes(month)));
}

/** Accord's own shortlist of well-known US trips. Used when no model is connected and for rehearsal stays. */
export const DESTINATIONS: readonly Destination[] = [
  d("Miami, FL", "Florida", ["BEACH", "CITY"], ET, "EAST", 1.3),
  d("Tampa, FL", "Florida", ["BEACH", "CITY"], ET, "EAST", 1),
  d("St. Petersburg, FL", "Florida", ["BEACH"], ET, "EAST", 0.95),
  d("Orlando, FL", "Florida", ["THEME_PARKS", "CITY"], ET, "EAST", 0.9),
  d("Myrtle Beach, SC", "South Carolina", ["BEACH"], ET, "EAST", 0.75, { BEACH: WARM }),
  d("Charleston, SC", "South Carolina", ["CITY", "BEACH"], ET, "EAST", 1.15, { BEACH: [4, ...WARM] }),
  d("Savannah, GA", "Georgia", ["CITY"], ET, "EAST", 0.95),
  d("Outer Banks, NC", "North Carolina", ["BEACH", "NATURE"], ET, "EAST", 1, { BEACH: WARM }),
  d("Asheville, NC", "North Carolina", ["MOUNTAINS", "NATURE", "CITY"], ET, "EAST", 0.9),
  d("Gatlinburg, TN", "Tennessee", ["MOUNTAINS", "NATURE"], ET, "EAST", 0.8),
  d("Stowe, VT", "Vermont", ["SKI", "MOUNTAINS"], ET, "EAST", 1.2, { SKI }),
  d("Killington, VT", "Vermont", ["SKI", "MOUNTAINS"], ET, "EAST", 1.1, { SKI }),
  d("Lake George, NY", "New York", ["LAKE", "NATURE"], ET, "EAST", 0.85, { LAKE: SUMMER }),
  d("Bar Harbor, ME", "Maine", ["NATURE", "BEACH"], ET, "EAST", 1, { BEACH: SUMMER }),
  d("New York, NY", "New York", ["CITY"], ET, "EAST", 1.5),
  d("Washington, DC", "District of Columbia", ["CITY"], ET, "EAST", 1.2),
  d("Nashville, TN", "Tennessee", ["CITY"], CT, "CENTRAL", 1.05),
  d("New Orleans, LA", "Louisiana", ["CITY"], CT, "CENTRAL", 1),
  d("Austin, TX", "Texas", ["CITY", "LAKE"], CT, "CENTRAL", 1),
  d("Breckenridge, CO", "Colorado", ["SKI", "MOUNTAINS"], MT, "WEST", 1.35, { SKI: [11, ...SKI, 4] }),
  d("Park City, UT", "Utah", ["SKI", "MOUNTAINS"], MT, "WEST", 1.4, { SKI: [...SKI, 4] }),
  d("Sedona, AZ", "Arizona", ["NATURE"], "America/Phoenix", "WEST", 1.1),
  d("San Diego, CA", "California", ["BEACH", "CITY"], PT, "WEST", 1.3),
  d("Lake Tahoe, CA", "California", ["SKI", "LAKE", "MOUNTAINS"], PT, "WEST", 1.3, { SKI: [...SKI, 4], LAKE: SUMMER }),
];

const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const phrase = (text: string, needle: string) => ` ${words(text).join(" ")} `.includes(` ${words(needle).join(" ")} `);

/** Whether free text such as "anywhere but Florida" or "not Miami" names this destination. */
export function mentions(text: string | undefined, destination: string) {
  if (!text?.trim()) return false;
  const [city = "", abbreviation = ""] = destination.split(",").map(part => part.trim());
  const known = DESTINATIONS.find(item => item.name.toLowerCase() === destination.toLowerCase());
  return phrase(text, city) || (abbreviation.length === 2 && new RegExp(`\\b${abbreviation}\\b`).test(text)) || (!!known && phrase(text, known.state));
}

/** Whether someone is leaving from this destination's city, so going there isn't a trip for them. */
export function isHome(departure: string, destination: string) {
  return phrase(departure, destination.split(",")[0]!.trim());
}

/**
 * The part of the country everyone is leaving from, when every departure Accord recognizes agrees.
 * Anything mixed or unrecognized looks everywhere.
 */
export function regionFor(departures: readonly string[]): Region {
  // Full city and state names only: "leaving from LA" means Los Angeles, not Louisiana.
  const regions = new Set(departures.flatMap(text => DESTINATIONS
    .filter(item => phrase(text, item.name.split(",")[0]!) || phrase(text, item.state)).map(item => item.region)));
  return regions.size === 1 ? [...regions][0]! : "ANY";
}

/**
 * Accord's own ranking of catalog destinations for a group's anonymous answers. Deterministic.
 * Each pick after the first is discounted for sharing a style with earlier picks, so a minority wish
 * (one skier among beach lovers) still reaches the shortlist.
 */
export function rankDestinations(input: { region: Region; styleCounts: Partial<Record<TripStyle, number>>; ideas: string[]; avoid: string[]; from?: string[]; months?: number[] }, limit = 3) {
  const pool = DESTINATIONS
    .filter(item => input.region === "ANY" || item.region === input.region)
    .filter(item => !input.avoid.some(text => mentions(text, item.name)))
    .filter(item => !input.from?.some(text => isHome(text, item.name)))
    .map(item => ({ item: { ...item, styles: stylesInSeason(item, input.months ?? []) } }))
    .map(({ item }) => ({ item, fit: item.styles.reduce((sum, style) => sum + (input.styleCounts[style] ?? 0), 0) + 2 * input.ideas.filter(text => mentions(text, item.name)).length }));
  const anyWishes = pool.some(entry => entry.fit > 0);
  const picked: Destination[] = [];
  while (picked.length < limit) {
    const scored = pool.filter(entry => !picked.includes(entry.item) && (!anyWishes || entry.fit > 0))
      .map(entry => ({ ...entry, adjusted: entry.fit
        - 1.5 * picked.filter(other => other.styles.some(style => entry.item.styles.includes(style))).length
        - 3 * picked.filter(other => other.state === entry.item.state).length }))
      .sort((a, b) => b.adjusted - a.adjusted || a.item.priceIndex - b.item.priceIndex || a.item.name.localeCompare(b.item.name));
    if (!scored.length) break;
    picked.push(scored[0]!.item);
  }
  return picked;
}
