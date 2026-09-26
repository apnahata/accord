# ACCORD
## Final master product, engineering, sponsor, and demo brief

**Status:** Agreed build specification for HackGT 13, September 25–27, 2026.  
**Project name:** Accord — no separately branded “Accord Trips” or “Accord Core.”  
**First demonstrated use case:** A group booking shared accommodation for a trip.  
**Source of truth:** This file supersedes earlier AI brainstorms and the previous *ACCORD TRIPS* master brief when they conflict.

> **Accord helps groups plan and purchase things together, while keeping everyone's personal boundaries private.**
>
> **Plan together. Pay together. Keep your boundaries private.**

This is an implementation brief, not a claim that any payment, security, or sponsor integration is already functioning. Use the supported feature list and the actual demo to make claims. Do not call simulated payments real transactions.

## 0. Decision hierarchy and frozen choices

When implementation decisions conflict, prioritize: (1) correct individual consent and purchasing behavior; (2) privacy between members; (3) a complete, repeatable end-to-end experience; (4) deterministic feasibility; (5) meaningful agent autonomy; (6) authentic sponsor integrations; (7) polish.

The team has settled these points:

- **One product:** Accord. Travel is the first example; there is no separate consumer/developer product branding.
- **Equal split only for v0:** Each active payer owes an equal share of the shared purchase, with cent-level remainder handling. No subsidy capacity, unequal allocations, “fairness-aware” allocation optimizer, or automatic redistribution.
- **Every active payer must consent and authorize:** No 3-of-4 threshold for buying for four people. Voting can inform earlier discovery, but never authorizes another person's contribution.
- **Private constraints stay private from other members:** Accord's backend may process them; the prototype is not zero-knowledge, anonymous, or private from its own operator/model provider.
- **An approval is tied to one immutable proposal snapshot:** Price increases, contribution changes, worse cancellation terms, product/merchant changes, member changes, and other material changes require a new proposal and fresh approval.
- **Actual buying is limited by integrations:** The MVP simulates group funding and booking through a controlled merchant. A genuinely functioning provider sandbox may be added if available; no false “Visa processed this” claim.
- **Sponsor coverage is intentional:** Pursue all genuinely eligible categories with working features and proof, without letting any one external API block the core loop.
- **Open source means usable code:** The repository includes the app and its reusable coordination/consent logic. Self-hosting and integration are part of the same Accord project, not new brands.

---

# PART I — PRODUCT

## 1. The product in one sentence

**Accord is an AI group-purchasing coordinator that privately understands each participant's limits and preferences, finds options acceptable to everyone, gathers individual approval of an exact offer, and coordinates the shared purchase.**

When an offer changes, Accord does not assume old agreement carries forward. It checks the new terms, stops execution when the authorization is stale, and proposes a new acceptable option.

## 2. The problem we solve

Group purchases create work before anyone pays. Friends disagree about what is affordable, suitable, accessible, or cancellable. The person organizing the purchase has to collect preferences, compare options, handle awkward conversations, collect approvals, front costs or track payments, and react when the merchant changes something. People may not want to explain their budget, accessibility needs, personal schedule, or reason for saying no to the whole group.

A group chat handles discussion; a bill splitter handles reimbursement. Neither establishes that a **particular shared purchase satisfies everybody's private hard requirements and has been individually authorized**.

The memorable framing: *Group travel looks like a search problem, but the difficult part is private negotiation and trustworthy group checkout.*

## 3. Product scope and long-term vision

Users interact with **Accord**, not with an ecosystem of similarly named products. One person creates a group and invites others. Each person tells Accord what works privately. Accord searches, coordinates, proposes, seeks agreement, and purchases using supported integrations.

Travel is a tangible first demonstration. Later applications could include event tickets, shared household purchases, student-organization purchases, group gifts, and team procurement. These are future possibilities, not HackGT deliverables. Similarly, a documented API/MCP interface and self-hostable deployment are properties of Accord, not separate products.

**Not building:** a generic chat itinerary planner, social feed, OTA, card issuer, real escrow provider, universal website shopping bot, real airline ticketing, cryptocurrency custody app, or production-ready regulated payment service.

## 4. User journey — one fluid experience

1. **Create group:** A person enters a shared purchasing goal and invites friends by link/QR.
2. **Private intake:** Each member confirms their hard requirements, maximum personal contribution, and soft preferences. Structured fields are the default; AI handles natural language/voice ambiguities.
3. **Explore:** Accord searches supported offers, deterministically checks all private hard constraints, calculates the equal share, and presents eligible options without exposing which member constrained the result.
4. **Coordinate:** Members ask for alternatives or clarify their own preferences privately. Accord searches or revises the proposal; no silent relaxation of hard requirements.
5. **Agree:** Each active payer reviews an exact immutable offer and their exact contribution.
6. **Authorize:** Each payer explicitly authorizes their own simulated contribution for that version. Approval and financial authorization are separate backend records even if combined in one clear UI interaction.
7. **Preflight and purchase:** Accord rechecks current merchant terms and inventory, compares the approved snapshot, and executes the supported checkout/booking flow only if all conditions hold.
8. **Recover:** If the merchant changes price, terms, inventory, or booking details, Accord invalidates stale approvals/authorizations, privately explains relevant failures, replans, and seeks fresh agreement.

