# Accord: Visa + Expedia integration plan

## 1. Product truth and target

The immediate target is a fully integrated **remote sandbox** demonstration:

- Hotel inventory, availability, rates, price checks, booking, retrieval, and cancellation come from Expedia Rapid APIs.
- Card tokenization and payment authorization/capture/reversal come from approved Visa services, preferably Visa Intelligent Commerce when HackGT credentials include it, with Visa Acceptance Solutions/Cybersource as the payment-processing path where required.
- Every displayed provider reference is returned by the provider and persisted unchanged.
- No local fixture, random provider reference, or locally fabricated success is permitted in `INTEGRATION_MODE=required`.
- Four users have separate authenticated sessions, payment credentials, wallet ledgers, constraints, approvals, and exact contribution records.
- A booking can execute only after the current Expedia price has been rechecked and all four members have approved and funded the same immutable proposal hash.

This is not a production-money claim. Expedia's `test.ean.com` endpoint creates a test booking, not a live reservation, and Visa/Cybersource sandbox transactions do not move real money. The UI and receipt must say `TEST` or `SANDBOX`. A live booking and real funds require Expedia production approval, a payment processor/acquirer account, PCI compliance, refund/chargeback operations, and a legally reviewed merchant-of-record/travel-seller model.

## 2. Non-negotiable architecture decision

Expedia Rapid does not provide a generic four-card split-payment contract for one lodging reservation. Do not attempt to pass four traveler cards into one booking or imply that four Visa authorizations were remitted directly to Expedia.

Use this sandbox funding model:

1. Each member adds a Visa sandbox payment method through provider-hosted/tokenized fields; raw PAN and CVV never pass through or persist in Accord.
2. Each member funds an Accord **test wallet** through a real Cybersource sandbox sale or authorization/capture call.
3. Accord credits the member's test ledger only after the provider confirms the sandbox transaction.
4. Consent places a ledger hold for the exact share and exact proposal hash.
5. Accord creates one Expedia test booking using the payment arrangement enabled for the Rapid partner profile.
6. After confirmed retrieval, Accord atomically converts all four wallet holds to debits and stores the Expedia itinerary and Visa transaction references together.
7. If booking fails, all holds are released. If a payment operation must be unwound, call the provider reversal/refund endpoint and record the result; never merely change local status.

For production, this model makes Accord responsible for accepting funds and paying the travel supplier. Do not enable it until counsel and providers confirm the merchant-of-record, stored-value, money-transmission, travel-seller, PCI, tax, refund, and chargeback model. If those approvals are unavailable, production must use a single traveler payment instrument accepted by Expedia and treat the other members' contributions as coordination only.

## 3. Current code that must be replaced

The existing implementation is a sound consent prototype but not an integration:

- `packages/domain/src/fixtures.ts` supplies all hotel inventory.
- `packages/server/src/state.ts` seeds `demoCatalog()`, stores users, sessions, proposals, authorizations, and bookings in Maps, and creates `sim_*` payment references.
- `packages/integrations/src/merchant.ts` returns `demo-*` booking references.
- `packages/server/src/memory-merchant.ts` is process-local.
- The receipt states that nothing was charged or reserved.

Keep the deterministic constraint, equal-split, proposal-hash, material-change, privacy, and idempotency rules. Replace their persistence and external side effects.

## 4. Provider access required before coding the final adapters

### Expedia Rapid

Obtain and confirm:

- Approved Rapid partner account.
- API key and shared secret.
- Lodging Content, Geography/Typeahead, Shopping, Price Check, Booking, Retrieve, and Cancel access.
- Partner profile payment model: Expedia Collect, Property Collect, or partner/virtual card.
- Test endpoint access and allowed `test` header scenarios.
- Whether Hold/Resume and 3DS/Register Payment are enabled.
- Production approval remains off.

### Visa

Ask the Visa sponsor for the exact enabled product and credentials. Visa Intelligent Commerce is restricted and must not be assumed available. Confirm:

- VIC agent onboarding, agent-specific token provisioning, passkey/authentication iframe, payment instructions, credential retrieval, and commerce signals.
- Whether the returned credential is contractually and technically accepted by the chosen Expedia Rapid payment path.
- Cybersource/Visa Acceptance sandbox merchant ID, key ID, secret key, processor configuration, Flex Microform/tokenization access, authorization, capture, reversal, void, and refund access.
- Webhook/event authentication mechanism and test cards.

If VIC is unavailable but Cybersource works, describe the integration as Visa Acceptance Solutions sandbox payments, not Visa Intelligent Commerce.

## 5. Configuration and safety rails

