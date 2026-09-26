# Accord

Accord helps groups plan and purchase a shared stay while keeping each member's personal boundaries private. This checkout contains the React app, one authoritative domain package, the local API, provider adapters, and deployment templates.

## Run the local demo

Requirements: Node 22 and npm. Without `MONGODB_URI` the local API uses process memory, and restarting it resets users, rooms, sessions, approvals, merchant mutations and bookings. `npm run dev:api` reads a root `.env` file if present (see [MongoDB persistence](#mongodb-persistence)). Live groups use Nuitée Connect sandbox inventory/bookings and CyberSource sandbox payments when configured; no real card or real hotel reservation is created.

```sh
npm ci
npm run dev:api
```

In a second terminal:

```sh
npm run dev:web
```

Open the Vite URL shown in the terminal. It proxies `/api` to `http://localhost:3000`. Alternatively, run `npm run build` and open `http://localhost:3000`; the API serves the built frontend itself.

For a QR code that opens on a phone, set `PUBLIC_APP_URL` to the laptop's reachable LAN or tunnel URL and open that same URL in the host browser. A QR containing `localhost` can only work on the computer that generated it.

Create four email/password accounts (sign out between accounts if you use one browser, or use separate profiles to view them simultaneously). The host creates a live trip and shares its invite. Each member confirms private requirements; Gemini may parse the conversation, but the deterministic solver alone decides feasibility. Once every member approves an exact contribution, Accord creates one shared CyberSource sandbox authorization for the group total, re-quotes and books the exact Nuitée Connect sandbox rate, then captures the one shared payment. The host can open **Demo event controls** from the group page to change Accord's observed offer and demonstrate stale consent and reversal.

## Frictionless accounts and history

Accord requires a normal email/password account before creating or joining a group. Passwords are salted and hashed; login creates a cryptographically random 30-day `HttpOnly`, `SameSite=Lax` session, while the server stores only its SHA-256 hash. One account can belong to multiple groups and works across browsers. `/me` lists active groups, confirmed bookings, the member's contribution commitments, and that member's allocation in shared payment events. Group booking confirmations are visible to every active member.

## Live stay search

When the host creates a group with trip details (destination, dates, guests), Accord searches real inventory instead of the demo catalog:

- **LiteAPI** (`LITEAPI_KEY`): hotels with live rates, refundability, occupancy, check-out times, facilities, review analysis and nearby places. Booking re-quotes the exact approved room first; any price or terms change stales consent instead of booking. With a sandbox key (`sand_…`), bookings are test bookings and nothing is charged.
- **SerpApi Google Hotels** (`SERPAPI_KEY`): vacation rentals with prices, free-cancellation dates, capacity and amenities. These are search-only: once everyone approves, the host is handed off to the listing site. Results are cached for 30 minutes per group to save search credits.

Provider data is mapped conservatively into the domain `Offer`: missing accessibility evidence is *unknown* (never a pass), a closed or missing refund window is non-refundable, and check-out times come from the listing. Feasibility, ranking and consent stay deterministic in `@accord/domain`; Gemini only writes an optional public summary from listing facts. Times are interpreted in `America/New_York`, so destinations should be US East Coast cities for now. A member may leave a group at any time, which stales any proposal because everyone's equal share changes. Groups created without trip details keep using the controlled demo catalog (and the automated flow tests use it).

## MongoDB persistence

Set these in a root `.env` (gitignored) to keep all coordinator state in MongoDB Atlas:

```sh
MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=accord
ACCORD_ENCRYPTION_KEY=   # 32 random bytes, base64
```

Users, rooms, memberships, sessions, invitations, proposals, approvals, the append-only payment ledger, shared authorization/capture/reversal state, bookings and merchant inventory are stored in Atlas and reloaded on restart. Private constraints are stored only as AES-256-GCM ciphertext. The process keeps an in-memory working copy and writes every change in one Mongo transaction before responding, so run exactly one API process. `/api/health` reports `mongo: UP` after a live ping. `npm run test:mongo` runs a restart-recovery test against a throwaway database on that cluster. The demo reset endpoint deletes all stored users, rooms, sessions and merchant changes.

## Verify

```sh
npm run check
npm run test:core
node --test tools/infra/test/*.test.mjs
```

The core tests exercise four separate authenticated HTTP sessions, the stale-to-booked flow, and a multi-turn intake with a fake model response. They do not prove four browser UIs, a live model, or a deployed service. The infrastructure test exercises a synthetic localhost SSE server. Provider adapter tests use controlled responses, not live sponsor credentials.

For a live Gemini intake smoke test, set `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-3.5-flash-lite` in the gitignored root `.env`, then run `npm run verify:gemini -- --record`. It calls Gemini through the local Accord API with synthetic member text, checks the review draft and no-save-before-confirmation rule, and writes a sanitized result to `sponsor-evidence/gemini-live-smoke.json`. A provider error or incorrect draft makes the command fail.

After the group searches, members can ask Gemini to explain the backend-selected feasible stay using public facts only. On an exact proposal, each member can request a separate explanation of only their own deterministic checks. Gemini chooses and orders verified facts; it never changes feasibility, ranking, approval, or booking permission. These calls are optional and return `AI_UNAVAILABLE` if the provider fails. Run `npm run verify:explanations -- --record` with the same local Gemini configuration to exercise both live routes with synthetic members and save a sanitized privacy check.

## Ownership and limitations

- `packages/domain` owns validated constraints, merchant mutation schema, deterministic feasibility, equal shares, proposal hashes and shared frontend DTO types. The frontend imports its types from this package.
- `packages/server` owns accounts, sessions, authenticated API routes, room/proposal state, the shared payment ledger, and sandbox booking orchestration. It binds the merchant and SSE adapters from `packages/integrations`.
- `packages/integrations` contains provider and merchant transports. Optional sponsor services stay unavailable until configured and proven live.
- `deploy` contains a Vultr-ready template, not an actual deployment. It requires a real integrated image, `MONGODB_URI`/`ACCORD_ENCRYPTION_KEY`, host and DNS before a production claim. Without Mongo configured the API reports `UNCONFIGURED` and deliberately fails the deployment readiness gate.

Operational state is Mongo-backed when configured; it is still a single-process coordinator (SSE fan-out and the working copy are process-local), so do not run multiple replicas. CyberSource calls and the shared funding card are sandbox-only, so no real money moves. Stays are live provider inventory booked in Nuitée Connect's sandbox, so no real-world room is reserved. Backboard, Tiger, Solana and ElevenLabs remain unavailable in this branch. Gemini intake has been verified live with `gemini-3.5-flash-lite`, but Gemini never decides feasibility or grants payment permission. See [sponsor evidence](SPONSOR_EVIDENCE.md) for exact claim status.
