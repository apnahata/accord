# Accord sponsor evidence ledger

This ledger separates live provider proof from local synthetic tests, code paths, and deployment templates. Gemini, LiteAPI sandbox, and SerpApi keys are configured locally in a gitignored `.env`; other external services remain placeholders. No sponsor submission is marked complete.

## Live stay providers (core product, not a sponsor claim)

- **Credentials/account:** LiteAPI sandbox key and SerpApi key are configured locally; neither key is committed. Accord rejects LiteAPI production keys.
- **Feature:** Real hotel-rate search and sandbox booking through LiteAPI; real Google Hotels vacation-rental search through SerpApi, with external checkout handoff only.
- **Why Accord needs it:** Groups must compare actual dated stays and recheck the exact approved hotel rate before a sandbox booking.
- **Implementation:** `packages/server/src/stays.ts` maps provider responses to `@accord/domain` offers. `packages/server/src/state.ts` runs the deterministic checks, takes four simulated member authorizations, requotes and prebooks the selected hotel, and books only through LiteAPI sandbox. Rentals without a public HTTPS handoff link are excluded.
- **Code path:** `POST /api/rooms/:id/solve`, `GET /api/rooms/:id/offers`, `POST /api/proposals/:id/consent`, `POST /api/proposals/:id/execute`; reproducible verifier `tools/verify-live-stays.mjs`.
- **Live proof:** On 2026-09-26, the local four-session Accord flow returned 28 LiteAPI hotel offers and 10 SerpApi rentals with handoff links for a Miami trip. Four synthetic members authorized their shares in Accord's simulated mode. LiteAPI returned sandbox booking `gdBAdCtbs`; a repeat Accord execute returned the same reference. A separate real LiteAPI `GET /bookings/{bookingId}` returned HTTP 200, `CONFIRMED`, `sandbox: 1`, USD 570.42, matching the approved offer. A separate four-member SerpApi-only flow returned `HANDOFF` and a real HTTPS listing link, without booking the rental. Sanitized proof is in `sponsor-evidence/live-stays-smoke.json`.
- **Screenshot:** None; this was an API flow, not a four-browser UI rehearsal.
- **Transaction/query/reference:** LiteAPI sandbox booking `gdBAdCtbs`; SerpApi search returned rental results. No production reservation or payment authorization occurred.
- **Failure behavior:** Provider failures return an error or reuse the last successful search; they do not produce a booking. Missing rental handoff links are filtered. A detected changed hotel rate or terms invalidates the proposal and requires fresh consent.
- **Known limitations:** Member payment authorizations are simulated, no real room is reserved, no card is charged, and vacation rentals are not booked by Accord. The test used in-memory coordinator state and synthetic member identities; it did not prove Mongo, deployment, or browser behavior. Search counts depend on date and provider inventory. Real-world listing quality and cancellation/accessibility claims need broader review.
- **Submission status:** Core provider API use and one sandbox booking verified locally; no sponsor category is claimed for them.

## Gemini / Google AI