Add validated server-only configuration:

```text
INTEGRATION_MODE=required
APP_ENV=development
DATABASE_URL=
DATA_ENCRYPTION_KEY=
SESSION_SECRET=

EXPEDIA_ENV=test
EXPEDIA_BASE_URL=https://test.ean.com
EXPEDIA_API_KEY=
EXPEDIA_SHARED_SECRET=
EXPEDIA_TEST_HEADER=standard
EXPEDIA_RAPID_VERSION=v3

VISA_MODE=vic|cybersource
VISA_ENV=sandbox
VISA_VIC_BASE_URL=
VISA_VIC_CLIENT_ID=
VISA_VIC_CERT_PATH=
VISA_VIC_KEY_PATH=
CYBERSOURCE_HOST=apitest.cybersource.com
CYBERSOURCE_MERCHANT_ID=
CYBERSOURCE_KEY_ID=
CYBERSOURCE_SECRET_KEY=
CYBERSOURCE_FLEX_KEY_ID=
```

Rules:

- Reject startup when `INTEGRATION_MODE=required` and required credentials are missing.
- Reject `EXPEDIA_ENV=production` unless a separate `ALLOW_PRODUCTION_BOOKING=true` is present, the production hostname is allowlisted, and a second server-side operator confirmation is configured.
- Never infer environment from a URL substring alone.
- Never log secrets, PAN, CVV, full token values, Expedia booking links, passkey payloads, or private constraints.
- Never put provider secrets in Vite variables or browser bundles.
- Set request timeouts, bounded retries, and correlation IDs.

## 6. Durable data model

Use MongoDB transactions if the existing project requirement is retained, or PostgreSQL if the team deliberately changes that requirement. Do not continue with process Maps.

Minimum collections/tables:

```text
users
sessions
rooms
room_members
private_constraints
search_requests
provider_offers
offer_snapshots
proposals
proposal_members
approvals
payment_credentials
payment_transactions
wallet_accounts
ledger_entries
wallet_holds
booking_attempts
bookings
provider_webhook_events
outbox_events
idempotency_records
audit_events
```

Wallet accounting must be append-only and double-entry. Never update a `balance` field as the source of truth. Derive:

```text
available = confirmed credits - settled debits - active holds
held = active holds
spent = settled booking debits
```

Every ledger entry records currency, integer cents, member, proposal hash when relevant, provider transaction ID when relevant, idempotency key, and timestamp. Enforce that every transaction's debits equal credits.

## 7. Domain contract changes

Replace fixed demo concepts with provider-neutral schemas:

```ts
type SearchRequest = {
  destination: { query: string; regionId?: string };
  checkInDate: string;
  checkOutDate: string;
  rooms: Array<{ adults: number; childAges?: number[] }>;
  currency: "USD";
  countryCode: string;
  language: string;
};

type ProviderOfferSnapshot = {
  provider: "EXPEDIA_RAPID";
  environment: "TEST" | "PRODUCTION";
  propertyId: string;
  roomId: string;
  rateId: string;
  providerBookingLinkEncrypted: string;
  providerPriceCheckLinkEncrypted: string;
  checkInDate: string;
  checkOutDate: string;
  occupancy: unknown;
  price: { baseCents: number; taxAndFeeCents: number; totalCents: number; currency: string };
  cancellation: { refundable: boolean; penalties: unknown; fullCashRefundDeadline?: string };
  evidence: {
    guestCapacity: { value?: number; source: string; status: "VERIFIED" | "UNKNOWN" };
    stepFree: { value?: boolean; source: string; status: "VERIFIED" | "UNKNOWN" };
  };
  providerPayloadHash: string;
  retrievedAt: string;
  expiresAt: string;
};
```

Provider links are opaque and must be followed exactly as returned. Encrypt them at rest. Do not reconstruct them.

Do not infer `stepFreeVerified=true` from a photograph, generic accessibility label, or LLM. Map only a documented Expedia field/amenity with sufficient meaning; otherwise preserve `UNKNOWN`, which must fail a hard step-free constraint.

## 8. Expedia Rapid adapter

Create `packages/integrations/src/expedia/` with:

```text
config.ts
auth.ts
client.ts
content.ts
geography.ts
shopping.ts
price-check.ts
booking.ts
manage-booking.ts
schemas.ts
normalizer.ts
errors.ts
```

Implementation requirements:

1. Generate the required `EAN APIKey=...,Signature=...,timestamp=...` authorization header server-side using the API key, shared secret, current Unix timestamp, and SHA-512.
2. Resolve destination text to a Rapid region/property universe; never use hardcoded Miami/Tampa property IDs.
3. Refresh Content API property data on the provider-recommended cadence and record source timestamps.
4. Shop using user-selected dates, occupancy, currency, country, and language.
5. Validate every response with Zod before normalization.
6. Keep Expedia's tokenized links opaque.
7. Normalize total price and mandatory fees without floating-point money.
8. Preserve cancellation penalties and payment timing exactly.
9. Call Price Check before opening final consent. If price/terms change, create a new immutable proposal and require fresh approval.
10. Call Price Check again immediately before booking. Any material change stales the proposal.
11. Create a booking with traveler and payment data only after the execution gate passes.
12. On timeout or ambiguous response, retrieve using the same `affiliate_reference_id` before retrying. Never create a second booking merely because the first response was lost.
13. Store itinerary ID, affiliate reference, confirmation number, retrieve/cancel links, property/dates/guests, totals, policies, environment, raw-response hash, and timestamps.
14. Implement Retrieve and Cancel. A cancellation is complete only when Expedia confirms it.
15. In test mode, always use `https://test.ean.com` and an allowed `test` header. Never silently fall through to a live endpoint.

## 9. Visa payment adapter and wallet

Create provider-neutral ports:

```ts
interface PaymentProvider {
  tokenizeOrProvision(input: ProvisionInput): Promise<ProvisionedCredential>;
  createInstruction?(input: ExactPurchaseInstruction): Promise<Instruction>;
  authenticateInstruction?(input: AuthenticationInput): Promise<AuthenticatedInstruction>;
  authorize(input: AuthorizationInput): Promise<AuthorizationResult>;
  capture(input: CaptureInput): Promise<CaptureResult>;
  reverse(input: ReversalInput): Promise<ReversalResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  retrieve(transactionId: string): Promise<PaymentStatus>;
}
```

### Cybersource path

- Use Flex Microform or another provider-hosted/tokenized collection experience so Accord never handles raw PAN/CVV.
- Use the official REST authentication scheme/library.
- Send deterministic merchant reference codes and idempotency metadata.
- Persist provider IDs, status, amount, currency, response code, reconciliation ID, and sanitized card metadata only.
- Confirm ambiguous outcomes through retrieval/webhooks before retrying.
- Call actual sandbox reversal/void/refund endpoints for unwinds.

### Visa Intelligent Commerce path

When and only when access is granted:

- Provision an agent-specific token for each member.
- Perform required cardholder step-up and passkey setup.
- Create an exact instruction bound to member, merchant, currency, maximum amount, proposal hash, and expiry.
- Require passkey authentication of that instruction.
- Retrieve credentials only after the execution gate and only for the authorized merchant/amount.
- Submit commerce outcome signals after Expedia/payment results.
- Persist Visa instruction, authentication, credential-request, and signal references; never persist clear payment credentials.

## 10. End-to-end state machine

Use persisted, compare-and-swap transitions:

```text
COLLECTING_CONSTRAINTS
SEARCHING_EXPEDIA
OFFERS_READY
PRICE_CHECKING
PROPOSAL_OPEN
FUNDING_IN_PROGRESS
FUNDED
FINAL_PRICE_CHECK
BOOKING_SUBMITTED
BOOKING_UNKNOWN | BOOKING_CONFIRMED | BOOKING_FAILED
WALLETS_SETTLING
COMPLETED | COMPENSATION_REQUIRED | CANCELLED
```

Execution saga:

1. Confirm four private constraints.
2. Search Expedia and deterministically evaluate normalized offers.
3. Price-check the selected rate.
4. Build and hash an immutable proposal from the exact provider snapshot and contribution allocation.
5. Each member approves, authenticates where required, and obtains an exact wallet hold.
6. Re-read all provider/payment statuses from durable storage.
7. Price-check again.
8. If changed, release holds and stale the proposal.
9. Create the Expedia booking once using a stable `affiliate_reference_id` and idempotency record.
10. Retrieve until the itinerary is confirmed or a bounded unknown state is reached.
11. On confirmation, settle all four ledger holds to booking debits in one database transaction.
12. Store the provider receipt and display a TEST/SANDBOX badge.
13. On failure, release holds and call required payment reversals.
14. On partial wallet settlement failure after booking, stop, mark `COMPENSATION_REQUIRED`, attempt Expedia cancellation, and reconcile every provider transaction. Never display success.

Only one worker may execute a proposal. Use a database uniqueness constraint on proposal ID and provider affiliate reference, not an in-memory lock.

## 11. API changes

Add authenticated routes resembling:

```text
POST /api/rooms/:roomId/searches
GET  /api/rooms/:roomId/searches/:searchId
POST /api/rooms/:roomId/offers/:offerId/price-check
POST /api/proposals/:proposalId/me/approve

POST /api/me/payment-credentials/setup
POST /api/me/payment-credentials/complete
GET  /api/me/wallet
POST /api/me/wallet/fund
GET  /api/me/wallet/transactions

POST /api/proposals/:proposalId/me/hold
POST /api/proposals/:proposalId/execute
GET  /api/bookings/:bookingId
POST /api/bookings/:bookingId/cancel

POST /api/webhooks/cybersource
POST /api/webhooks/expedia
```

Private routes derive member identity only from the secure session. The client never supplies an authoritative member ID.

Separate approval from funding. A single UI button may orchestrate both, but they are separate durable records.

## 12. Frontend changes

- Add destination, dates, room occupancy, and guest information; remove the canonical fixed trip from the normal flow.
- Add a per-user Wallet screen with environment badge, masked credential metadata, available/held/spent test balances, and provider-backed transaction history.
- Add provider state to every offer: `Expedia Rapid · TEST`.
- Display the exact Expedia cancellation policy, payment timing, taxes, mandatory fees, and price-check time.
- Add a passkey/authentication step when VIC or 3DS requires it.
- Show individual approval and funding progress without revealing private limits or payment metadata.
- Make `BOOKING_UNKNOWN` an honest pending screen, not an error that encourages retrying.
- Receipt shows Expedia itinerary/confirmation references, Visa/Cybersource transaction references for the signed-in member, proposal hash, environment, cancellation link/status, and `No real funds/reservation` wording in sandbox.
- Remove merchant mutation controls from the consumer flow. Provider price-check changes become the real stale-consent trigger.

## 13. Testing and evidence

Tests must not fabricate integration success inside provider adapters.

- Unit tests: money, equal split, proposal hashing, material diff, Expedia normalization, ledger invariants, webhook signature validation.
- Contract tests: sanitized recorded provider payloads, clearly marked as fixtures, for schema compatibility only.
- Live sandbox tests: opt-in and skipped without credentials; call Expedia/Cybersource sandboxes and persist provider IDs.
- End-to-end test: four separate cookie jars, four wallet funding operations, Expedia search/price check, four approvals/holds, booking, retrieval, settlement, receipt, cancellation/refund where supported.
- Failure tests: price mismatch, room unavailable, payment decline, 3DS challenge/failure, Expedia 500/503, network timeout with successful retrieve, duplicate execute, cancellation failure, refund pending.
- Evidence artifact: timestamp, environment, request correlation ID, sanitized request/response hashes, provider IDs, and screenshots. Never commit secrets or card data.

Definition of done:

- Changing destination/dates changes Expedia API requests and results.
- No `demoCatalog`, `sim_`, or `demo-` reference appears in the integration runtime path.
- Missing provider credentials cause a visible unavailable/fail-closed state.
- All four users have distinct durable wallets and ledgers.
- The sum of wallet debits exactly equals the booked total.
- Stale Expedia price or terms invalidate every approval/hold.
- Repeated execute requests produce one Expedia itinerary.
- A provider timeout cannot create an untracked duplicate.
- The receipt can be reloaded after server restart.
- Sandbox UI never claims a live reservation or real-money movement.

## 14. Recommended delivery order

1. Credential spike: prove one authenticated Expedia test call and one Cybersource/Visa sandbox call in standalone scripts; save only sanitized evidence.
2. Durable Mongo/session repositories and migrations/indexes.
3. Expedia content/search/price-check integration.
4. Provider-neutral offer schemas and deterministic solver migration.
5. Cybersource tokenization, payment lifecycle, and webhook verification.
6. Append-only wallet ledger and four-user funding/hold UI.
7. Expedia create/retrieve/cancel integration and persisted booking saga.
8. VIC passkey/payment-instruction path if sponsor access is actually granted.
9. Full four-browser sandbox E2E and failure demonstrations.
10. Security review, secret rotation, provider evidence, and demo rehearsal.

Do not start by implementing production booking. First prove the complete sandbox saga and its compensation paths.

---

## Implementation prompt

Use the following prompt for an implementation agent after credentials and partner capabilities are known:

```text
You are the lead engineer implementing real remote sandbox integrations for Accord in this repository.

Read, in full, before editing:
- ACCORD_BRIEF.md
- README.md
- docs/REAL_EXPEDIA_VISA_IMPLEMENTATION_PLAN.md
- packages/domain/src/*
- packages/server/src/*
- packages/integrations/src/*
- frontend/src/*

Goal:
Replace the current process-memory hotel/payment demo path with durable, authenticated Expedia Rapid TEST and Visa sandbox integrations. Four separately authenticated users must have distinct wallets, payment records, constraints, approvals, and exact contribution holds. Accord must search Expedia using user-entered destination/dates/occupancy, price-check the selected rate, collect four exact approvals/funding holds for one immutable proposal hash, create exactly one Expedia test booking, retrieve it, settle the four test-wallet holds, persist the receipt, and support cancellation/unwind.

Truth constraints:
1. Do not fabricate provider responses, transaction IDs, itinerary IDs, confirmation numbers, wallet funding, receipts, or sponsor evidence.
2. Do not use demoCatalog, fixed hotels, fixed prices, fixed destinations, random provider references, or local success fallbacks in INTEGRATION_MODE=required.
3. Expedia test bookings and Visa/Cybersource sandbox payments must be labeled TEST/SANDBOX. Never call them real reservations or real money.
4. If credentials, entitlements, or documented provider capabilities are missing, fail closed and report the exact blocker. Do not imitate the missing provider.
5. Visa Intelligent Commerce is restricted. Implement it only if the supplied account is entitled and the official documentation/credentials are available. Otherwise implement the approved Cybersource/Visa Acceptance sandbox path and label it precisely.
6. Never send four cards to Expedia unless Expedia's approved contract and API documentation explicitly support that exact flow. Use the wallet/merchant-of-record architecture in the plan, and keep production disabled.
7. Never store or log PAN, CVV, full payment tokens, secrets, private constraints, passkey payloads, or unencrypted Expedia booking links.
8. Deterministic code—not an LLM—owns money, feasibility, proposal hashing, material changes, consent, idempotency, ledger posting, and execution permission.
9. Do not relax privacy: private APIs derive identity from the HttpOnly session, and public DTOs are allowlisted.
10. Preserve unrelated user changes in the working tree.

Workflow:
A. Audit the current code and write a short implementation checklist tied to concrete files.
B. Verify the exact Expedia and Visa products enabled by the provided credentials using harmless authenticated sandbox calls. Do not print secrets.
C. Implement validated configuration and startup fail-closed behavior.
D. Add durable repositories, indexes, idempotency records, outbox, append-only double-entry wallet ledger, and transactional wallet holds.
E. Implement Expedia Rapid auth, content/geography, shopping, price check, create booking, retrieve, and cancel adapters with Zod validation, timeouts, bounded retries, opaque-link handling, and ambiguous-result recovery.
F. Implement provider-hosted/tokenized Visa payment setup and the available payment lifecycle: authorize/sale, capture where applicable, retrieve, reverse/void, refund, and verified webhooks. Add VIC instruction/passkey/signals only when entitled.
G. Replace fixture offers in the runtime with normalized Expedia offers. Treat missing required evidence as UNKNOWN and infeasible. Never have AI invent accessibility/cancellation evidence.
H. Split approval, payment/wallet hold, and execution into durable states. Implement the persisted booking saga and compensation behavior from the plan.
I. Update the frontend for dynamic search, wallet setup/funding/history, exact consent, provider progress, pending/unknown outcomes, sandbox labels, receipt, and cancellation.
J. Add unit, contract, opt-in live sandbox, and four-session E2E tests. Run typecheck, build, unit tests, and sandbox tests when credentials exist.
K. Update README and SPONSOR_EVIDENCE.md with only proven claims and sanitized provider references.

Implementation rules:
- Work phase by phase in reviewable commits/patches.
- Use integer cents and currency on every money record.
- Use stable idempotency keys derived from stored attempt records, never from current time.
- Use database uniqueness constraints and compare-and-swap transitions; no in-memory execution locks.
- Follow provider-returned links exactly; do not construct Expedia booking URLs.
- Price-check before consent and immediately before booking.
- On an ambiguous Expedia create result, retrieve using the same affiliate reference before any retry.
- On any material provider change, invalidate all approvals and release holds through ledger entries.
- A local database write must never overwrite provider truth. Reconcile provider state after uncertain outcomes.
- Never mark the task complete while an adapter still returns canned success or a live sandbox E2E has not produced provider-returned identifiers.

At each phase, report:
- files changed
- behavior now proven
- tests run and results
- external provider IDs, sanitized
- remaining credential/entitlement blockers
- claims that are and are not yet safe to make

Do not enable production endpoints or make a live paid booking. Stop and request explicit operator authorization plus proof of production provider approval before any production-mode transaction.
```
