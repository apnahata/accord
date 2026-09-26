# Accord

Accord helps groups plan and purchase a shared stay while keeping each member's personal boundaries private. This checkout contains the React app, one authoritative domain package, the local API, provider adapters, and deployment templates.

## Run the local demo

Requirements: Node 22 and npm. Without `MONGODB_URI` the local API uses process memory, and restarting it resets rooms, sessions, approvals, merchant mutations and bookings. `npm run dev:api` reads a root `.env` file if present (see [MongoDB persistence](#mongodb-persistence)). The unconfigured core demo uses simulated listings and payment authorizations. No external account is required for that flow.

```sh
npm ci
npm run dev:api
```

In a second terminal:

```sh
npm run dev:web
```

Open the Vite URL shown in the terminal. It proxies `/api` to `http://localhost:3000`. Alternatively, run `npm run build` and open `http://localhost:3000`; the API serves the built frontend itself.

Create a group as Alex, open the invite in three separate browser profiles, and join as Priya, Jordan and Mateo. The private intake is conversation-first when Gemini is configured: Accord asks a functional clarification, then shows an unconfirmed draft for review. Without a verified model connection, it says AI is unavailable and opens manual entry. Confirm the brief's private constraints (tick "Use Accord's rehearsal stays" when creating the group; it is preselected when no live search key is configured). As soon as the fourth member confirms, Accord searches on its own and proposes the $1,200 Miami demo stay. All four members approve and authorize their **simulated** $300 shares, and Alex privately gets a "ready to book" note. From Alex's merchant console (linked from the room as a host demo tool), increase Miami to $1,440. Accord cancels every approval, tells Alex privately that the new $360 share exceeds his $350 cap, and a few seconds later proposes the $1,120 Tampa demo stay as Proposal v2 without anyone clicking. Get four fresh $280 authorizations and book once. The receipt clearly says no card was charged and no real accommodation was reserved.

## Accord as coordinator

Accord acts on its own between human decisions (`packages/server/src/coordinator.ts`), and narrates what it did in the group timeline with an "Accord" badge:

- **Searches when the group is ready.** Once every member has confirmed, it runs the search and proposes the best shared fit. "Search now" remains as a manual override.
- **Replans when consent goes stale.** A price or terms change, an expired offer, or a member leaving cancels approvals; Accord privately tells each affected member why (only their own limit, never anyone else's) and proposes the next option.
- **Asks privately when nothing fits.** If an option is blocked by exactly one member on exactly one budget, refund or check-out requirement (a budget within 20%), only that member gets a private message such as "Tampa works for everyone except your budget: $280.00, which is $10.00 over your $270.00 limit", with "Raise my limit" / "Keep my limit". Accessibility needs are never offered for renegotiation. Keeping a limit is remembered; the group only hears that Accord "privately checked in with some members".
- **Widens a live search.** With trip details and Gemini configured, when no stay works Accord asks Gemini for up to two nearby areas (from the destination, dates, guest count and anonymous failure counts only — no limits, names or preferences), searches them, and re-solves. Gemini picks places to look; the deterministic solver still decides what fits.
- **Watches an open proposal.** Every couple of minutes it re-quotes LiteAPI offers or re-checks demo offers (a change stales consent), sends one gentle reminder to members who haven't approved, warns once before the offer expires, and replans when it lapses. Google vacation rentals can't be re-quoted and say so.

It never approves, authorizes, books, or changes anyone's requirements; a nudge only changes a limit when that member presses the button. Private messages are delivered on the member's own event stream and sealed at rest like constraints. Set `ACCORD_AUTOPILOT=off` to go back to fully manual solving.

## Live stay search

When the host creates a group with trip details (destination, dates, guests), Accord searches real inventory instead of the demo catalog:

- **LiteAPI** (`LITEAPI_KEY`): hotels with live rates, refundability, occupancy, check-out times, facilities, review analysis and nearby places. Booking re-quotes the approved room first; a detected price or terms change stales consent instead of booking. This build accepts only sandbox keys (`sand_…` or `sandbox_…`); a production key fails at startup because member payments are still simulated.
- **SerpApi Google Hotels** (`SERPAPI_KEY`): vacation rentals with prices, free-cancellation dates, capacity and amenities. These are search-only: once everyone approves, the host is handed off to the listing site. Rentals without a public HTTPS handoff link are excluded. Results are cached for 30 minutes per group to save search credits.

Provider data is mapped conservatively into the domain `Offer`: missing accessibility evidence is *unknown* (never a pass), a closed or missing refund window is non-refundable, and check-out times come from the listing. Feasibility, ranking and consent stay deterministic in `@accord/domain`; Gemini only writes an optional public summary from listing facts. Times are interpreted in `America/New_York`, so destinations should be US East Coast cities for now. A member may leave a group at any time, which stales any proposal because everyone's equal share changes. Groups created without trip details keep using the controlled demo catalog (and the automated flow tests use it).

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

The core tests exercise four separate authenticated HTTP sessions, the stale-to-booked flow, a multi-turn intake with a fake model response, and the coordinator (automatic search and replan, private nudges with accept/keep, the watch loop, and widening with a stubbed provider and model). They do not prove four browser UIs, a live model, or a deployed service. The infrastructure test exercises a synthetic localhost SSE server. Provider adapter tests use controlled responses, not live sponsor credentials.

For a live Gemini intake smoke test, set `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-3.5-flash-lite` in the gitignored root `.env`, then run `npm run verify:gemini -- --record`. It calls Gemini through the local Accord API with synthetic member text, checks the review draft and no-save-before-confirmation rule, and writes a sanitized result to `sponsor-evidence/gemini-live-smoke.json`. A provider error or incorrect draft makes the command fail.

After the group searches, members can ask Gemini to explain the backend-selected feasible stay using public facts only. On an exact proposal, each member can request a separate explanation of only their own deterministic checks. Gemini chooses and orders verified facts; it never changes feasibility, ranking, approval, or booking permission. These calls are optional and return `AI_UNAVAILABLE` if the provider fails. Run `npm run verify:explanations -- --record` with the same local Gemini configuration to exercise both live routes with synthetic members and save a sanitized privacy check.

## Ownership and limitations

- `packages/domain` owns validated constraints, merchant mutation schema, deterministic feasibility, equal shares, proposal hashes and shared frontend DTO types. The frontend imports its types from this package.
- `packages/server` owns sessions, authenticated API routes, room/proposal state and the local simulated booking flow. It binds the merchant and SSE adapters from `packages/integrations`.
- `packages/integrations` contains provider and merchant transports. Optional sponsor services stay unavailable until configured and proven live.
- `deploy` contains a Vultr-ready template, not an actual deployment. It requires a real integrated image, `MONGODB_URI`/`ACCORD_ENCRYPTION_KEY`, host and DNS before a production claim. Without Mongo configured the API reports `UNCONFIGURED` and deliberately fails the deployment readiness gate.

Operational state is Mongo-backed when configured; it is still a single-process coordinator (SSE fan-out and the working copy are process-local), so do not run multiple replicas. Member contributions are simulated (no card is charged). With provider keys, trip rooms search live inventory; LiteAPI booking uses only its sandbox, while Google Hotels rentals hand off to the listing site. Live local searches and one LiteAPI sandbox booking were verified on 2026-09-26; the sandbox booking was independently retrieved from LiteAPI. The provider-flow tests also use controlled responses. Run `node --env-file=.env --import tsx tools/verify-live-stays.mjs --record` to repeat the live test; it creates a new sandbox booking. Backboard, Tiger, Solana and ElevenLabs are not wired to live services. Live local Gemini intake and explanation calls have been verified with `gemini-3.5-flash-lite`; that does not establish deployed or reliable use. See [sponsor evidence](SPONSOR_EVIDENCE.md) for exact proof and limits.