- **Challenge:** HackGT eligibility not verified; official rules/account not supplied.
- **Official requirement:** Not verified.
- **Credentials/account:** Gemini API key configured in the local gitignored `.env`; the key is not committed.
- **Feature:** Private conversation-first intake with structured clarification and reviewable draft; on-demand public feasible-stay comparison and private own-check explanation; when a live search finds no stay that works for everyone, suggesting up to two nearby areas for the coordinator to search.
- **Why Accord needs it:** Convert members' natural language into a reviewable proposal while keeping deterministic feasibility and consent in the backend.
- **Implementation:** `frontend/src/pages-intake.tsx` sends private conversation to `packages/server/src/server.ts`, which uses `packages/integrations/src/ai.ts` and the `@accord/domain` extraction schema. The server normalizes Eastern checkout time; the user separately confirms via `/me/constraints`. `packages/server/src/explanations.ts` builds public-only or authenticated-own-member fact lists from deterministic results. Gemini selects and orders fact IDs; the server renders only those verified facts. It rejects unknown IDs and changed offers. UI cards in `frontend/src/explanations.tsx` request explanations only when clicked. For widening, `packages/server/src/coordinator.ts` sends Gemini only the destination, dates, guest count and anonymous counts of failing checks (no limits, names or preferences); the server drops invalid or repeated suggestions, searches them through the normal providers, and the deterministic solver decides feasibility. Local tests use controlled model responses; separate smoke tests call live Gemini.
- **Code path:** `POST /api/rooms/:id/me/intake/extract`, `POST /api/rooms/:id/offers/explanation`, `POST /api/proposals/:id/me/explanation`; widening runs inside the coordinator after a live solve finds no feasible stay (no route of its own).
- **Live proof:** On 2026-09-26, `npm run verify:gemini -- --record` made a real Gemini API call through local intake with synthetic member text. It returned a schema-valid REVIEW draft with a $350 cap, walkable preference, and correct noon Eastern deadline; no constraints were saved before confirmation. `npm run verify:explanations -- --record` made real public and private Gemini calls in a synthetic four-member room, then mutated merchant price and refund terms and made two more private calls. Alex's result showed his own budget failure; Jordan's showed his own refund failure. Intercepted outbound model inputs contained no private limits or names in the public call and no other member's limit or name in the private calls. Sanitized records are in `sponsor-evidence/gemini-live-smoke.json` and `sponsor-evidence/gemini-explanations-live.json`.
- **Screenshot:** None.
- **Transaction/query/reference:** Local smoke-test records above; no provider request ID was exposed by these routes.
- **Failure behavior:** Returns `AI_UNAVAILABLE`; structured manual intake remains available.
- **Known limitations:** These prove local live calls with synthetic members, not reliability, deployed UI use, actual four-browser use, or sponsor eligibility. Gemini selects from server-written facts; it does not write free-form explanatory claims or change backend decisions. Destination widening is covered only by a local test with a stubbed model and stub provider (`packages/server/test/autopilot.test.ts`); it has not been run against live Gemini or live stay providers. The model can ask clarifying questions or omit fields during intake. Gemini `gemini-3.8-flash` returned HTTP 503 for structured output during testing, so the local verified model is `gemini-3.5-flash-lite`. Draft conversation is not persisted.
- **Submission status:** Live intake and explanation use verified locally; challenge eligibility and complete sponsor submission remain unverified.

## Tiger Data

- **Challenge:** HackGT eligibility not verified; official rules/account not supplied.
- **Official requirement:** Not verified.
- **Credentials/account:** No Tiger connection configured.
- **Feature:** Planned query-backed temporal events and stability; current local activity is process-memory data.
- **Why Accord needs it:** Show actual merchant offer changes, planning activity and observed session stability.
- **Implementation:** `packages/integrations/src/tiger.ts`, SQL migration and migration script are in this branch; no live API wiring.
- **Code path:** `/api/demo/analytics` returns `TIGER_UNAVAILABLE`; the local activity feed does not query Tiger.
- **Live proof:** None; no real Tiger insert/query was performed.
- **Screenshot:** None.
- **Transaction/query/reference:** None.
- **Failure behavior:** Core solve and consent work without Tiger; analytics returns an unavailable response.
- **Known limitations:** No connection string, hosted service, observed production query or judgeable feed.
- **Submission status:** Not verified; do not claim a Tiger integration yet.

## Backboard