## 5. Canonical demonstration: four friends, one shared stay

Use **exactly these four names and facts** in seeded data, API tests, screenshots, pitch, and documentation. The four people are booking *shared accommodation*, not a bundle of individually priced flights.

| Person | Private hard requirements | Soft preference |
|---|---|---|
| Alex | Maximum contribution **$350** | Lowest reasonable price |
| Priya | Maximum contribution **$450**; stay must end by **Sunday, March 14, 2027, at noon** | Walkable neighborhood |
| Jordan | Maximum contribution **$450**; **full cash refund** available under the specified cancellation policy | Near activities |
| Mateo | Maximum contribution **$450**; **verified step-free accommodation/access** and capacity for four | Quiet property |

All members have a confirmed private cap. The original $300 equal share fits all four; the merchant-change $360 share exceeds Alex's $350 cap. The underlying reason for Priya's departure time or Mateo's accessibility requirement is never required or displayed to the group. The service should never infer diagnoses or motivations.

**Original approved offer: Miami shared apartment, March 10–14, 2027 (four nights).** Capacity four, verified step-free access, permitted checkout before Sunday noon, full refund until March 1, 2027. Final total **$1,200, all mandatory fees included**; equal contribution **$300 each**. This is a controlled demo listing, not a verified real-world rental.

**Merchant mutation:** Raise the total to **$1,440** (**$360 each**) *and/or* replace full refund with travel credit. The increased share violates Alex's $350 private cap; credit-only terms violate Jordan's requirement. Regardless, nobody authorized $360 or the changed terms. Mark the old version stale, cancel/release simulated authorizations appropriately, and do not book.

**Replanned option:** Tampa shared apartment on the same dates, capacity four, verified step-free access, full refund, total **$1,120**, equal contribution **$280 each**. Create a new version, gather four fresh authorizations, preflight, and finish one simulated booking with a receipt.

### Canonical arithmetic

- Miami original: $1,200.00 ÷ 4 = $300.00 per person.
- Miami changed: $1,440.00 ÷ 4 = $360.00 per person.
- Tampa alternative: $1,120.00 ÷ 4 = $280.00 per person.
- For totals not divisible by four cents, use integer cents and a deterministic remainder rule visible in the consent screen; no sum may be lost or created.

## 6. Contribution policy — equal means equal

The booking consists of one shared cost with a defined set of active payers. For each candidate, compute the equal share from the **final total including mandatory fees**. The offer is infeasible if *any* member's private maximum is below their share. Never let a model “helpfully” allocate the shortfall to someone else.

No voluntary subsidy UI, capacity, optimization objective, cap-aware redistribution, different planned contributions, or public individual payment amounts in v0. The group sees the total and equal share; that means the share is inferable. **Private maximum budgets remain hidden; the equal share itself is not secret.**

If a participant leaves, change the member set, recompute shares, create a new proposal version, and require the remaining participants to approve again. No charge to a departed member.

## 7. Consent rules — one actual purchase, four actual decisions

Early preference voting and final spending consent are different. The group may vote on destination or shortlist, but **booking requires approval and individual payment authorization from every included paying participant**. The system cannot book for a person who declined, is pending, or has been removed.

The consent screen must present: proposal ID/version, property/room, guest count, dates, total price including fees, each user's exact share, cancellation/refund terms, relevant accessibility/booking assertions, merchant/offer identity, expiration, and any material conditions. The user approves **that snapshot**, not a generic request to “go to Miami.”

A single “Approve and authorize” UI button is acceptable if it unambiguously states the amount and proposal. Store separately:

- `approval`: member identity, proposal ID/version/hash, affirmative user action, timestamp.
- `paymentAuthorization`: member identity, exact amount/currency, proposal hash, provider/simulator reference, status, expiry.

A person's private maximum contribution is a feasibility boundary, **not** a standing authorization to spend up to that amount.

## 8. Merchant changes and stale consent

A material change requires a fresh proposal. Default v0 policy: **any increase in a payer's share**, a new mandatory fee, property/room or supplier change, date/time or capacity/accessibility change, worse refund/cancellation terms, change of included payers, or offer expiration invalidates prior authorization. Never let an LLM decide whether a change is “close enough.”

No need for arbitrary “+$25 is acceptable” controls. If price decreases with no other material change, do not silently alter the amount or capture more than authorized; either use an explicit, safely defined lower-amount policy or re-propose. For v0, **re-propose for any price change** to keep the contract auditable.

