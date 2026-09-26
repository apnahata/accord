# Accord provider and runtime adapters

These adapters contain no independent Accord domain model. The integrated local API imports the authoritative `@accord/domain` Zod contracts and binds the merchant, SSE, and Gemini adapters. Gemini intake and explanation routes have been verified with local live calls; the other external provider adapters are tested with controlled fakes and are not wired to live services or verified sponsor accounts.

## Install and verify

From the repository root:

```sh
npm ci
npm run check
npm test -w @accord/integrations
npm run test:core
```

The adapter tests use deterministic provider fakes and a clearly identified merchant storage test double. They verify fail-closed and boundary behavior; they are not sponsor API proofs.

## Integrated local composition and remaining work

- The local API imports offer, merchant mutation, public/private SSE, AI extraction, and DTO schemas from `@accord/domain`. Do not define copies in this package.
- Construct `Gemini` with server-only key/model configuration. The API uses `@accord/domain` for extraction and server-only presentation schemas for on-demand public/private explanations. `packages/server/src/explanations.ts` sends only public solver facts to the public model call and only the authenticated member's own constraints/checks to the private call. Gemini selects verified fact IDs; it cannot add claims or alter business state. Persist extracted constraints only after explicit member confirmation. The generic `createIntelligence()` helper remains available but is not the wired route.
- Construct `Backboard` with its server key. Create one assistant per authenticated user, transactionally persist its `assistant_id` on that user record, and never accept an assistant ID from a client. Invoke `remember()` only after backend-verified explicit confirmation. Reuse that assistant for later retrieval. `recall()` returns suggestions as unapplied.
- Construct `Tiger` from the configured Tiger Cloud PostgreSQL URL and run `npm run migrate:tiger` with a migration identity. The application role needs only the intended insert/select permissions. Use the transactional outbox's stable ID and event timestamp for retries. Supply only the narrow public projection. The backend's material-diff classification is the source of the three materiality flags.
- Without `MONGODB_URI`, the local API uses `MemoryMerchantStore` and process memory. With Mongo configured, it uses `MongoMerchantStore` and persists operational room/member/session/proposal/consent/booking state in Atlas. The catalogue seed and deterministic mutation applicator come from `@accord/domain`. The merchant mutation outbox drives the local stale transition; multi-process delivery is still unsupported.
- Call `Merchant.execute()` only inside the existing server-gated booking path, after authoritative consent, exact payment authorization, and fresh preflight. It checks merchant version, inventory, expiry and idempotency atomically. Its receipt explicitly says `SIMULATED`. The merchant adapter does not grant purchase permission.
- Construct `RoomStreams` with the backend's distinct strict public-room and private-member event schemas and an authorization function that resolves the session cookie against current room membership on connect and throughout delivery. Publish private events using the server-resolved recipient. This broker is process-local; use the outbox or shared pub/sub when running multiple coordinator instances.
- Call `ElevenLabs.transcribe()` only for private authenticated uploads, then route its returned transcript through the exact same Gemini confirmation path as typed input.
- Construct `SolanaCommitments` from a devnet RPC and server-held devnet keypair. The key must be loaded from an untracked secret mount, never client input. The backend supplies its proposal hash and strict public reference. Before broadcast, save the returned signature and signed bytes to the backend's idempotent commitment journal through the callback. Reconcile `PENDING` from the saved signature after restarts. Only `CONFIRMED` carries an explorer URL. The record is an operator commitment, not a member signature.
- Register real health probes. A present credential alone is not an `UP` service. Keep sponsor calls asynchronous/optional; do not let an optional provider failure weaken domain purchase checks.

## Merchant transaction and recovery

`MongoMerchantStore` uses a majority-write Mongo transaction for each catalogue mutation/booking and inserts an outbox event in the same transaction. The outbox is at-least-once: consumers must be idempotent. The demo booking idempotency key is unique through Mongo `_id`; inventory is marked booked inside the same transaction. A version mismatch, sell-out, expiry, failure trigger, or second purchase key creates no confirmed receipt. Transaction support requires Atlas or an equivalent replica set. Unknown Mongo commit results must be reconciled using the booking key before the caller reports an outcome.

Outbox delivery should run promptly after every merchant mutation. Until the domain stale transition is committed, the old quote version no longer matches merchant state, so `execute()` fails closed. Tiger/SSE are projections of current domain and event state, never the authorization decision.

## Tiger session metrics

Run a fresh session query with the server-created room ID and room/session start timestamp. Events are ordered by actual persisted timestamps; stability is computed from Tiger query rows. The response names its source and says “Observed stability during this planning session.” A new room/reset creates a new session window; do not mix another room or an earlier demo run. No market prediction is made.

## Services deliberately unimplemented here

There is no Visa payment adapter without confirmed API access and endpoint semantics, no `.tech` registration, and no live Vultr deployment. Live local Gemini intake and explanation calls are recorded in `sponsor-evidence/`; this does not prove deployed use. Backboard, Tiger, Solana and ElevenLabs are not connected to local API routes or live accounts. Do not present those as completed.
