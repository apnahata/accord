import { cyberSourceFromEnv } from "../packages/server/src/payments.ts";

const gateway = cyberSourceFromEnv(process.env);
if (!gateway) {
  const required = ["CYBERSOURCE_MERCHANT_ID", "CYBERSOURCE_KEY_ID", "CYBERSOURCE_SECRET_KEY", "CYBERSOURCE_TEST_CARD_NUMBER", "CYBERSOURCE_TEST_CARD_EXPIRY_MONTH", "CYBERSOURCE_TEST_CARD_EXPIRY_YEAR"];
  const missing = required.filter(key => !process.env[key]);
  process.stderr.write(`CyberSource sandbox is not configured. Missing: ${missing.join(", ")}\n`);
  process.exit(1);
}

const suffix = crypto.randomUUID().slice(0, 12);
const amountCents = Number.parseInt(process.env.CYBERSOURCE_VERIFY_AMOUNT_CENTS ?? "100", 10);
if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100_000) {
  process.stderr.write("CYBERSOURCE_VERIFY_AMOUNT_CENTS must be an integer from 1 through 100000.\n");
  process.exit(1);
}
const amount = `$${(amountCents / 100).toFixed(2)}`;
let authorization;
try {
  authorization = await gateway.authorize({ amountCents, currency: "USD", reference: `accord-verify-${suffix}`, firstName: "Accord", lastName: "Sandbox" });
  process.stdout.write(`CyberSource ${amount} authorization succeeded: ${authorization.id} (${authorization.status})\n`);
  const reversal = await gateway.reverse(authorization.id, { amountCents, reference: `accord-verify-${suffix}-reverse` });
  process.stdout.write(`CyberSource ${amount} reversal succeeded: ${reversal.id} (${reversal.status})\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "CYBERSOURCE_VERIFICATION_FAILED"}\n`);
  if (authorization) process.stderr.write(`Authorization ${authorization.id} may require manual review in CyberSource Business Center.\n`);
  process.exit(1);
}