A non-material metadata change, such as refreshed imagery without changing the offer, may be whitelisted in deterministic code. Do not blanket-invalidate on changes irrelevant to the consent snapshot.

### The signature moment

The judge clicks “Increase price” or “Change cancellation policy.” Accord shows **CONSENT STALE — this is no longer the offer you approved**. The public group screen gives a neutral explanation. Affected members get private reasons. Accord searches a replacement and seeks all four fresh authorizations. The unchanged old approval must not book the new version.

## 9. Privacy promises and limitations

**Threat model:** Group members must not retrieve one another's budget caps, hard-requirement details, explanations, personal payment method, or private chat. The Accord backend may decrypt/process those fields, and the selected model provider may process content submitted to it. The prototype does not claim platform-private computation, zero-knowledge, anonymity, or immunity to inference.

- Keep private records encrypted at application level where implemented; keys remain server-side. Never place secrets in client bundles or version control.
- Public endpoints use **explicit allowlisted response schemas**—never serialize a database document and remove fields afterward.
- Private endpoints bind the authenticated session to its member ID; reject a request for somebody else's record regardless of supplied URL parameters.
- Public explanations include aggregate feasibility but not the person or exact private boundary behind a failure.
- Don't show private preference matrices on public screens. Synthetic/demo-admin inspection, behind separate access, may show everything for judging and debugging.
- Avoid highly specific public compromise suggestions that identify a single member's hidden requirement. Privately ask only relevant users whether they *want* to reconsider; never pressure or auto-relax.
- Aggregate yes/no responses can still leak information via repeated probing. Limit arbitrary probing and don't promise absolute confidentiality.
- On-chain data never contains budgets, accessibility needs, payment credentials, personal reasons, or raw private-constraint hashes susceptible to guessing.

Safe claim: **member-private coordination with explicit access boundaries and encrypted stored capsules** (only if encryption is actually implemented).

---

# PART II — WHAT THE AI AND SYSTEM ACTUALLY DO

## 10. Meaningful agent autonomy

Accord feels like one agent. Implementation can use a central coordinator and isolated **per-member contexts/evaluators** rather than forcing four independently hosted model processes. The meaningful behavior is that Accord remembers and works with each member's private requirements, asks targeted clarifying questions, searches options, identifies blockers without attributing them, requests voluntary changes privately, and replans after external events.

The AI must do more than paraphrase a fixed form or animate a predetermined recommendation. Judges should be able to alter a budget or a requirement and see a different result. “Multi-agent” is an implementation description, not a claim to make unless private member contexts and coordinator interactions actually run.

### AI owns

- Natural-language/optional voice-to-structured intake.
- Identifying ambiguity and asking the smallest necessary follow-up.
- Generating candidate search queries and comparing *feasible* offers.
- Explaining group-visible tradeoffs from allowlisted nonprivate inputs.
- Giving members private explanations and optional private renegotiation prompts.
- Triggering search/replanning in response to deterministic state changes.
- Optional remembered preferences via Backboard, always reconfirmed for the current purchase.

### Deterministic code owns

- Money arithmetic, hard-constraint satisfaction, equal split, member set, voting/authorization state, proposal hashing, material-diff checks, expiry, final preflight, execution permission, idempotency, payment/booking status, and private/public authorization.

**The LLM never authorizes spending, waives hard constraints, grants itself a permission, decides who pays more, or reveals private requirements.** Validate every structured output using schema checks and require user confirmation of extracted hard constraints.

## 11. Feasibility algorithm

For every candidate supported offer:

1. Verify current availability, capacity, dated terms, supplier evidence, and all-in price.
2. Compute each member's equal share in integer currency units.
3. Evaluate each active member's confirmed budget cap, stay dates, refund requirement, accessibility requirement, and other supported hard conditions against reliable structured merchant data.
4. Reject an offer if any hard requirement or group policy fails. Missing evidence for a mandatory condition means **unknown/unverified**, not pass.
5. For feasible options only, rank soft preferences and group-visible features. An offer cannot score its way around a hard requirement.
6. Return public feasibility and neutral tradeoffs. Return personal reasons only to the relevant member.

A simple deterministic TypeScript implementation is sufficient for v0 equal-split accommodation. OR-Tools/Python can be used if actually needed for richer travel optimization, but is not an architectural prerequisite or independent product.

```ts
function equalShares(totalCents: number, memberIds: string[]) {
  const ids = [...memberIds].sort();
  const base = Math.floor(totalCents / ids.length);
  const remainder = totalCents % ids.length;
  return Object.fromEntries(ids.map((id, i) => [id, base + (i < remainder ? 1 : 0)]));
}
```

Use a stable ordering and show each person's *exact* computed amount before approval. Never use floating-point dollars to decide whether a cap is exceeded.

## 12. Negotiation and no-solution behavior

When no supported offer meets every boundary, the public group sees: “No current option satisfies everyone's confirmed requirements. Accord is exploring alternatives and has privately contacted relevant members.” It does **not** reveal whose constraint failed or a uniquely identifying private change suggestion.

