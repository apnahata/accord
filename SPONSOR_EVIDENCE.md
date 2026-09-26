# Accord sponsor evidence ledger

This ledger separates live provider proof from local synthetic tests, code paths, and deployment templates. Gemini and a generated Solana devnet operator key are configured locally in a gitignored `.env`; other external services remain placeholders. No sponsor submission is marked complete.

## Gemini / Google AI

- **Challenge:** HackGT eligibility not verified; official rules/account not supplied.
- **Official requirement:** Not verified.
- **Credentials/account:** Gemini API key configured in the local gitignored `.env`; the key is not committed.
- **Feature:** Private conversation-first intake with structured clarification and reviewable draft; on-demand public feasible-stay comparison and private own-check explanation.
- **Why Accord needs it:** Convert members' natural language into a reviewable proposal while keeping deterministic feasibility and consent in the backend.
- **Implementation:** `frontend/src/pages-intake.tsx` sends private conversation to `packages/server/src/server.ts`, which uses `packages/integrations/src/ai.ts` and the `@accord/domain` extraction schema. The server normalizes Eastern checkout time; the user separately confirms via `/me/constraints`. `packages/server/src/explanations.ts` builds public-only or authenticated-own-member fact lists from deterministic results. Gemini selects and orders fact IDs; the server renders only those verified facts. It rejects unknown IDs and changed offers. UI cards in `frontend/src/explanations.tsx` request explanations only when clicked. Local tests use controlled model responses; separate smoke tests call live Gemini.
- **Code path:** `POST /api/rooms/:id/me/intake/extract`, `POST /api/rooms/:id/offers/explanation`, `POST /api/proposals/:id/me/explanation`.
- **Live proof:** On 2026-09-26, `npm run verify:gemini -- --record` made a real Gemini API call through local intake with synthetic member text. It returned a schema-valid REVIEW draft with a $350 cap, walkable preference, and correct noon Eastern deadline; no constraints were saved before confirmation. `npm run verify:explanations -- --record` made real public and private Gemini calls in a synthetic four-member room, then mutated merchant price and refund terms and made two more private calls. Alex's result showed his own budget failure; Jordan's showed his own refund failure. Intercepted outbound model inputs contained no private limits or names in the public call and no other member's limit or name in the private calls. Sanitized records are in `sponsor-evidence/gemini-live-smoke.json` and `sponsor-evidence/gemini-explanations-live.json`.
- **Screenshot:** None.
- **Transaction/query/reference:** Local smoke-test records above; no provider request ID was exposed by these routes.
- **Failure behavior:** Returns `AI_UNAVAILABLE`; structured manual intake remains available.
- **Known limitations:** These prove local live calls with synthetic members, not reliability, deployed UI use, actual four-browser use, or sponsor eligibility. Gemini selects from server-written facts; it does not write free-form explanatory claims or change backend decisions. The model can ask clarifying questions or omit fields during intake. Gemini `gemini-3.8-flash` returned HTTP 503 for structured output during testing, so the local verified model is `gemini-3.5-flash-lite`. Draft conversation is not persisted.
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
- **Credentials/account:** Not configured.
- **Feature:** Planned opt-in reusable member preferences; not yet connected to authenticated user flow.
- **Why Accord needs it:** Let a member recall reusable preferences in a later trip without turning them into spending permission.
- **Implementation:** Generic adapter in `packages/integrations/src/backboard.ts`; no user mapping, memory write or recall flow is wired.
- **Code path:** `/api/rooms/:id/me/memories` returns `BACKBOARD_UNAVAILABLE`.
- **Live proof:** None.
- **Screenshot:** None.
- **Transaction/query/reference:** None.
- **Failure behavior:** Current-trip preferences can be entered manually.
- **Known limitations:** No API key, stored assistant mapping proof, actual memory or retrieval session.
- **Submission status:** Not verified; do not claim Backboard memory yet.

## Solana

