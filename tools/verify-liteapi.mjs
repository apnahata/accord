import { LiteApi } from "../packages/server/src/stays.ts";

const key = process.env.LITEAPI_KEY;
if (!key) {
  process.stderr.write("LITEAPI_KEY is missing. Copy the sandbox key from Nuitee Connect → Developer → API Keys → Sandbox.\n");
  process.exit(1);
}
if (!key.startsWith("sand_")) {
  process.stderr.write("LITEAPI_KEY is not a sandbox key (expected a sand_... prefix). Refusing to run the sandbox verifier.\n");
  process.exit(1);
}

const day = milliseconds => new Date(Date.now() + milliseconds).toISOString().slice(0, 10);
const trip = {
  destination: process.env.LITEAPI_VERIFY_DESTINATION ?? "Miami, FL",
  countryCode: "US",
  checkIn: process.env.LITEAPI_VERIFY_CHECK_IN ?? day(45 * 86_400_000),
  checkOut: process.env.LITEAPI_VERIFY_CHECK_OUT ?? day(49 * 86_400_000),
  guests: Number.parseInt(process.env.LITEAPI_VERIFY_GUESTS ?? "4", 10),
  timeZone: "America/New_York",
};

try {
  const stays = await new LiteApi(key).search(trip);
  process.stdout.write(`${JSON.stringify({
    provider: "Nuitee Connect liteAPI",
    environment: "SANDBOX",
    authenticated: true,
    trip,
    resultCount: stays.length,
    sample: stays.slice(0, 3).map(({ offer }) => ({ propertyName: offer.propertyName, totalCents: offer.totalCents, refundable: offer.cancellationPolicyCode === "FULL_CASH_REFUND" })),
  }, null, 2)}\n`);
  if (!stays.length) process.stderr.write("Authentication succeeded, but this search returned no bookable rates. Try different future dates or a nearby city.\n");
} catch (error) {
  process.stderr.write(`LITEAPI_VERIFICATION_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