Each member can privately opt to adjust their own preferences or keep them unchanged. Hard constraints never change without an explicit action by that member. An updated member capsule invalidates any proposal relying on the previous capsule and starts a new solve. The system should also search different dates or locations that respect confirmed constraints rather than immediately pressuring people to spend more.

## 13. Merchant evidence and limits

The MVP uses a controlled catalogue of **8–12 synthetic accommodations** with explicit structured fields: `offerId`, `offerVersion`, dates, occupancy, accessibility evidence flag, cancellation code/date, final price, mandatory fees, availability, deadline, and merchant identity. Fixtures may be realistic, but must be visibly labeled demo inventory.

The merchant simulator exposes deterministic events: increase price, change cancellation policy, change room or capacity, sell out, add fee, restore offer, fail booking. Events should update the merchant's own versioned offer rather than only changing a frontend label.

An agent's text summary cannot establish that a property is accessible or refundable. Check merchant/source fields. For a real future integration, “verified” must mean evidence from the actual supplier or a trustworthy verifier; our seed fixtures only simulate this evidence.

---

# PART III — SYSTEM AND DATA CONTRACTS

## 14. One architecture, one product

```text
Users on phones/browser (public group view + private member view)
                 |
           Accord web app
                 |
       Accord coordinator/API  [Vultr]
         /       |          \
    AI intake  Feasibility   Merchant adapter
    + memory  + consent     + payment adapter
         \       |          /
       MongoDB Atlas = current operational state
       Tiger Data = historical event stream / temporal features
       Solana devnet = public proposal-version commitments
```

All are implementation components of Accord. No separate branded subproducts. The core demo must work with an in-memory/mock fallback if a sponsor integration is unavailable; published claims must distinguish real integrations from fallback behavior.

## 15. Canonical domain entities

`User`, `Room`, `Member`, `PrivateConstraintCapsule`, `PublicGroupPolicy`, `MerchantOffer`, `OfferSnapshot`, `Proposal`, `ProposalDiff`, `MemberApproval`, `PaymentAuthorization`, `Booking`, `MerchantEvent`, `AuditEvent`, `SolanaCommitment`.

Minimum contracts:

```ts
type Money = { amountCents: number; currency: "USD" };

type PrivateConstraints = {
  memberId: string;
  maxContributionCents: number;
  latestCheckOutAt?: string;
  requiresFullCashRefund?: boolean;
  requiresStepFreeAccess?: boolean;
  hardRequirements: Array<{ kind: string; value: unknown }>;
  softPreferences: Array<{ kind: string; weight: number; value: unknown }>;
  confirmedAt: string;
  version: number;
};

type OfferSnapshot = {
  offerId: string;
  offerVersion: string;
  merchantId: string;
  propertyId: string;
  roomType: string;
  checkInAt: string;
  checkOutAt: string;
  guestCapacity: number;
  stepFreeVerified: boolean | null;
  cancellationPolicyCode: string;
  fullRefundDeadline?: string;
  mandatoryFeesCents: number;
  totalCents: number;
  currency: "USD";
  available: boolean;
  expiresAt: string;
};

type ProposalSnapshot = {
  roomId: string;
  proposalId: string;
  version: number;
  memberIds: string[]; // canonical order
  offer: OfferSnapshot;
  contributionsCents: Record<string, number>;
  privateCapsuleVersions: Record<string, number>;
  createdAt: string;
  expiresAt: string;
};

type MemberApproval = {
  memberId: string;
  proposalId: string;
  proposalHash: string;
  approvedAt: string;
  status: "APPROVED" | "INVALIDATED";
};

type PaymentAuthorization = {
  memberId: string;
  proposalHash: string;
  amountCents: number;
  currency: "USD";
  status: "PENDING" | "AUTHORIZED" | "INVALIDATED" | "CAPTURED" | "RELEASED" | "FAILED";
  providerRef?: string;
};
```

These are proposed implementation contracts, not publicly shipped API definitions. Keep monetary and version fields immutable after approval. New terms create new objects/versions; never overwrite an approved snapshot in place.

## 16. Canonical hash and recorded consent

Define a deterministic serialization scheme for the immutable proposal. Sort member IDs, stabilize object fields, normalize currency in cents and timestamps, and hash the canonical bytes (`SHA-256`). Include quote identity, merchant version, group membership, booking details, and member contribution amounts. Do not rely on arbitrary JS object key ordering.

The consent record references `proposalHash` plus the authenticated member. An old hash cannot represent a new quote. Hashing alone is not user consent; the user must actually approve the displayed content and the server must bind their authenticated action to that hash.

Solana may record proposal/version/hash and nonprivate event metadata. If each person signs with a wallet, show genuine signature verification. If the server posts an event on their behalf, describe it as an **operator-recorded on-chain commitment**, not a cryptographic signature by that traveler. Hashes do not encrypt private data.