- **Challenge:** HackGT eligibility not verified; official rules/account not supplied.
- **Official requirement:** Not verified.
- **Credentials/account:** A real `BACKBOARD_API_KEY` is configured in the local gitignored `.env`.
- **Feature:** Opt-in, reusable, non-financial member preferences (walkable / quiet / near-activities / refundable), recalled on a later trip and only ever applied to the current trip after the member explicitly confirms. Never a preference is written without that confirmation, and budgets/trip requirements are never sent to Backboard.
- **Why Accord needs it:** Let a member recall reusable preferences in a later trip without turning them into spending permission.
- **Implementation:** Adapter (unchanged) in `packages/integrations/src/backboard.ts` is now wired end to end. `packages/server/src/state.ts` lazily provisions one Backboard assistant per account on first use (`AccordState.memories`/`#ensureAssistant`), caches its id on the Mongo-persisted user record (`User.assistantId`), and exposes `AccordState.applyMemory` which only calls `Backboard.remember(...)` after the member's own explicit `{confirmed:true}` in that request. Applied-memory ids are tracked per room membership (`Member.appliedMemoryIds`) so "applied to this trip" reflects only this room. The frontend's existing `MemoryPanel` (`frontend/src/pages-private.tsx`) already called this exact contract and needed no changes.
- **Code path:** `GET /api/rooms/:id/me/memories`, `POST /api/rooms/:id/me/memories/:memoryId/apply`; health/`/api/capabilities` now report `backboard: CONFIGURED`/`available:true` from `Boolean(BACKBOARD_API_KEY)`, matching the `ai`/`liteapi` pattern (no cheap live-ping endpoint is documented for Backboard).
- **Live proof:** On 2026-09-26, a direct authenticated `POST https://app.backboard.io/api/assistants` with the configured key returned HTTP 200 and created a real assistant (`assistant_id: ebaca5ff-ea20-4dd3-a22b-454adf801d01`), confirming the key and endpoint are live. `packages/server/test/backboard.test.ts` separately exercises the full in-app flow (assistant provisioning, caching, recall, explicit-confirmation-only apply, 404 for an unknown memory id) against a controlled stub. The full through-the-app path (a real member triggering assistant provisioning + a real remembered preference recalled and applied in a live room) has not yet been exercised end to end with this key.
- **Screenshot:** None.
- **Transaction/query/reference:** Backboard assistant id `ebaca5ff-ea20-4dd3-a22b-454adf801d01` (test provisioning call, not created through the Accord app).
- **Failure behavior:** If `BACKBOARD_API_KEY` is absent, every route fails closed with `BACKBOARD_UNAVAILABLE` before any network call; current-trip preferences can still be entered manually.
- **Known limitations:** Applying a remembered preference re-confirms it to Backboard (per spec) rather than de-duplicating prior writes, which is a known adapter-level quirk. The end-to-end app flow (real user → real assistant → real remembered/applied preference visible in the room UI) has not yet been walked through live, only the direct API call and the stubbed test suite.
- **Submission status:** Wiring complete; key verified live against Backboard's API directly. Do a full in-app walkthrough before claiming the complete member-facing flow is live.

## Solana

