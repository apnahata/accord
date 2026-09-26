# Accord sponsor evidence ledger

This ledger records verified proof only. A configured adapter, local synthetic test, code path, or deployment template is not live sponsor evidence. External credentials and services were explicitly left as placeholders. No sponsor submission is marked complete.

## Gemini / Google AI

- **Challenge:** HackGT eligibility not verified; official rules/account not supplied.
- **Official requirement:** Not verified.
- **Credentials/account:** Not configured.
- **Feature:** Private conversation-first intake route with structured clarification and a reviewable draft; public/private model explanations are not wired.
- **Why Accord needs it:** Convert members' natural language into a reviewable proposal while keeping deterministic feasibility and consent in the backend.
- **Implementation:** `frontend/src/pages-intake.tsx` sends the member's conversation to `packages/server/src/server.ts`, which uses `packages/integrations/src/ai.ts` and validates against `@accord/domain` extraction schema. The user must separately confirm via `/me/constraints`. The local multi-turn test uses a fake provider response, not live Gemini.
- **Code path:** `POST /api/rooms/:id/me/intake/extract`.
- **Live proof:** None.
- **Screenshot:** None.
- **Transaction/query/reference:** None.
- **Failure behavior:** Returns `AI_UNAVAILABLE`; structured manual intake remains available.
- **Known limitations:** No API key, completed real call, public/private model explanations, persisted draft conversation, or deployed UI verification.
- **Submission status:** Not verified; do not claim use yet.

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
- **Credentials/account:** No operator devnet signer configured.
- **Feature:** Planned devnet operator commitment to the backend proposal hash.
- **Why Accord needs it:** Provide an external reference to nonprivate proposal versions while backend consent remains authoritative.
- **Implementation:** Generic adapter in `packages/integrations/src/solana.ts`; canonical hashes come from `@accord/domain`. No API transaction wiring.
- **Code path:** Proposal DTO in `packages/server/src/state.ts` reports `NOT_RECORDED`.
- **Live proof:** None.
- **Screenshot:** None.
- **Transaction/query/reference:** None; no signature or explorer URL exists.
- **Failure behavior:** Backend consent stays enforced, and no explorer link is shown.
- **Known limitations:** No funded devnet signer, genuine transaction, hash-difference test or confirmation proof.
- **Submission status:** Not verified; do not claim an on-chain commitment yet.

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
- **Credentials/account:** No Mongo connection configured.
- **Feature:** Future durable operational state for hosted use.
- **Why Accord needs it:** Persist current rooms, consent and merchant state under backend access controls.
- **Implementation:** `MongoMerchantStore` exists in `packages/integrations/src/mongo-merchant.ts` but is not wired; room/member/proposal/consent/booking state remains process-memory in `packages/server/src/state.ts`.
- **Code path:** `/api/health` reports `mongo: UNCONFIGURED`.
- **Live proof:** None.
- **Screenshot:** None.
- **Transaction/query/reference:** None.
- **Failure behavior:** Health gate requires Mongo before deployment readiness; actual execution must fail closed in backend.
- **Known limitations:** No operational repositories, credentials, indexes, restart recovery or multi-session persistence proof.
- **Submission status:** Not verified.