## 17. State machine and safety conditions

Keep separate state machines for proposal, member approval, simulated funding, and booking. Suggested statuses:

```ts
type ProposalState = "OPEN" | "READY" | "STALE" | "BOOKED" | "CANCELLED";
type BookingState = "NOT_STARTED" | "PROCESSING" | "CONFIRMED" | "FAILED" | "UNCERTAIN";
```

An executable proposal must satisfy every check **on the server**:

```text
current immutable proposal exists
AND membership/capsule versions match
AND all active hard constraints still pass
AND every active payer approved the same proposal hash
AND every active payer authorized the exact recorded share
AND sum(authorized shares) equals final all-in price
AND proposal is unexpired, available, and not stale
AND current merchant quote matches the approved material snapshot
AND the booking idempotency key has not completed a different purchase
```

If any check fails, **do not execute**. A mere “4/4 authorized” frontend badge is not a security gate.

## 18. Merchant preflight and race conditions

Right before the booking request, retrieve the merchant's current offer, compare all material fields to the frozen snapshot, and verify expiry and inventory. The mock merchant should atomically check its offer version and reserve/execute under a single guarded operation; otherwise price can change *between* preflight and execution. For a real provider, the relevant quote/hold/conditional checkout semantics determine the guarantee. Do not claim that a preflight check alone eliminates all real-world races.

If the provider returns an uncertain outcome, do not blindly retry the charge. Use a stable idempotency key per proposal purchase and reconcile provider status/events where supported. Only show `CONFIRMED` when the mock/provider confirms the booking.

## 19. APIs and access boundaries

Example route families (final naming up to the team, contracts must be shared before parallel coding):

```text
POST /api/rooms                        create group
POST /api/rooms/:id/join               join with member session
GET  /api/rooms/:id                    public/group summary only
POST /api/rooms/:id/me/constraints     private confirmed capsule
GET  /api/rooms/:id/me/constraints     authenticated member only
POST /api/rooms/:id/solve              create feasible options
GET  /api/proposals/:id/public         explicit public DTO only
GET  /api/proposals/:id/me             member-specific private DTO
POST /api/proposals/:id/approve        bound to authenticated member + hash
POST /api/proposals/:id/authorize      simulated/provider authorization
POST /api/proposals/:id/execute        server-gated, idempotent
POST /api/merchant/events              authenticated demo/admin only
GET  /api/rooms/:id/events             appropriately filtered timeline
POST /api/demo/reset                   admin-protected demo only
```

Never trust `memberId` submitted by a client to override the member attached to its session. Restrict demo mutation/reset endpoints. The global admin display must not be publicly exposed as ordinary group UI.

## 20. Data, encryption, and integration responsibilities

**MongoDB Atlas:** Operational source of truth for rooms, members, encrypted private capsules, current offers, proposals, approvals, authorizations, and booking state. Use appropriate indexes and atomic/CAS transitions so concurrent events cannot reuse consent.

**Tiger Data:** Append-only/time-series merchant and consent events. Store event time, room, proposal, offer, type, old/new public state, and processing latency. Use temporal queries to calculate observed offer-change frequency and a *demo-data* stability indicator. Do not claim statistically meaningful real-market volatility from a handful of synthetic events. Ranking may account for observed stability after hard feasibility is established.

**Vultr:** Host Accord's live coordinator/API, merchant events, and realtime updates. The deployed app must be usable by different participants on separate devices.

**Solana devnet:** Record externally inspectable nonprivate proposal-version commitments and state transitions. Display a genuine explorer transaction link if successful. Never publish individual constraints or raw payment data. User signatures are optional and must be accurately described.

**Backboard:** Remember user-approved, reusable preferences across sessions; ask before applying them to a new trip. Never import an old preference as a binding financial consent or hard requirement without confirmation.

**ElevenLabs:** If integrated, transcribe a private voice preference or guide spoken intake. Confirm the structured interpretation before use. Handle voice data under the same private access rules.

**Visa:** The experience addresses AI discovery, personalization, decision-making, shared purchase authorization, and checkout. Actual Visa Intelligent Commerce capability may require separate eligibility/credentials. Implement a payment adapter that works in clearly labeled simulation mode; upgrade only for genuinely accessible operations. Do not fabricate logos, credentials, sandbox success, captures, or Visa sponsorship/endorsement.

## 21. Payment and refund simulation

Model four conditional simulated contribution authorizations followed by one simulated merchant booking. Be explicit that authorizations represent demo commitments, not real card holds or an atomic multi-card hotel payment. The booking succeeds only if the group is fully authorized and the merchant accepts the unchanged quote. Record a simulated receipt.

A cancelled or stale proposal releases/invalidates simulated authorizations. If a confirmed simulated booking is cancelled, a **separate** refund simulation may allocate the refund equally to the four actual paid contributions, subject to the confirmed refund terms. This is optional after the main loop works. Do not describe the flow as escrow or a real bank/card settlement.