- **Challenge:** HackGT eligibility not verified; official rules/account not supplied.
- **Official requirement:** Not verified.
- **Credentials/account:** A devnet keypair was generated locally for this task (address `EhMyvqXR1ghvQgC4J5LFxuR4KFQmdTEf3ErEphi7JnbR`; secret key is only in the local gitignored `.env` as `SOLANA_SIGNER_SECRET_KEY`, never committed). It is **not funded**: every `requestAirdrop` call to `https://api.devnet.solana.com` during this work returned HTTP 429 ("airdrop limit today or the faucet has run dry"), tried repeatedly at decreasing amounts (1, 0.5, 0.1, 0.05, 0.01 SOL) over several minutes, including a final retry just before writing this note. `solana`/`solana-keygen` CLI were not available in this environment, so the keypair was generated with `@solana/keys`/`@solana/kit` directly (seed + public key concatenated into the standard 64-byte secret, base58-encoded — round-trip verified against `createKeyPairSignerFromBytes`).
- **Feature:** On `PROPOSAL_CREATED`, `PROPOSAL_STALE`, and `BOOKING_CONFIRMED`, Accord attempts a best-effort devnet memo-program commitment of the proposal's existing canonical hash, id and version. The result (`NOT_RECORDED` / `PENDING` / `CONFIRMED` / `FAILED`) is now a real field on the proposal DTO (`PublicProposalDTO.solana`) instead of a hardcoded value, and is never authoritative over consent, payment or booking.
- **Why Accord needs it:** Provide an external reference to nonprivate proposal versions while backend consent remains authoritative.
- **Implementation:** Adapter (unchanged except for adding an exported `signerFromSecret()` helper and a narrow `SolanaCommitmentsPort` interface for testability) in `packages/integrations/src/solana.ts`; canonical hashes come from the proposal's existing `@accord/domain` hash. `packages/server/src/server.ts` builds a `KeyPairSigner` from `SOLANA_SIGNER_SECRET_KEY` (base58 or JSON byte array, via `createKeyPairSignerFromBytes`) only when that variable is set; with no signer, the `solana` provider is never attached and the DTO stays `NOT_RECORDED`, matching the existing fail-closed pattern for optional providers (`liteApi`, `google`, `payment`). `packages/server/src/state.ts` calls the adapter fire-and-forget at the three event types, persists the pending signature via Mongo write-through before broadcasting (per the adapter's contract), and writes the reconciled result onto the proposal, which is now included in Mongo persistence (`proposals.solana`) and survives a restart.
- **Code path:** Best-effort call sites in `AccordState.#solve` (`PROPOSAL_CREATED`), `AccordState.stale` (`PROPOSAL_STALE`), and both booking paths in `AccordState.#execute`/`#bookLiteApi` (`BOOKING_CONFIRMED`); surfaced on `GET /api/proposals/:id/public` and `/me`; health reports `solana: CONFIGURED`/`UNCONFIGURED` from whether a signer was constructed.
- **Live proof:** None yet — the generated keypair has zero devnet SOL, so a real broadcast has not been demonstrated. What **is** verified live: the code path constructs a real `@solana/kit` devnet RPC client, performs the same genesis-hash devnet check, transaction construction, and local signing the adapter uses in production, all confirmed offline in `packages/integrations/test/solana.test.ts` against a stubbed RPC (record/reconcile success, non-devnet rejection, on-chain failure, and `signerFromSecret` round-tripping a real generated keypair through both base58 and JSON-array forms). `packages/server/test/solana.test.ts` verifies the proposal DTO wiring end to end (unconfigured → `NOT_RECORDED`; configured with a stub → `CONFIRMED` with a signature and explorer URL surfaced on the DTO after `PROPOSAL_CREATED`; a merchant price change triggers a `PROPOSAL_STALE` attempt; an adapter that throws never blocks proposal creation).
- **Screenshot:** None.
- **Transaction/query/reference:** None real yet. Once funded (see below), the very first proposal created against this branch with `SOLANA_SIGNER_SECRET_KEY` set will produce a genuine devnet transaction signature and `https://explorer.solana.com/tx/<signature>?cluster=devnet` link, visible on the proposal DTO.
- **Failure behavior:** Backend consent stays enforced regardless of Solana's outcome; an adapter exception or an unfunded signer both fail closed to `FAILED`/`NOT_RECORDED` without touching booking or payment (`packages/server/test/solana.test.ts` covers the throwing case explicitly).
- **Known limitations:** No funded devnet signer, so no genuine on-chain transaction, signature, or explorer link has actually been produced. **To finish this**: fund the generated address with `solana airdrop 1 EhMyvqXR1ghvQgC4J5LFxuR4KFQmdTEf3ErEphi7JnbR --url devnet` (or https://faucet.solana.com, which uses a captcha and doesn't hit the same rate limit as the plain RPC faucet), confirm with `solana balance EhMyvqXR1ghvQgC4J5LFxuR4KFQmdTEf3ErEphi7JnbR --url devnet`, then create a proposal against a running Accord API with that `.env` — the resulting signature/explorer URL on the proposal DTO is the live proof this entry is still missing.
- **Submission status:** Wiring complete and covered by tests against a stubbed RPC; still not verified live — do not claim an on-chain commitment until the signer above is funded and a real devnet transaction signature is captured.

## Vultr

- **Challenge:** HackGT eligibility not verified; official rules/account not supplied.
- **Official requirement:** Not verified.
- **Credentials/account:** No Vultr account, host, DNS or deployment credential supplied.
- **Feature:** Container and TLS proxy deployment template plus HTTP verification helper.
- **Why Accord needs it:** Serve the shared coordinator and realtime collaboration to separate member devices.
- **Implementation:** `Dockerfile`, `deploy/compose.yaml`, `deploy/Caddyfile`, `deploy/check-health.mjs`, `deploy/README.md`, `tools/infra/verify-deployment.mjs`.
- **Code path:** Integrated local API and frontend are in this branch; deployment readiness requires `app` and `mongo` to be `UP`.
- **Live proof:** None. Compose syntax validation only; no container start, Vultr host, hostname or live request.
- **Screenshot:** None.
- **Transaction/query/reference:** No deployment ID, IP or URL.
- **Failure behavior:** Current API reports `mongo: UNCONFIGURED`; deployment readiness fails rather than claiming durable hosting.
- **Known limitations:** Operational state is process-memory; no image publication, host, domain, DNS, HTTPS or four-browser rehearsal.
- **Submission status:** Not deployed; do not claim Vultr use.

## ElevenLabs

- **Challenge:** HackGT eligibility not verified; official rules/account not supplied.
- **Official requirement:** Not verified.
- **Credentials/account:** A real `ELEVENLABS_API_KEY` is configured in the local gitignored `.env`.
- **Feature:** Private voice intake: a member records audio in the browser, it is transcribed, and the transcript is sent through the *exact same* text-intake confirmation pipeline (`POST /me/intake/extract`) — never a shortcut around the structured-confirmation review step. The frontend's existing `Voice` component and Intake page (`frontend/src/pages-private.tsx`, `frontend/src/pages-intake.tsx`) already implemented this "record → transcribe → send as a normal message → review → confirm" flow and needed no changes; only the missing server endpoint was wired.
- **Why Accord needs it:** Let members privately state functional constraints by voice and confirm the resulting structured candidate.
- **Implementation:** Adapter (unchanged) in `packages/integrations/src/voice.ts` is now called from `packages/server/src/server.ts`. A small dependency-free multipart/form-data reader (`multipartFile`) extracts the uploaded `audio` field from the request the existing frontend already sends, builds a `Blob` with its declared content type, and calls `ElevenLabs.transcribe()`. The returned transcript is size- and type-validated by the adapter (already implemented) and handed back as plain text; the client then posts it to the pre-existing `/me/intake/extract` route like any typed message, so nothing is ever saved before the member reviews and confirms the draft.
- **Code path:** `POST /api/intake/transcribe` (authenticated; previously a hardcoded `ELEVENLABS_UNAVAILABLE` stub, matching the exact endpoint the frontend `Voice` component already called); health/`/api/capabilities` now report `elevenlabs: CONFIGURED`/`elevenLabs.available:true` from `Boolean(ELEVENLABS_API_KEY && ELEVENLABS_MODEL)`.
- **Live proof:** On 2026-09-26, a direct authenticated `GET https://api.elevenlabs.io/v1/user` with the configured key returned HTTP 200 with a real account (`user_id: user_6001m3g87mxbeje9hkkcpgq09x2n`, free tier), confirming the key is live and the `scribe_v1` model is reachable. `packages/server/test/voice.test.ts` separately exercises the full in-app flow (unconfigured → 503 with no network call; unauthenticated → 401 with no network call; configured → uploaded audio transcribed and returned; wrong content type or missing `audio` field → 422 before any call) against a controlled stub. An actual browser recording has not yet been transcribed end to end through the app with this key.
- **Screenshot:** None.
- **Transaction/query/reference:** ElevenLabs account `user_6001m3g87mxbeje9hkkcpgq09x2n` (auth check, not a transcription call).
- **Failure behavior:** If `ELEVENLABS_API_KEY` is absent, the route fails closed with `ELEVENLABS_UNAVAILABLE` before any network call; the frontend already hides the voice button when `/api/capabilities` reports it unavailable, and typed text input remains fully available either way.
- **Known limitations:** The multipart parser is a minimal implementation sufficient for the browser's own `FormData` upload shape, not a general-purpose multipart library. Real speech-to-text quality/latency through the actual app UI has not yet been walked through with this key, only the auth check and the stubbed test suite.
- **Submission status:** Wiring complete; key verified live against ElevenLabs's API directly. Do a real in-browser voice-intake walkthrough before claiming the complete member-facing flow is live.

## Visa / payments

- **Challenge:** HackGT rules, API access and Visa eligibility not verified.
- **Official requirement:** No event challenge documentation supplied.
- **Credentials/account:** No Visa sandbox credentials or merchant test setup verified.
- **Feature:** Accord group orchestration with simulated contributions unless a real compatible provider is confirmed.
- **Why Accord needs it:** Each payer must authorize their share of the same immutable purchase before checkout.
- **Implementation:** `packages/server/src/state.ts` supports clearly labeled simulated contribution authorization and controlled demo booking. No Visa card call or adapter exists.
- **Code path:** `POST /api/proposals/:id/consent` and `/execute`.
- **Live proof:** None.
- **Screenshot:** None.
- **Transaction/query/reference:** None; no authorization reference exists.
- **Failure behavior:** No real provider fallback is implied; UI and receipt label the simulation and say no card was charged.
- **Known limitations:** Credential access, eligible endpoints, sandbox operation and group settlement support are unverified.
- **Submission status:** Do not claim Visa processing or sandbox use.

## .tech

- **Challenge:** Registration/submission requirements not verified.
- **Official requirement:** Not verified.
- **Credentials/account:** No registered domain supplied.
- **Feature:** None verified.
- **Why Accord needs it:** A stable public URL would make the deployed group planning demo accessible.
- **Implementation:** None; deployment proxy accepts a configured real hostname.
- **Code path:** `deploy/Caddyfile` only; it does not register or prove a domain.
- **Live proof:** None.
- **Screenshot:** None.
- **Transaction/query/reference:** No domain registration or DNS record verified.
- **Failure behavior:** No domain claim is shown without registration and deployment proof.
- **Known limitations:** Domain, DNS, TLS and live app are absent.
- **Submission status:** Not pursued/verified.

## Notability

- **Challenge:** HackGT challenge requirements not verified.
- **Official requirement:** Not verified.
- **Credentials/account:** No Notability use or account evidence supplied.
- **Feature:** None verified; this would be genuine process documentation, not a runtime integration.
- **Why Accord needs it:** Actual architecture and consent review notes could support team design/rehearsal.
- **Implementation:** None recorded.
- **Code path:** None.
- **Live proof:** None.
- **Screenshot:** None; no retrospective screenshots should be created.
- **Transaction/query/reference:** None.
- **Failure behavior:** Not applicable.
- **Known limitations:** No contemporaneous notes/screenshots or official requirement.
- **Submission status:** Not verified.

## Meta

- **Challenge:** HackGT eligibility and submission criteria not verified.
- **Official requirement:** Not verified.
- **Credentials/account:** No Meta API credentials supplied; no runtime API is assumed.
- **Feature:** Product demonstration only: four real member sessions, private boundaries and shared collaboration.
- **Why Accord needs it:** The product should keep members involved while the AI mediates private coordination.
- **Implementation:** Integrated local API has separate authenticated sessions, public/private SSE, and a four-session HTTP flow test. The verifier supports four authenticated SSE clients.
- **Code path:** `packages/server/src/server.ts`, `packages/server/test/flow.test.ts`, `tools/infra/verify-deployment.mjs`.
- **Live proof:** None; local API tests are development proof, not four-browser or live-host proof.
- **Screenshot:** None.
- **Transaction/query/reference:** No real four-browser session.
- **Failure behavior:** Anonymous room access is rejected; deployment verification fails unless four sessions receive the configured event.
- **Known limitations:** No deployed app, browser rehearsal, video or actual member credentials.
- **Submission status:** Not verified; product evidence still required.

## MongoDB (core dependency, not listed as a sponsor claim)

- **Challenge:** Not treated as a sponsor submission.
- **Official requirement:** Not applicable/verified.
- **Credentials/account:** Atlas cluster configured locally via gitignored `.env` (not committed).
- **Feature:** Durable operational state: rooms, members, sessions, invitations, proposals, approvals, authorizations, bookings and merchant inventory/outbox.
- **Why Accord needs it:** Persist current rooms, consent and merchant state under backend access controls.
- **Implementation:** `packages/server/src/persistence.ts` (transactional write-through, AES-256-GCM sealed constraints and private coordinator messages, session TTL index) and `MongoMerchantStore`, wired in `packages/server/src/state.ts`.
- **Code path:** `/api/health` pings Mongo and reports `UP`/`DOWN`; every API response is sent only after its state changes commit.
- **Live proof:** `npm run test:mongo` passed against the Atlas cluster: four sessions, encrypted constraints, consent, two coordinator restarts and one booking recovered from Mongo. Not yet demonstrated on a hosted deployment. On 2026-09-26 a second Atlas test also passed: Accord's private nudge to one member was stored only as ciphertext (no stay name or amounts in the document), came back intact after a restart, was accepted from the restored copy to trigger an automatic replan, and the new proposal's watch state was reloaded after a further restart.
- **Screenshot:** None.
- **Transaction/query/reference:** None.
- **Failure behavior:** Health gate requires Mongo before deployment readiness; actual execution must fail closed in backend.
- **Known limitations:** Single coordinator process only (in-memory working copy, process-local SSE, in-process autopilot timers). Encryption key lives in an environment variable, not a KMS.
- **Submission status:** Not verified.
