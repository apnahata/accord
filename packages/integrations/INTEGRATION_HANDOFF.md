# Backend integration handoff

## Shared exports now available

This checkout uses `ACCORD_BRIEF.md` and now contains the authoritative `@accord/domain` package, local API, frontend and provider adapters. The frontend and server import the same schemas/DTO types. The local API implements one `/consent` action that validates the exact proposal; the brief's separate sample `/approve` and `/authorize` routes are not used.

The domain package currently exports:

- merchant offer, mutation, and event Zod schemas and their deterministic versioned mutation function;
- public/private SSE events and the authenticated room/session lookup;
- AI typed extraction schema;
- canonical room-scoped IDs/session timestamps and deterministic feasible candidate evaluation.

The generic adapters in `src/merchant.ts` and `src/ai.ts` accept shared contracts by injection. The local API owns the `/consent` and booking gates; those are currently process-memory transitions. It still needs durable identity/consent repositories, public/private AI explanation schemas and input projectors, Backboard assistant mapping, and a Solana commitment journal before those features can be enabled.

## Commitments that caller must preserve

`MongoMerchantStore` requires a Mongo replica set and transactional storage. `MongoMerchantStore.drain()` is at-least-once, and downstream domain transitions use an idempotent backend event ID. The first call to `/consent` stays the only UI action and remains domain-validated.

Each public SSE event is strictly validated against the backend public event schema. Private events go only to the server-resolved session member. Reauthorize while connected. Multi-process deployments need shared pub/sub; this in-process broker does not forward between hosts.

Public AI input is constructed solely by backend allowlist projectors. Private AI input contains that session's own capsule/checks only. All extraction results require member confirmation before an existing backend write call. The LLM never makes feasibility, consent, payment, or booking decisions.

Tiger writes are optional and append-only; keep strict public metadata and stable outbox timestamps/IDs. Only display results after query success. Solana stores a proposal hash supplied by the backend and reveals the explorer link only after devnet confirmation. Store a signed commitment before broadcast and reconcile uncertain outcomes by transaction signature.