---

# PART IV — SPONSOR PLAN (ONE PRODUCT, MULTIPLE AUTHENTIC SUBMISSIONS)

## 22. Sponsor strategy and proof requirements

We deliberately want to pursue every **genuinely eligible** category. A sponsor technology earns its place through one meaningful, testable feature in Accord; judge-specific demo evidence may be recorded separately. **Eligibility and private sponsor resources must be reconfirmed in HackGT's current portal/Discord and at the sponsor booth.** Do not assert that a general sandbox account grants restricted VIC access.

| Sponsor/category | What Accord demonstrates | Minimum proof to capture |
|---|---|---|
| **Visa — primary challenge** | AI-powered group discovery → private decision coordination → exact per-member authorization → trusted conditional checkout | Continuous purchase demo; clarify whether actual Visa API integration is required; label simulation |
| **Oracle of the Deep — main track** | Meaningful AI intake, private-context coordination, constraints, replan | Live variation of input changes different feasible result; honest explanation of deterministic engine |
| **Meta** | Helps friends make shared plans without exposing sensitive personal/financial reasons | Demonstrate human connection, genuine group interaction, public code and required short video |
| **Solana** | Proposal/version commitment and honest approval provenance | Devnet transaction ID/link, hash before/after mutation |
| **MongoDB Atlas** | Current operational application documents | Genuine reads/writes and member-private access demo |
| **Tiger Data** | Temporal offers/consent changes and observed stability signal | Populated event data, query/feature influencing UI or ranking |
| **Vultr** | Live deployed coordinator and merchant event processing | Deployed service and real-time multi-browser interaction |
| **backboard.io** | Persistent private preference recall, confirmed on reuse | Old session → new session → review/apply preference |
| **ElevenLabs** | Real private voice intake, not synthetic button labels | Actual speech → transcription → confirmed constraint |
| **.tech** | Public Accord domain | Live domain and required registration/use evidence |
| **Notability** | Genuine process use during hackathon | Required screenshots of notes/flows at creation time |
| **SpaceXAI (Cursor/Grok)** | Only if the required Grok/Cursor integration and societal-impact framing are genuinely met | Running integration and challenge-specific demonstration |
| **Other MLH technology prizes** | Only where the sponsor's current rules and actual integration fit | Real use and evidence; no superficial dependency |

Do not force NSA, Impiricus, hardware, or other mismatched prompts into Accord. Preserve the team's goal to maximize **eligible** submissions, not to claim every category indiscriminately. The main challenge is Visa; other submissions should reuse the same product and demonstration with different truthful emphasis.

### Visa decision gate

Before relying on a real payment integration, confirm: Which Visa products are granted to HackGT teams? What credentials and merchant test setup are supplied? Is a Visa API required to qualify, or is the generative-AI commerce experience sufficient? Does any supported endpoint handle multi-card/group settlement, or only individual cardholder flows? Until documented, group orchestration belongs to Accord and checkout is simulated.

### Evidence owner

Assign one person early to maintain `SPONSOR_EVIDENCE.md` containing sponsor name, exact rules/links from event resources, implementation status, relevant code path, screenshot/video, transaction/deployment ID, and submission status. Notability screenshots cannot be reliably recreated after the event; record them during the work.

## 23. Solana details and claims

Use a canonical hash of the public proposal and relevant consent snapshot (no private capsule). A light devnet event or memo may be enough for a functional audit demo, but consult the current sponsor's requirements before choosing memo vs a program. A real Anchor state machine is more work. Record `proposalHash`, `version`, event type, and non-sensitive room reference. If old and new hashes differ, the v4 approval does not represent v5. The application database still decides current operational state; the chain does not magically enforce merchant behavior or Visa payments.

## 24. Tiger Data feature

Store offer observations and merchant mutations. Compute a clearly defined, observed stability metric (e.g., number of price/term changes in the seeded observation window) and surface it for comparison/ranking *only after* feasibility checks. In judge mode show the event timeline and reaction latency. Present the results as simulated/demo data, not a predictive claim about real merchants.

## 25. Meta feature and social impact

The product preserves participation by allowing people to state private boundaries without public justification. Show people actually planning together and the agent acting as a confidential intermediary, not replacing interaction with a social feed. Avoid exposing which user is the blocker. If the public result must reveal a shared price, be candid that equal contributions are inferable; the protected information is their private cap, needs, and reasons.

---

# PART V — HACKATHON BUILD PLAN

## 26. Repository and open-source delivery

