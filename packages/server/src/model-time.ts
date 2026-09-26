/** Interpret an AI-proposed wall clock time against the stay's Eastern planning timezone. */
const eastern = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function easternWall(instant: Date) {
  const parts = Object.fromEntries(eastern.formatToParts(instant).map(part => [part.type, part.value]));
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].join("");
}

export function normalizeModelCheckout(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("INVALID_MODEL_CHECKOUT_TIME");
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("INVALID_MODEL_CHECKOUT_TIME");
  // A model-supplied UTC instant cannot be checked against the wall time the
  // member actually said. Require a local clock value and normalize it here.
  if (match[8] === "Z") throw new Error("MODEL_CHECKOUT_MUST_BE_LOCAL");
  const targetWall = match.slice(1, 7).join("");
  if (easternWall(instant) === targetWall) return instant.toISOString();

  // Models sometimes encode noon EDT as 12:00-05:00. Preserve the proposed
  // wall time, derive the correct Eastern instant, and reject nonexistent times.
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const fraction = Number((match[7] ?? "").padEnd(3, "0"));
  const desiredWallMs = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, fraction);
  const localParts = eastern.formatToParts(instant);
  const local = Object.fromEntries(localParts.map(part => [part.type, Number(part.value)]));
  const actualWallMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, instant.getUTCMilliseconds());
  const corrected = new Date(instant.getTime() + desiredWallMs - actualWallMs);
  if (easternWall(corrected) !== targetWall) throw new Error("INVALID_MODEL_CHECKOUT_TIME");
  return corrected.toISOString();
}
