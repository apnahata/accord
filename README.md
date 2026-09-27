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

## Planning where and when

By default a new group starts with "Help us decide where and when". The host only names the group; they answer the same private questions as everyone else and have no say over dates, length or region. Accord then plans the trip itself (`packages/server/src/planner.ts`):

1. **Everyone answers privately.** Alongside budget, refund and accessibility needs, each member's intake asks when they're free (required, within the next six months), how many nights they'd like, where they're leaving from, what kind of trip they want (beach, mountains, ski, city, nature, theme parks, lake) and any places they'd love or want to avoid. These answers are sealed with the rest of their constraints. The group view shows only how many have answered and, once at least two have, anonymous style totals.
2. **Accord picks the length and dates.** The trip is as long as most people asked for (a tie goes to the shorter trip; three nights if nobody said). It scans everyone's availability for up to two non-overlapping windows everyone is free for. If none fits at that length, it tries shorter trips (down to two nights) before asking anyone to move. If one person's dates are still the only blocker, they get a private "I can make Nov 8–11" / "Keep my dates" message, like a budget nudge.
3. **Accord picks destinations.** With Gemini configured, it suggests three places using anonymous inputs only: style counts, place ideas, sorted departure places, the windows, nights and guest count. No names, budgets or who-said-what are sent. Otherwise, a built-in catalog of 24 US destinations is ranked by style fit, with penalties for repeating the same style or state and with season rules (for example, no ski pitches outside the season, and no northern beach or lake pitches outside summer); it looks only in one part of the country when every departure it recognizes is there. Any place a member asked to avoid, or a city someone is leaving from, is dropped deterministically, whatever the model says.
4. **Accord builds a shortlist.** It searches stays for each destination in each date window (at most six searches), keeps the best stay that fits every confirmed requirement at each destination, and orders the options by how many people each one fits.
5. **The group votes privately.** Each member sees the options with plain reasons ("Fits the beach picks of 3 of 4 people", "Everyone is free Nov 8–11") and votes. Ballots are sealed at rest, and totals stay hidden until voting closes, either when everyone has voted or after 24 hours. Ties go to the better fit. If only one option works, it is chosen without a vote. If none works, Accord sends private nudges and tells the group it's waiting.
6. **The winner becomes the trip.** Accord proposes the winning stay, and the usual approval, watch, replan and booking flow takes over. The host can reopen planning. If anyone changes their answers before a decision, Accord replans.

Planning rooms with "Use Accord's rehearsal stays" (preselected without live keys) use generated, deterministic demo stays at three price and refund tiers in each destination, so the whole flow can be rehearsed offline. Payments for those stays are simulated. Without the rehearsal toggle, Accord searches Nuitée Connect and Google Hotels in each destination's own time zone, then uses the same shared sandbox payment as any other live group.

## Accord as coordinator

Accord acts on its own between human decisions (`packages/server/src/coordinator.ts`), and narrates what it did in the group timeline with an "Accord" badge:

- **Searches when the group is ready.** Once every member has confirmed, it runs the search and proposes the best shared fit. "Search now" remains as a manual override.
- **Replans when consent goes stale.** A price or terms change, an expired offer, or a member leaving cancels approvals; Accord privately tells each affected member why (only their own limit, never anyone else's) and proposes the next option.
- **Asks privately when nothing fits.** If an option is blocked by exactly one member on exactly one budget, refund or check-out requirement (a budget within 20%), only that member gets a private message such as "Tampa works for everyone except your budget: $280.00, which is $10.00 over your $270.00 limit", with "Raise my limit" / "Keep my limit". Accessibility needs are never offered for renegotiation. Keeping a limit is remembered; the group only hears that Accord "privately checked in with some members".
- **Widens a live search.** With trip details and Gemini configured, when no stay works Accord asks Gemini for up to two nearby areas (from the destination, dates, guest count and anonymous failure counts only — no limits, names or preferences), searches them, and re-solves. Gemini picks places to look; the deterministic solver still decides what fits.
- **Watches an open proposal.** Every couple of minutes it re-quotes LiteAPI offers or re-checks demo offers (a change stales consent), sends one gentle reminder to members who haven't approved, warns once before the offer expires, and replans when it lapses. Google vacation rentals can't be re-quoted and say so.
- **Executes after unanimous approval.** Once each member explicitly approves the exact proposal and contribution, the live-trip flow creates one shared CyberSource sandbox authorization, re-quotes and books the exact Nuitée sandbox rate, then captures the same shared payment. A failed step remains resumable and does not claim success.

It never approves on a member's behalf or changes anyone's requirements; a nudge only changes a limit when that member presses the button. Private messages are delivered on the member's own event stream and sealed at rest like constraints. Set `ACCORD_AUTOPILOT=off` to disable automatic search and replanning.

## Live stay search

When the host creates a group with trip details (destination, dates, guests), Accord searches real inventory instead of the demo catalog:

- **Nuitée Connect / LiteAPI** (`LITEAPI_KEY`): hotels with live rates, refundability, occupancy, check-out times, facilities, review analysis and nearby places. Booking re-quotes the approved room first; a detected price or terms change stales consent instead of booking. This build accepts only sandbox keys (`sand_…` or `sandbox_…`) and pairs sandbox reservations with CyberSource sandbox payment.
- **SerpApi Google Hotels** (`SERPAPI_KEY`, optional): vacation rentals with prices, free-cancellation dates, capacity and amenities. These are search-only: once everyone approves, the host is handed off to the listing site. Rentals without a public HTTPS handoff link are excluded. Results are cached for 30 minutes per group to save search credits; omit this key for a Nuitée-only flow.

Provider data is mapped conservatively into the domain `Offer`: missing accessibility evidence is *unknown* (never a pass), a closed or missing refund window is non-refundable, and check-out times come from the listing. Feasibility, ranking and consent stay deterministic in `@accord/domain`; Gemini only writes an optional public summary from listing facts. For a fixed trip, times are interpreted in `America/New_York`, so destinations should be US East Coast cities for now. Destinations Accord plans itself carry their own time zone. A member may leave a group at any time, which stales any proposal because everyone's equal share changes. Groups created without trip details keep using the controlled demo catalog (and the automated flow tests use it).

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

The core tests exercise four separate authenticated HTTP sessions, the stale-to-booked flow, a multi-turn intake with a fake model response, and the coordinator (automatic search and replan, private nudges with accept/keep, the watch loop, and widening with a stubbed provider and model), and trip planning (date overlap, private date nudges, seasonal destination ranking, anonymous Gemini input, private voting, the deadline close, and reopening). With `MONGODB_URI` set, they also check that an open vote survives a restart with ballots sealed. They do not prove four browser UIs, a live model, or a deployed service. The infrastructure test exercises a synthetic localhost SSE server. Provider adapter tests use controlled responses, not live sponsor credentials.

For a live Gemini intake smoke test, set `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-3.5-flash-lite` in the gitignored root `.env`, then run `npm run verify:gemini -- --record`. It calls Gemini through the local Accord API with synthetic member text, checks the review draft and no-save-before-confirmation rule, and writes a sanitized result to `sponsor-evidence/gemini-live-smoke.json`. A provider error or incorrect draft makes the command fail.

After the group searches, members can ask Gemini to explain the backend-selected feasible stay using public facts only. On an exact proposal, each member can request a separate explanation of only their own deterministic checks. Gemini chooses and orders verified facts; it never changes feasibility, ranking, approval, or booking permission. These calls are optional and return `AI_UNAVAILABLE` if the provider fails. Run `npm run verify:explanations -- --record` with the same local Gemini configuration to exercise both live routes with synthetic members and save a sanitized privacy check.

## Ownership and limitations

- `packages/domain` owns validated constraints, merchant mutation schema, deterministic feasibility, equal shares, proposal hashes and shared frontend DTO types. The frontend imports its types from this package.
- `packages/server` owns accounts, sessions, authenticated API routes, room/proposal state, the shared payment ledger, and sandbox booking orchestration. It binds the merchant and SSE adapters from `packages/integrations`.
- `packages/integrations` contains provider and merchant transports. Optional sponsor services stay unavailable until configured and proven live.
- `deploy` contains a Vultr-ready template, not an actual deployment. It requires a real integrated image, `MONGODB_URI`/`ACCORD_ENCRYPTION_KEY`, host and DNS before a production claim. Without Mongo configured the API reports `UNCONFIGURED` and deliberately fails the deployment readiness gate.

Operational state is Mongo-backed when configured; it is still a single-process coordinator (SSE fan-out and the working copy are process-local), so do not run multiple replicas. CyberSource and the shared funding card are sandbox-only, so no real money moves. Nuitée bookings are sandbox reservations, so no real-world room is reserved. Tiger-backed telemetry and Pulse are available only when `TIGER_DATABASE_URL` is configured; Backboard, Solana and ElevenLabs are not live integrations. Gemini intake has been verified live with `gemini-3.5-flash-lite`, but Gemini never decides feasibility or grants payment permission. Run `node --env-file=.env --import tsx tools/verify-live-stays.mjs --record` to repeat the live provider test; it creates a new sandbox booking. See [sponsor evidence](SPONSOR_EVIDENCE.md) for exact proof and limits.