One GitHub repository called **Accord**. Suggested folders (adapt as needed; don't let folder naming become product branding):

```text
accord/
  app/                        web UI: group, private member, demo merchant console
  src/domain/                 money, feasibility, consent, hashing, state machine
  src/ai/                     structured intake, explanations, coordinator
  src/integrations/           payment mock/Visa, Solana, Tiger, Backboard, voice
  src/data/                   MongoDB and migrations/seeds
  src/server/                 auth, routes, events
  examples/                   repeatable four-member flow
  tests/                      domain, privacy, state transition, integration
  docs/                       architecture, security, integrations, demo
  AGENTS.md                   Codex project guidance
  CLAUDE.md                   Claude Code project guidance
  .env.example
  README.md
  LICENSE
  CONTRIBUTING.md
  SECURITY.md
```

The complete core code should be available under a recognized open-source license (choose explicitly, e.g., Apache-2.0 or MIT). Someone should be able to clone, configure `.env`, seed mock data, and run the demo without an account on a proprietary Accord cloud. Credentials with providers are separate requirements. Don't claim an npm SDK or MCP server exists unless shipped; a documented integration API can follow after the core loop.

## 27. Coding-agent workflow: Codex and Claude Code

**Before parallel implementation:** Commit this file, shared API schemas, the canonical fixture, and tests/contracts. Old brainstorms go in `docs/archive/` labeled nonauthoritative or stay out of the repo. Each coding agent reads `ACCORD_FINAL_MASTER_BRIEF.md` first and must not resurrect subsidies, 3-of-4 checkout, or extra product names.

Work in separate branches/worktrees with file ownership. Do not have two agents edit the same module simultaneously. One teammate owns integration. An agent should deliver scoped changes with run commands, actual test/build results, unresolved blockers, and handoff notes. Use another agent to review changes or generate tests rather than duplicating implementations.

Example opening prompt:

```text
Read ACCORD_FINAL_MASTER_BRIEF.md and the repository contracts.
This is the authoritative Accord spec; older ACCORD TRIPS briefs are archived.
Implement only your assigned subsystem. Preserve equal split, member-private
constraints, unanimous proposal-specific consent, and simulated-payment labels.
Never invent sponsor API access or bypass server-side purchasing checks.
Before coding, state interfaces/files you will own. Then implement, test,
and report exact changes and any dependency for the integrator.
```

Keep `STATUS.md` updated with each feature's owner, branch, actual completion, integration status, demo proof, and blocker. Use a shared demo seed and clock; avoid per-branch assumptions about fixtures.

## 28. Recommended team ownership (four people)

| Owner | Main area | Parallel sponsor responsibility |
|---|---|---|
| Product/UI | Group room, private intake/approval, responsive multi-device demo, demo control UI | Meta experience, .tech, Notability evidence |
| Domain/backend | Auth/privacy, MongoDB, feasibility/equal shares, state machine, immutable snapshots, concurrency | MongoDB proof; integrator/merger |
| AI/merchant | LLM extraction, member contexts, merchant catalogue/mutations, search/replan | Backboard, ElevenLabs, Tiger Data feature |
| Payment/infrastructure | Simulated contribution authorization, booking adapter, idempotency, deployment | Visa access, Solana, Vultr and provider evidence |

Reassign by actual team size. Every person must understand the end-to-end scenario, not just their silo.

## 29. Build sequence and gates

**Gate 0 — Shared contracts:** Lock fixture, schemas, auth assumptions, proposal hash, equal-share rule, offer version, event names, and a single reset path. Set up GitHub, secrets, accounts, credentials, and sponsor evidence sheet.

**Gate 1 — In-memory vertical slice:** Four private members → structured constraints → 8–12 mock listings → feasibility → $300 equal share → explicit approvals/authorizations → merchant mutation → stale status → replan to $280 → successful mock booking. This should work before dependence on external sponsors.

**Gate 2 — Real privacy:** Separate sessions, allowlisted DTOs, private endpoints, authenticated demo controls, encrypted capsules where claimed, negative API tests.

**Gate 3 — Real AI:** Model-driven intake/clarification and dynamic explanations; member-specific renegotiation; deterministic output and human confirmation. No scripted fake agent behavior.

**Gate 4 — Sponsor adapters in parallel:** MongoDB operational state, Solana commitment, Tiger Data events/feature, Vultr deployed service, Backboard preference confirmation, voice, domain, and verified available Visa operations. Add evidence as each goes live.

**Gate 5 — Reliability and submission:** Concurrency/idempotency tests, cross-browser smoke test, recorded demo, public repo/docs, required screenshots/video, Devpost/sponsor-specific submissions.

Integrations should fail gracefully. A broken blockchain RPC, temporal database, or optional voice service must not silently make an unauthorized purchase possible; payment security is fail-closed while noncritical evidence/analytics may queue/retry.

## 30. Demo UI screens and controls

Minimum screens: landing/create room; join; private intake/confirmation; waiting room; group offers; proposal public summary; private approval/payment panel; funding progress; merchant demo console; stale consent/replan; booked receipt and event timeline. Keep it one cohesive design.

Support four browser profiles/devices (not just a tab switch pretending to be separate users). Demo/admin controls require separate access: reset, increase price, worsen refund policy, sell out, change room, trigger booking failure. The main demo should not depend on live inventory or external money movement.

## 31. Tests that must pass

1. The $1,200 booking produces exactly four $300.00 equal shares.
2. A $1,440 booking is infeasible for Alex's $350 cap; the public view does not identify Alex or expose the cap.
3. Credit-only cancellation fails Jordan's private full-refund requirement; only Jordan sees that personal explanation.
4. A nonmember cannot access a room's private records; Alex cannot request Priya's capsule using a different URL/member ID.
5. Unknown accessibility evidence cannot satisfy Mateo's verified-step-free requirement.
6. An LLM output may not overwrite a confirmed hard constraint or authorize payment.
7. Booking is blocked when even one active payer is missing approval or exact-amount authorization.
8. A member leaving changes membership/shares and invalidates the prior proposal.
9. A merchant update creates a new quote/version, invalidates old consent, and cannot be booked with v4 approvals.
10. Preflight rejects changed price, refund policy, room, dates, capacity, availability, or expired offer.
11. Duplicate/concurrent execute requests result in one mock booking, not two.
12. A failed/unknown provider outcome is not presented as confirmed; no blind payment retry.
13. A public DTO never includes private caps, accessibility fields, private notes, payment methods, or personal reasons.
14. Solana commitment for v4 and v5 differs and points to genuine devnet transactions if claimed.
15. Full reset restores fixtures, sessions, mock payments, merchant versions, and deterministic demo outcome.

Automate what is feasible in Vitest/integration tests and run a final manual multi-device rehearsal. Record actual outcomes; don't claim a test was passed just because it exists in this spec.

## 32. Two-to-three-minute demo script

**Opening:** “Four friends want to book a trip. They have different budgets and personal needs, but shouldn't have to explain them in a group chat.” Show an actual private natural-language intake and confirmation.

**Discovery:** Accord evaluates multiple accommodation options against each person's private hard requirements, shows a feasible Miami listing at $1,200/$300 each, and explains public tradeoffs without attributing hidden constraints.

**Agreement:** Four distinct users approve the exact snapshot and authorize their simulated $300 contributions. Show 4/4, proposal hash/version, and optional genuine Solana transaction. Point out that nobody can approve for someone else.

**Judge-controlled disruption:** Merchant changes Miami to $1,440 and/or credit-only cancellation. Show stale status, private reasons on Alex/Jordan views, no booking and no reused authorization.

**Recovery:** Accord generates a feasible Tampa proposal at $1,120/$280 each. All four approve the new version. Merchant preflight matches. One simulated booking confirms and a receipt/event timeline appears.

**Close:** “Accord lets groups reach a private agreement and makes sure an AI never buys a different offer using stale consent.” Mention sponsor technologies only where you can show working evidence.

## 33. Claim discipline and judge answers

- **Why not Splitwise?** That handles reimbursement. Accord addresses whether everyone can agree to and authorize a purchase *before* it happens.
- **Why AI?** Human requirements are ambiguous and change; AI clarifies and coordinates. Deterministic code enforces hard constraints and money rules.
- **Why private?** Members needn't share budget ceilings or personal reasons with their friends. The Accord backend still processes their data.
- **Why blockchain?** It can provide an external record of proposal versions. It does not prove user consent unless the user's actual signature or authenticated approval mechanism is described accurately.
- **Why Tiger Data?** Offers change over time; logged merchant events and observed stability influence how we compare offers.
- **Is payment real?** The group authorization/booking mechanism is implemented with a labeled simulator unless actual sandbox operations are integrated. No real money, multi-card settlement, or travel booking is implied.
- **Can it buy anywhere?** No. The hackathon uses a controlled supplier. Wider merchant support needs explicit integrations.
- **Is this a real startup?** It is a product hypothesis: collaborative purchase coordination with member-private constraints and enforceable multi-person authorization. Open source allows others to inspect, self-host, and extend the same product.

## 34. Success metrics and validation

Instrument: time from room creation to first feasible proposal; time to unanimous agreement; number of candidate offers checked/rejected; number of manual interventions; replan latency after change; stale/unauthorized executions blocked; mock payment duplicate prevention; and whether a private record leaks in public APIs. If time permits, run a small group usability test and clearly state sample size. Do not turn synthetic-demo timings into population-wide savings claims.

## 35. Final shipping standard

The essential loop is:

```text
private requirements
  -> AI understanding and user confirmation
  -> deterministic group feasibility + equal split
  -> one exact proposal + four individual authorizations
  -> current merchant preflight
  -> merchant mutation detected
  -> old consent invalidated, without exposing private reasons
  -> autonomous search/replan
  -> new exact proposal + four fresh authorizations
  -> one confirmed simulated booking
```

**That loop is Accord.** Sponsor features must strengthen or demonstrate the same loop, not produce unrelated mini-apps. A complete, honestly labeled, interactive purchase experience with real privacy/consent checks takes precedence over twenty disconnected API integrations.