- **Challenge:** HackGT eligibility not verified; official rules/account not supplied.
- **Official requirement:** Not verified.
- **Credentials/account:** A locally generated operator seed is in the gitignored `.env`; its public devnet address is `H4TbUH5PahmUdTPPdMbJYcinGsEqcE2KXhdkbki33nU4`. The address currently has 0 lamports.
- **Feature:** Optional devnet operator commitments for proposal creation, staleness and confirmed booking, using the backend's canonical proposal hash.
- **Why Accord needs it:** Provide an external reference to nonprivate proposal versions while backend consent remains authoritative.
- **Implementation:** The API loads the server-only signer, verifies the full devnet genesis hash, checks operator balance, signs a Memo transaction containing only public references and the domain proposal hash, persists the signed transaction before broadcast, and polls for confirmation. The backend queues commitments after proposal creation, stale invalidation and confirmed booking. The public DTO and UI show an explorer link only after confirmation; the UI calls it an **operator** commitment, not a member signature. With no signer, the feature reports `NOT_RECORDED`.
- **Code path:** `packages/server/src/solana-config.ts`, `packages/server/src/state.ts`, `packages/integrations/src/solana.ts`, `frontend/src/components.tsx`, `tools/verify-solana.mjs`.
- **Live proof:** On 2026-09-26, after funding the devnet operator with 1 test SOL, the real Accord smoke created proposal v1, changed merchant price, and created a distinct v2 hash. Both commitments reached `CONFIRMED`; the smoke queried each transaction and verified its on-chain Memo contains the matching backend proposal hash. The explorer records are [v1](https://explorer.solana.com/tx/42S9dGsqxAbV48C592SVKqkN7bkEpKJRaixjChYfRbh6QkFYwMuNetdj7HQcK5uxXfsHX659PbuMpKkT79cyeGjy?cluster=devnet) and [v2](https://explorer.solana.com/tx/58cgKj1PCnwUjWJ3nfSsMFxMLGA18yoZ8RCUhiPUQotyp3UEDLnNQimfE1KvNBA9aPcPKKtCrd8fB4KNoi4R3tT9?cluster=devnet). Sanitized details are in `sponsor-evidence/solana-devnet-smoke.json`. Earlier faucet attempts failed while the wallet was unfunded; they are superseded by this successful proof. A controlled lifecycle test covers backend event wiring but is not chain proof by itself.
- **Screenshot:** None.
- **Transaction/query/reference:** Two confirmed devnet transaction signatures and explorer URLs are listed above and in the smoke record; the smoke independently reads both transactions and checks their Memo hashes.
- **Failure behavior:** An unfunded/unavailable operator results in `FAILED` (or `NOT_RECORDED` when unconfigured). Backend consent and booking safety remain enforced, and no explorer link is shown.
- **Known limitations:** Devnet is for testing; its tokens have no real value and the public RPC may be rate-limited. The operator signs these receipts, so they prove Accord recorded proposal hashes, not that individual members signed or approved them. No custom Solana program or real payment is involved. The current worker is process-local and retries pending confirmations for a bounded period; a signed transaction can be rebroadcast after restart while its blockhash remains valid. No Vultr deployment has been tested.
- **Submission status:** Real devnet integration verified locally; HackGT category eligibility and deployed/demo proof remain unverified.

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
- **Credentials/account:** Not configured.
- **Feature:** Planned voice intake; no audio route is connected.
- **Why Accord needs it:** Let members privately state functional constraints by voice and confirm the resulting structured candidate.
- **Implementation:** Adapter in `packages/integrations/src/voice.ts`; no real service call in the API.
- **Code path:** `/api/intake/transcribe` returns `ELEVENLABS_UNAVAILABLE`.
- **Live proof:** None; no real audio/transcription request.
- **Screenshot:** None.
- **Transaction/query/reference:** None.
- **Failure behavior:** Text input remains available.
- **Known limitations:** No API key, captured audio, actual transcript or UI confirmation proof.
- **Submission status:** Not verified; do not claim ElevenLabs use.

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
- **Implementation:** `packages/server/src/persistence.ts` (transactional write-through, AES-256-GCM sealed constraints, session TTL index) and `MongoMerchantStore`, wired in `packages/server/src/state.ts`.
- **Code path:** `/api/health` pings Mongo and reports `UP`/`DOWN`; every API response is sent only after its state changes commit.
- **Live proof:** `npm run test:mongo` passed against the Atlas cluster: four sessions, encrypted constraints, consent, two coordinator restarts and one booking recovered from Mongo. Not yet demonstrated on a hosted deployment.
- **Screenshot:** None.
- **Transaction/query/reference:** None.
- **Failure behavior:** Health gate requires Mongo before deployment readiness; actual execution must fail closed in backend.
- **Known limitations:** Single coordinator process only (in-memory working copy, process-local SSE). Encryption key lives in an environment variable, not a KMS.
- **Submission status:** Not verified.
