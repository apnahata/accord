# Accord

Accord helps groups plan and purchase a shared stay while keeping each member's personal boundaries private. This checkout contains the React app, one authoritative domain package, the local API, provider adapters, and deployment templates.

## Run the local demo

Requirements: Node 22 and npm. Without `MONGODB_URI` the local API uses process memory, and restarting it resets rooms, sessions, approvals, merchant mutations and bookings. `npm run dev:api` reads a root `.env` file if present (see [MongoDB persistence](#mongodb-persistence)). All listings and payment authorizations are explicitly simulated. No external account is required for the local core flow.

```sh
npm ci
npm run dev:api
```

In a second terminal:

```sh
npm run dev:web
```

Open the Vite URL shown in the terminal. It proxies `/api` to `http://localhost:3000`. Alternatively, run `npm run build` and open `http://localhost:3000`; the API serves the built frontend itself.

Create a group as Alex, open the invite in three separate browser profiles, and join as Priya, Jordan and Mateo. Confirm the brief's private constraints. Solve to see the $1,200 Miami demo stay. All four members approve and authorize their **simulated** $300 shares. From Alex's authenticated merchant console, increase Miami to $1,440. The old consent becomes stale; Alex privately sees that the new $360 share exceeds his $350 cap. Replan to the $1,120 Tampa demo stay, get four fresh $280 authorizations, and book once. The receipt clearly says no card was charged and no real accommodation was reserved.

## MongoDB persistence

Set these in a root `.env` (gitignored) to keep all coordinator state in MongoDB Atlas:

```sh
MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=accord
ACCORD_ENCRYPTION_KEY=   # 32 random bytes, base64
```

Rooms, members, sessions, invitations, proposals, approvals, authorizations, bookings and merchant inventory are then stored in Atlas and reloaded on restart. Private constraints are stored only as AES-256-GCM ciphertext. The process keeps an in-memory working copy and writes every change in one Mongo transaction before responding, so run exactly one API process. `/api/health` reports `mongo: UP` after a live ping. `npm run test:mongo` runs a restart-recovery test against a throwaway database on that cluster. The demo reset endpoint deletes all stored rooms and merchant changes.

## Verify

```sh
npm run check
npm run test:core
node --test tools/infra/test/*.test.mjs
```

The core test exercises four separate authenticated HTTP sessions and the stale-to-booked flow. It does not prove four browser UIs or a deployed service. The infrastructure test exercises a synthetic localhost SSE server. Provider adapter tests use controlled responses, not live sponsor credentials.

## Ownership and limitations

- `packages/domain` owns validated constraints, merchant mutation schema, deterministic feasibility, equal shares, proposal hashes and shared frontend DTO types. The frontend imports its types from this package.
- `packages/server` owns sessions, authenticated API routes, room/proposal state and the local simulated booking flow. It binds the merchant and SSE adapters from `packages/integrations`.
- `packages/integrations` contains provider and merchant transports. Optional sponsor services stay unavailable until configured and proven live.
- `deploy` contains a Vultr-ready template, not an actual deployment. It requires a real integrated image, `MONGODB_URI`/`ACCORD_ENCRYPTION_KEY`, host and DNS before a production claim. Without Mongo configured the API reports `UNCONFIGURED` and deliberately fails the deployment readiness gate.

Operational state is Mongo-backed when configured; it is still a single-process coordinator (SSE fan-out and the working copy are process-local), so do not run multiple replicas. Visa/payment is simulated; Backboard, Tiger, Solana and ElevenLabs are not wired to live services. Gemini intake can be configured with `GEMINI_API_KEY` and `GEMINI_MODEL`, but no real call has been made here. See [sponsor evidence](SPONSOR_EVIDENCE.md) for exact claim status.
