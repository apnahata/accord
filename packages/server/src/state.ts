import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  applyMerchantMutation, assessOffer, checkMember, demoCatalog, equalShares, materialOfferEquals,
  MerchantEventSchema, MerchantMutationSchema, OfferSchema, proposalHash, PublicEventSchema, PrivateEventSchema,
  type Constraints, type MerchantEvent, type MerchantMutation, type Offer,
  type PublicRoomDTO, type PublicOfferDTO, type PublicProposalDTO, type ProposalEnvelope,
  type PrivateProposalDTO, type PrivateProposalEnvelope, type OffersDTO, type ReceiptDTO, type AccountDTO, type EventDTO, type PublicChange, type Trip,
  type InboxDTO, type InboxMessageDTO, type NearMiss, type TripPlan, type DateWindow,
} from "@accord/domain";
import { demoStays } from "./demo-stays.js";
import type { DestinationIdea, DestinationsInput, Planning } from "./planner.js";
import { Merchant, type MerchantContract } from "../../integrations/src/merchant.js";
import { RoomStreams } from "../../integrations/src/realtime.js";
import { MemoryMerchantStore } from "./memory-merchant.js";
import type { ExternalRef, GoogleHotels, LiteApi, LiteRef, LiveStay, ProviderResult, StayResearch } from "./stays.js";
import type { PaymentGateway } from "./payments.js";
import type { SolanaCommitmentsPort, CommitmentInput } from "../../integrations/src/solana.js";
import type { Backboard } from "../../integrations/src/backboard.js";
import { SESSION_TTL_SECONDS, type MongoPersistence, type RoomAggregate, type SealedValue, type SessionRecord } from "./persistence.js";
import { consumePasswordCost, hashPassword, normalizeEmail, verifyPassword } from "./auth.js";
import type { Pulse } from "./pulse.js";
import { AppError } from "./errors.js";
import { Coordinator, type AlternativesInput, type AutopilotOptions } from "./coordinator.js";

export { AppError };
/** Private to one member; sealed at rest with their constraints. */
export type InboxEntry = {
  id: string; at: string; kind: InboxMessageDTO["kind"]; title: string; body: string; proposalId?: string;
  nudge?: { status: "OPEN" | "ACCEPTED" | "KEPT" | "EXPIRED"; check: NearMiss["check"] | "PLACE"; offerId?: string; offerVersion?: string; shareCents: number; checkOutAt?: string;
    /** DATES nudges: the exact trip days the member is asked to make. */
    window?: DateWindow;
    /** PLACE nudges: the member's own placesToAvoid text at the moment they were asked, so accepting only clears what they were actually shown. */
    place?: string };
};
export type Member = { id: string; userId: string; roomId: string; displayName: string; constraints: Constraints | null; confirmedAt?: string; capsuleVersion: number; inbox?: InboxEntry[];
  /** Backboard memory ids this member has explicitly re-confirmed for use in this trip. Ids only, never preference content. */
  appliedMemoryIds?: string[] };
/** Reusable, non-financial preference labels an explicitly-confirmed Backboard memory may hold. */
export type MemoryPreference = "WALKABLE" | "QUIET" | "NEAR_ACTIVITIES" | "REFUNDABLE";
type User = { id: string; displayName: string; createdAt: string; email?: string; passwordSalt?: string; passwordHash?: string;
  /** Backboard assistant provisioned for this user's own explicitly-confirmed reusable preferences. Never a financial record. */
  assistantId?: string };
type Approval = { proposalHash: string; status: "APPROVED" | "INVALIDATED"; approvedAt: string };
type Authorization = { proposalHash: string; amountCents: number; status: "AUTHORIZED" | "INVALIDATED" | "CAPTURED" | "RELEASED" | "FAILED"; providerRef: string; captureRef?: string; reversalRef?: string };
type PaymentLedgerEntry = {
  id: string; occurredAt: string; proposalHash: string; amountCents: number;
  type: "CONTRIBUTION_COMMITTED" | "SHARED_AUTHORIZED" | "SHARED_CAPTURED" | "SHARED_RELEASED" | "SHARED_AUTHORIZATION_FAILED" | "SHARED_CAPTURE_FAILED" | "SHARED_RELEASE_FAILED";
  memberId?: string; providerRef?: string;
};
export type Proposal = {
  id: string; roomId: string; version: number; hash: string; snapshot: {
    roomId: string; proposalId: string; version: number; memberIds: string[]; offer: Offer;
    contributionsCents: Record<string, number>; privateCapsuleVersions: Record<string, number>;
    createdAt: string; expiresAt: string;
  };
  state: "OPEN" | "READY_TO_EXECUTE" | "STALE" | "BOOKED" | "CANCELLED";
  approvals: Map<string, Approval>; authorizations: Map<string, Authorization>; ledger: PaymentLedgerEntry[];
  /** Provider handle for the approved stay (not part of the hashed snapshot; never private). */
  providerRef?: LiteRef | ExternalRef;
  /** Coordinator bookkeeping while the group decides; not part of the hashed snapshot. */
  watch?: { lastCheckedAt?: string; remindedAt?: string; expiryWarnedAt?: string };
  /** Best-effort Solana devnet commitment of this exact proposal hash; never authoritative and never part of the hashed snapshot. */
  solana?: { status: "PENDING" | "CONFIRMED" | "FAILED"; transactionSignature?: string; explorerUrl?: string; code?: string };
};
type LiveSearch = {
  searchedAt: string; googleSearchedAt?: string; offerIds: string[]; providers: ProviderResult[];
  research: Record<string, StayResearch>; refs: Record<string, LiteRef | ExternalRef>;
  /** Nearby destinations Accord added when nothing in the original one worked. */
  destinations?: string[];
};
type Booking = { reference: string; confirmedAt: string; proposalId: string; mode?: "SIMULATED" | "SANDBOX" | "EXTERNAL"; externalUrl?: string; hotelConfirmationCode?: string };
export type StayProviders = {
  liteApi?: LiteApi; google?: GoogleHotels; payment?: PaymentGateway; summarize?: (facts: unknown) => Promise<string | undefined>;
  /** Tiger Data market/process telemetry. Public prices and anonymous event types only. */
  pulse?: Pulse;
  /** Advisory only: proposes nearby destinations to search. Accord's checks still decide feasibility. */
  suggestAlternatives?: (input: AlternativesInput) => Promise<string[] | undefined>;
  /** Advisory only: proposes destinations from anonymous planning totals. */
  suggestDestinations?: (input: DestinationsInput) => Promise<DestinationIdea[] | undefined>;
  /** Best-effort devnet commitment of the proposal hash; never authoritative over consent. */
  solana?: SolanaCommitmentsPort;
  /** Opt-in reusable member preferences; never current-trip budgets or financial data. */
  backboard?: Backboard;
};
const GOOGLE_CACHE_MS = 30 * 60 * 1000;
const GROUP_PAYMENT_KEY = "__shared_group_payment__";
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
const shortDay = (day: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
export const dayRange = (window: DateWindow) => `${shortDay(window.checkIn)}–${shortDay(window.checkOut)}`;
const cancellationLabel = (offer: Offer) => offer.cancellationPolicyCode === "FULL_CASH_REFUND" ? "Full cash refund" : offer.cancellationPolicyCode === "TRAVEL_CREDIT" ? "Travel credit only" : "Non-refundable";
const sourceLabel = (offer: Offer) => offer.source === "LITEAPI" ? "Nuitée Connect hotel · bookable in sandbox" : offer.source === "GOOGLE_HOTELS" ? `Google Hotels · book on ${offer.merchantName}` : "Demo inventory";
export type Room = {
  id: string; name: string; goal: string; inviteToken: string; hostId: string;
  memberIds: string[]; createdAt: string; activeProposalId?: string; version: number;
  events: EventDTO[]; booking?: Booking;
  trip?: Trip; search?: LiveSearch; searching?: boolean;
  /** Set when Accord found nothing for this exact set of requirements and offers; public-safe message only. */
  noOption?: { fingerprint: string; message: string };
  widenedFor?: string;
  /** Set when the group asked Accord to decide where and when. `trip` appears once they have. */
  plan?: TripPlan; planning?: Planning;
  /** Stays come from Accord's generated rehearsal inventory rather than live providers. */
  rehearsal?: boolean;
};
/** Rooms with a trip search live providers, unless they plan with rehearsal stays. */
export const isLive = (room: Room) => !!room.trip && !room.rehearsal;

const merchantContract: MerchantContract<Offer, MerchantMutation, MerchantEvent> = {
  offer: OfferSchema, mutation: MerchantMutationSchema, event: MerchantEventSchema,
  id: offer => offer.offerId, version: offer => offer.offerVersion,
  available: offer => offer.available, expiresAt: offer => offer.expiresAt,
  apply: (current, original, mutation) => applyMerchantMutation(current, original, mutation),
  mutationEvent: (before, after) => ({ type: "MERCHANT_OFFER_MUTATED", offerId: after.offerId, beforeVersion: before.offerVersion, afterVersion: after.offerVersion }),
  bookingEvent: (offer, reference) => ({ type: "BOOKING_CONFIRMED", offerId: offer.offerId, bookingReference: reference }),
};
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const nowIso = () => new Date().toISOString();
// Optional offer fields that older data may hold as null (absent values used to be stored as null).
const OPTIONAL_OFFER_FIELDS = ["rating", "reviewCount", "imageUrl", "address", "externalUrl", "fullRefundDeadline", "source", "bookingMode"] as const;
function compatibleOffer(value: Offer | Record<string, unknown>): Offer {
  const cleaned: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of OPTIONAL_OFFER_FIELDS) if (cleaned[key] === null) delete cleaned[key];
  const input = cleaned as Offer & { checkInDate?: string; checkOutDate?: string; checkInTimeKnown?: boolean; checkOutTimeKnown?: boolean };
  return OfferSchema.parse({ ...input,
    checkInDate: input.checkInDate ?? String(input.checkInAt).slice(0, 10),
    checkOutDate: input.checkOutDate ?? String(input.checkOutAt).slice(0, 10),
    checkInTimeKnown: input.checkInTimeKnown ?? true,
    checkOutTimeKnown: input.checkOutTimeKnown ?? true,
  });
}
type MerchantBackend = {
  transaction: MemoryMerchantStore<Offer, MerchantEvent>["transaction"];
  drain(deliver: (id: string, event: MerchantEvent) => Promise<void>): Promise<number>;
};
const inventoryLabel = "Controlled synthetic demo merchant inventory — no real accommodation is reserved";

export class AccordState {
  readonly rooms = new Map<string, Room>();
  readonly users = new Map<string, User>();
  readonly members = new Map<string, Member>();
  readonly proposals = new Map<string, Proposal>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly userIdsByEmail = new Map<string, string>();
  readonly invitations = new Map<string, string>();
  readonly store: MerchantBackend;
  readonly merchant: Merchant<Offer, MerchantMutation, MerchantEvent>;
  readonly catalogIds = demoCatalog().map(offer => offer.offerId);
  readonly ready: Promise<void>;
  readonly streams: RoomStreams<z.infer<typeof PublicEventSchema>, z.infer<typeof PrivateEventSchema>>;
  readonly autopilot: Coordinator;
  #mutationTail: Promise<void> = Promise.resolve();
  #dirtyRooms = new Set<string>();
  #dirtyUsers = new Set<string>();
  #dirtySessions = new Set<string>();
  #dirtyInvitations = new Set<string>();
  #removedMembers = new Set<string>();
  #removedSessions = new Set<string>();
  #activeExecutions = new Map<string, Promise<ReceiptDTO>>();
  #activeSolves = new Map<string, Promise<ProposalEnvelope | { noSolution: true }>>();
  #activeReversals = new Map<string, Promise<void>>();

  /** Without persistence, state is process memory only. With Mongo, memory is a write-through working copy. */
  constructor(readonly persistence?: MongoPersistence, readonly providers: StayProviders = {}, autopilot: AutopilotOptions = {}) {
    const coordinator = this.autopilot = new Coordinator(this, autopilot);
    this.store = persistence ? persistence.merchantStore as MerchantBackend : new MemoryMerchantStore<Offer, MerchantEvent>();
    const merchant = this.merchant = new Merchant(this.store, merchantContract);
    this.ready = (async () => {
      if (persistence) await this.#hydrate();
      await merchant.seed(demoCatalog());
      await this.#migrateStoredOffers();
      for (const room of this.rooms.values()) if (room.planning?.stage === "PLANNING") coordinator.resume(room);
    })();
    this.streams = new RoomStreams(PublicEventSchema, PrivateEventSchema, async (request, roomId) => {
      const session = this.sessionFromCookie(request.headers.cookie);
      if (!session) return null;
      try { const { member } = this.requireRoom(roomId, session); return { roomId, memberId: member.id }; }
      catch { return null; }
    });
  }
  sessionFromCookie(cookie?: string) {
    const value = cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("accord_session="))?.slice("accord_session=".length);
    const session = value ? this.sessions.get(hashToken(value)) : undefined;
    return session && Date.parse(session.createdAt) + SESSION_TTL_SECONDS * 1000 > Date.now() ? session : undefined;
  }
  revokeSession(cookie?: string) {
    const value = cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("accord_session="))?.slice("accord_session=".length);
    if (!value) return;
    const id = hashToken(value);
    this.sessions.delete(id); this.#dirtySessions.delete(id); this.#removedSessions.add(id);
  }
  async register(emailValue: string, password: string, displayName: string, existing?: SessionRecord) {
    const email = normalizeEmail(emailValue);
    if (this.userIdsByEmail.has(email)) throw new AppError(409, "EMAIL_ALREADY_EXISTS");
    const credentials = await hashPassword(password);
    const userId = existing?.userId ?? randomUUID();
    const current = this.users.get(userId);
    if (current?.email) throw new AppError(409, "ACCOUNT_ALREADY_SECURED");
    const user: User = { id: userId, displayName, createdAt: current?.createdAt ?? nowIso(), email, ...credentials };
    this.users.set(userId, user); this.userIdsByEmail.set(email, userId); this.#dirtyUsers.add(userId);
    for (const member of this.members.values()) if (member.userId === userId) { member.displayName = displayName; this.#dirtyRooms.add(member.roomId); }
    const sessionToken = token();
    this.#addSession(hashToken(sessionToken), userId, existing?.roomId, existing?.memberId);
    return { sessionToken, account: this.accountDTO(this.sessions.get(hashToken(sessionToken))!) };
  }
  async login(emailValue: string, password: string) {
    const user = this.users.get(this.userIdsByEmail.get(normalizeEmail(emailValue)) ?? "");
    if (!user?.passwordSalt || !user.passwordHash) {
      await consumePasswordCost(password);
      throw new AppError(401, "INVALID_CREDENTIALS");
    }
    if (!(await verifyPassword(password, user.passwordSalt, user.passwordHash))) {
      throw new AppError(401, "INVALID_CREDENTIALS");
    }
    const membership = [...this.members.values()].find(member => member.userId === user.id);
    const sessionToken = token();
    this.#addSession(hashToken(sessionToken), user.id, membership?.roomId, membership?.id);
    return { sessionToken, account: this.accountDTO(this.sessions.get(hashToken(sessionToken))!) };
  }
  createRoom(name: string, goal: string, displayName: string, trip?: Trip, existing?: SessionRecord, planning?: { plan: TripPlan; rehearsal: boolean }) {
    const roomId = randomUUID(), memberId = randomUUID(), inviteToken = token(), sessionToken = token();
    const userId = existing?.userId ?? randomUUID();
    if (!this.users.has(userId)) { this.users.set(userId, { id: userId, displayName, createdAt: nowIso() }); this.#dirtyUsers.add(userId); }
    const room: Room = { id: roomId, name, goal, inviteToken, hostId: memberId, memberIds: [memberId], createdAt: nowIso(), version: 0, events: [], ...(trip ? { trip } : {}),
      ...(planning ? { plan: planning.plan, ...(planning.rehearsal ? { rehearsal: true } : {}) } : {}) };
    this.rooms.set(roomId, room); this.#addInvitation(hashToken(inviteToken), roomId);
    this.members.set(memberId, { id: memberId, userId, roomId, displayName, constraints: null, capsuleVersion: 0 });
    this.#addSession(hashToken(sessionToken), userId, roomId, memberId);
    this.emit(room, "MEMBER_JOINED", "One member joined the room.");
    return { roomId, inviteToken, sessionToken };
  }
  previewInvite(inviteToken: string) {
    const room = this.rooms.get(this.invitations.get(hashToken(inviteToken)) ?? "");
    if (!room) throw new AppError(404, "INVITE_NOT_FOUND");
    return { name: room.name, goal: room.goal, memberCount: room.memberIds.length };
  }
  join(inviteToken: string, displayName: string, existing?: SessionRecord) {
    const room = this.rooms.get(this.invitations.get(hashToken(inviteToken)) ?? "");
    if (!room) throw new AppError(404, "INVITE_NOT_FOUND");
    const userId = existing?.userId ?? randomUUID();
    const current = room.memberIds.map(id => this.members.get(id)!).find(member => member.userId === userId);
    if (current) return { roomId: room.id, sessionToken: undefined };
    if (room.memberIds.length >= 8) throw new AppError(409, "ROOM_FULL");
    const memberId = randomUUID(), sessionToken = token();
    if (!this.users.has(userId)) { this.users.set(userId, { id: userId, displayName, createdAt: nowIso() }); this.#dirtyUsers.add(userId); }
    this.members.set(memberId, { id: memberId, userId, roomId: room.id, displayName, constraints: null, capsuleVersion: 0 });
    room.memberIds.push(memberId);
    this.#addSession(hashToken(sessionToken), userId, room.id, memberId);
    this.stale(room, "The member set changed.");
    this.emit(room, "MEMBER_JOINED", "A member joined the room.");
    return { roomId: room.id, sessionToken };
  }
  requireRoom(roomId: string, session?: SessionRecord) {
    const room = this.rooms.get(roomId);
    if (!room) throw new AppError(404, "ROOM_NOT_FOUND");
    const member = session ? room.memberIds.map(id => this.members.get(id)!).find(item => item.userId === session.userId) : undefined;
    if (!member) throw new AppError(403, "ROOM_ACCESS_DENIED");
    return { room, member };
  }
  requireHost(roomId: string, session?: SessionRecord) {
    const { room, member } = this.requireRoom(roomId, session);
    if (member.id !== room.hostId) throw new AppError(403, "ADMIN_ACCESS_DENIED");
    return { room, member };
  }
  roomDTO(room: Room, viewerId: string): PublicRoomDTO {
    const proposal = room.activeProposalId ? this.proposals.get(room.activeProposalId) : undefined;
    return { id: room.id, name: room.name, goal: room.goal,
      status: room.booking ? "BOOKED" : room.searching ? "SEARCHING" : proposal?.state === "STALE" ? "STALE" : proposal ? "PROPOSAL_ACTIVE" : "COLLECTING",
      memberCount: room.memberIds.length,
      readyMemberCount: room.memberIds.filter(id => this.members.get(id)?.constraints).length,
      activeProposalId: room.activeProposalId,
      members: room.memberIds.map(id => { const member = this.members.get(id)!;
        return { id, displayName: member.displayName, ready: Boolean(member.constraints), isHost: id === room.hostId, isYou: id === viewerId }; }),
      viewerIsHost: viewerId === room.hostId,
      ...(room.trip ? { trip: room.trip } : {}),
      ...(room.search ? { lastSearch: { searchedAt: room.search.searchedAt, providers: room.search.providers.map(({ provider, status, count }) => ({ provider, status, count })) } } : {}),
      autopilot: this.autopilot.describe(room),
      ...(room.plan ? { planning: this.autopilot.planner.dto(room, viewerId) } : {}) };
  }
  /** Host-only. Only members who have not confirmed requirements can be removed; their sessions are revoked. */
  removeMember(room: Room, host: Member, memberId: string) {
    if (host.id !== room.hostId) throw new AppError(403, "ADMIN_ACCESS_DENIED");
    const target = room.memberIds.includes(memberId) ? this.members.get(memberId) : undefined;
    if (!target) throw new AppError(404, "MEMBER_NOT_FOUND");
    if (target.id === room.hostId) throw new AppError(409, "CANNOT_REMOVE_HOST");
    if (target.constraints) throw new AppError(409, "MEMBER_ALREADY_READY");
    this.#dropMember(room, memberId, true);
    this.emit(room, "MEMBER_REMOVED", "The host removed a member who hadn’t confirmed requirements.");
  }
  /** Any non-host member may leave. Their private requirements and sessions are deleted; any proposal becomes stale. */
  leave(room: Room, member: Member) {
    if (member.id === room.hostId) throw new AppError(409, "HOST_CANNOT_LEAVE");
    if (room.booking) throw new AppError(409, "ALREADY_BOOKED");
    this.#dropMember(room, member.id, false);
    this.emit(room, "MEMBER_LEFT", "A member left the group. Shares and approvals need a fresh look.");
  }
  #dropMember(room: Room, memberId: string, revokeSession: boolean) {
    room.memberIds = room.memberIds.filter(id => id !== memberId);
    this.members.delete(memberId); this.#removedMembers.add(memberId);
    for (const [sessionId, session] of this.sessions) if (session.memberId === memberId) {
      if (!revokeSession) {
        this.sessions.set(sessionId, { userId: session.userId, createdAt: session.createdAt });
        this.#dirtySessions.add(sessionId);
      } else {
        this.sessions.delete(sessionId);
        this.#dirtySessions.delete(sessionId);
        this.#removedSessions.add(sessionId);
      }
    }
    this.stale(room, "The member set changed.");
    this.autopilot.kick(room, "READY");
  }
  confirmConstraints(room: Room, member: Member, constraints: Constraints) {
    // The group's dates come only from members' answers, so a trip still being planned needs everyone's.
    if (room.plan && !room.trip && !constraints.availability?.length) throw new AppError(422, "DATES_REQUIRED");
    member.constraints = structuredClone(constraints); member.capsuleVersion++; member.confirmedAt = nowIso();
    for (const entry of member.inbox ?? []) if (entry.nudge?.status === "OPEN") entry.nudge.status = "EXPIRED";
    this.stale(room, "Confirmed requirements changed.");
    this.emit(room, "CONSTRAINTS_CONFIRMED", "A member confirmed private requirements.", undefined, { actor: "GROUP" });
    this.streams.publishPrivate(room.id, member.id, randomUUID(), { roomId: room.id, type: "CONSTRAINTS_CONFIRMED", at: nowIso() });
    this.autopilot.kick(room, "READY");
  }
  /** Every member with confirmed requirements, or undefined while anyone is still missing theirs. */
  readyMembers(room: Room) {
    const members = room.memberIds.map(id => this.members.get(id)!);
    return members.length && members.every(member => member.constraints) ? members as Array<Member & { constraints: Constraints }> : undefined;
  }
  touch(room: Room) { this.#dirtyRooms.add(room.id); }
  notify(room: Room, memberId: string, message: Omit<InboxEntry, "id" | "at">) {
    const member = this.members.get(memberId);
    if (!member || member.roomId !== room.id) return;
    const entry: InboxEntry = { ...structuredClone(message), id: randomUUID(), at: nowIso() };
    member.inbox = [...(member.inbox ?? []), entry].slice(-40);
    this.#dirtyRooms.add(room.id);
    this.streams.publishPrivate(room.id, memberId, randomUUID(), { roomId: room.id, type: "INBOX", ...(entry.proposalId ? { proposalId: entry.proposalId } : {}), at: entry.at });
  }
  inbox(member: Member): InboxDTO {
    const labels = (entry: InboxEntry) => {
      const nudge = entry.nudge!;
      if (nudge.check === "BUDGET") return { acceptLabel: `Raise my limit to ${money(nudge.shareCents)}`, keepLabel: "Keep my limit" };
      if (nudge.check === "REFUND") return { acceptLabel: "Drop the refund requirement for this trip", keepLabel: "Keep requiring a full refund" };
      if (nudge.check === "DATES") return { acceptLabel: nudge.window ? `I can make ${dayRange(nudge.window)}` : "I can make these dates", keepLabel: "Keep my dates" };
      if (nudge.check === "PLACE") return { acceptLabel: "Drop that for this trip", keepLabel: "Keep avoiding it" };
      return { acceptLabel: "Accept this checkout time", keepLabel: "Keep my checkout time" };
    };
    // Calls to action about a proposal that is no longer open would point people at a dead offer.
    const superseded = (entry: InboxEntry) => {
      if (entry.kind === "VOTE") return this.rooms.get(member.roomId)?.planning?.stage !== "VOTING" || entry !== member.inbox?.findLast(item => item.kind === "VOTE");
      if (!entry.proposalId || !(entry.kind === "READY_TO_BOOK" || entry.kind === "REMINDER" || entry.kind === "EXPIRING")) return false;
      const proposal = this.proposals.get(entry.proposalId);
      if (entry.kind === "REMINDER") return proposal?.state !== "OPEN" || proposal.approvals.get(member.id)?.status === "APPROVED";
      return !["OPEN", "READY_TO_EXECUTE"].includes(proposal?.state ?? "");
    };
    return { messages: [...(member.inbox ?? [])].reverse().filter(entry => !superseded(entry)).map(entry => ({ id: entry.id, at: entry.at, kind: entry.kind, title: entry.title, body: entry.body,
      ...(entry.proposalId ? { proposalId: entry.proposalId } : {}),
      ...(entry.nudge ? { nudge: { status: entry.nudge.status, check: entry.nudge.check, ...labels(entry) } } : {}) })) };
  }
  #sharedPayment(proposal: Proposal) { return proposal.authorizations.get(GROUP_PAYMENT_KEY); }
  #memberPaymentStatus(proposal: Proposal, memberId: string): PrivateProposalDTO["myPaymentStatus"] {
    const approval = proposal.approvals.get(memberId);
    if (approval?.status === "INVALIDATED") return "INVALIDATED";
    const shared = this.#sharedPayment(proposal);
    if (shared) return shared.status;
    return approval?.status === "APPROVED" ? "COMMITTED" : "PENDING";
  }
  #ledger(proposal: Proposal, entry: Omit<PaymentLedgerEntry, "id" | "occurredAt" | "proposalHash">) {
    proposal.ledger.push({ id: randomUUID(), occurredAt: nowIso(), proposalHash: proposal.hash, ...entry });
    this.#dirtyRooms.add(proposal.roomId);
  }
  accountDTO(session: SessionRecord): AccountDTO {
    const user = this.users.get(session.userId);
    if (!user) throw new AppError(401, "SESSION_REQUIRED");
    const memberships = [...this.members.values()].filter(member => member.userId === user.id);
    const groups = memberships.flatMap(member => {
      const room = this.rooms.get(member.roomId);
      if (!room) return [];
      const roomView = this.roomDTO(room, member.id);
      const bookedProposal = room.booking ? this.proposals.get(room.booking.proposalId) : undefined;
      return [{
        roomId: room.id, name: room.name, role: room.hostId === member.id ? "HOST" as const : "MEMBER" as const,
        status: roomView.status, memberCount: roomView.memberCount, readyMemberCount: roomView.readyMemberCount,
        ...(room.trip ? { trip: room.trip } : {}), ...(room.activeProposalId ? { activeProposalId: room.activeProposalId } : {}),
        ...(room.booking && bookedProposal ? { booking: {
          reference: room.booking.reference, confirmedAt: room.booking.confirmedAt,
          propertyName: bookedProposal.snapshot.offer.propertyName, city: bookedProposal.snapshot.offer.city,
          totalCents: bookedProposal.snapshot.offer.totalCents,
          ownContributionCents: bookedProposal.snapshot.contributionsCents[member.id] ?? 0,
          paymentStatus: this.#memberPaymentStatus(bookedProposal, member.id),
        } } : {}),
      }];
    }).sort((a, b) => {
      const aTime = a.booking?.confirmedAt ?? this.rooms.get(a.roomId)!.createdAt;
      const bTime = b.booking?.confirmedAt ?? this.rooms.get(b.roomId)!.createdAt;
      return Date.parse(bTime) - Date.parse(aTime);
    });
    const membershipByRoom = new Map(memberships.map(member => [member.roomId, member]));
    const payments = [...this.proposals.values()].flatMap(proposal => {
      const member = membershipByRoom.get(proposal.roomId);
      if (!member || !proposal.snapshot.memberIds.includes(member.id)) return [];
      const room = this.rooms.get(proposal.roomId)!;
      // Reverse append order so events written in the same millisecond still read newest-first.
      return [...proposal.ledger].reverse().flatMap(entry => {
        if (entry.type === "CONTRIBUTION_COMMITTED" && entry.memberId !== member.id) return [];
        const shared = entry.type !== "CONTRIBUTION_COMMITTED";
        const status = entry.type === "CONTRIBUTION_COMMITTED" ? "COMMITTED" as const
          : entry.type === "SHARED_AUTHORIZED" ? "AUTHORIZED" as const
          : entry.type === "SHARED_CAPTURED" ? "CAPTURED" as const
          : entry.type === "SHARED_RELEASED" ? "RELEASED" as const : "FAILED" as const;
        const labels: Record<PaymentLedgerEntry["type"], string> = {
          CONTRIBUTION_COMMITTED: "Your contribution approved",
          SHARED_AUTHORIZED: "Shared Visa authorization created",
          SHARED_CAPTURED: "Shared Visa payment captured",
          SHARED_RELEASED: "Shared Visa authorization reversed",
          SHARED_AUTHORIZATION_FAILED: "Shared Visa authorization failed",
          SHARED_CAPTURE_FAILED: "Shared Visa capture needs review",
          SHARED_RELEASE_FAILED: "Shared Visa reversal needs review",
        };
        return [{ roomId: room.id, roomName: room.name, proposalId: proposal.id, proposalVersion: proposal.version,
          propertyName: proposal.snapshot.offer.propertyName,
          amountCents: shared ? proposal.snapshot.contributionsCents[member.id]! : entry.amountCents,
          status, provider: room.trip ? "CYBERSOURCE" as const : "DEMO" as const,
          scope: shared ? "SHARED_PAYMENT" as const : "MEMBER_COMMITMENT" as const,
          label: labels[entry.type], recordedAt: entry.occurredAt,
          ...(entry.providerRef ? { transactionId: entry.providerRef } : {}) }];
      });
    }).sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
    return { user: { id: user.id, displayName: user.displayName, createdAt: user.createdAt, ...(user.email ? { email: user.email } : {}) }, groups, payments };
  }
  updateProfile(session: SessionRecord, displayName: string) {
    const user = this.users.get(session.userId);
    if (!user) throw new AppError(401, "SESSION_REQUIRED");
    user.displayName = displayName;
    this.#dirtyUsers.add(user.id);
    for (const member of this.members.values()) if (member.userId === user.id) {
      member.displayName = displayName;
      this.#dirtyRooms.add(member.roomId);
    }
    return this.accountDTO(session);
  }
  /** Provisions (once) and caches the Backboard assistant for this account. Never called from user-supplied identifiers. */
  async #ensureAssistant(user: User): Promise<string | undefined> {
    if (user.assistantId) return user.assistantId;
    const backboard = this.providers.backboard;
    if (!backboard) return undefined;
    const result = await backboard.createAssistant();
    if (result.status !== "OK") return undefined;
    user.assistantId = result.value.assistant_id;
    this.#dirtyUsers.add(user.id);
    await this.flush();
    return user.assistantId;
  }
  /** Reusable preferences this member previously confirmed with Backboard. Never includes current-trip budgets or financial data. */
  async memories(session: SessionRecord, member: Member) {
    if (!this.providers.backboard) throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    const user = this.users.get(session.userId);
    if (!user) throw new AppError(401, "SESSION_REQUIRED");
    const assistantId = await this.#ensureAssistant(user);
    if (!assistantId) throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    const result = await this.providers.backboard.recall(assistantId);
    if (result.status !== "OK") throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    return { source: "BACKBOARD" as const, memories: result.value.map(memory => ({ id: memory.id, label: memory.content, applied: member.appliedMemoryIds?.includes(memory.id) ?? false })) };
  }
  /** Re-confirms a previously-remembered preference for use in THIS trip. Only ever runs after the member's own explicit confirmation in this request. */
  async applyMemory(session: SessionRecord, member: Member, memoryId: string) {
    const backboard = this.providers.backboard;
    if (!backboard) throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    const user = this.users.get(session.userId);
    if (!user) throw new AppError(401, "SESSION_REQUIRED");
    const assistantId = await this.#ensureAssistant(user);
    if (!assistantId) throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    const recalled = await backboard.recall(assistantId);
    if (recalled.status !== "OK") throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    const memory = recalled.value.find(item => item.id === memoryId);
    const preference = memory?.metadata?.preference;
    const preferences: MemoryPreference[] = ["WALKABLE", "QUIET", "NEAR_ACTIVITIES", "REFUNDABLE"];
    if (!memory || typeof preference !== "string" || !preferences.includes(preference as MemoryPreference)) throw new AppError(404, "MEMORY_NOT_FOUND");
    const result = await backboard.remember(assistantId, preference as MemoryPreference, true);
    if (result.status !== "OK") throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    if (!member.appliedMemoryIds?.includes(memoryId)) { member.appliedMemoryIds = [...(member.appliedMemoryIds ?? []), memoryId]; this.#dirtyRooms.add(member.roomId); }
    return { source: "BACKBOARD" as const, id: memoryId, label: memory.content, applied: true as const };
  }
  /** Creates a brand-new Backboard memory from a preference the member just explicitly confirmed. Never runs without that confirmation. */
  async rememberPreference(session: SessionRecord, member: Member, preference: MemoryPreference) {
    const backboard = this.providers.backboard;
    if (!backboard) throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    const user = this.users.get(session.userId);
    if (!user) throw new AppError(401, "SESSION_REQUIRED");
    const assistantId = await this.#ensureAssistant(user);
    if (!assistantId) throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    const result = await backboard.remember(assistantId, preference, true);
    if (result.status !== "OK") throw new AppError(503, "BACKBOARD_UNAVAILABLE");
    const memory = result.value;
    if (!member.appliedMemoryIds?.includes(memory.id)) { member.appliedMemoryIds = [...(member.appliedMemoryIds ?? []), memory.id]; this.#dirtyRooms.add(member.roomId); }
    return { source: "BACKBOARD" as const, id: memory.id, label: memory.content, applied: true as const };
  }
  /** Compatibility entry point used by the HTTP layer; the coordinator owns scheduling and locking. */
  beginSolveWhenReady(room: Room) {
    this.autopilot.kick(room, "READY");
  }
  /** Merchant changes replan from the already observed inventory immediately;
   * a later explicit search can refresh the external provider again. */
  beginReplanFromCurrentInventory(room: Room) {
    this.autopilot.kick(room, "REPLAN");
  }
  async currentOffer(id: string) {
    await this.ready;
    return this.store.transaction(async tx => { const offer = (await tx.getOffer(id))?.offer; return offer ? compatibleOffer(offer) : undefined; });
  }
  /** Rooms with trip details or a plan use their own search results; legacy rooms use the controlled demo catalog. */
  // A planning room searches every destination candidate before anyone decides or votes; let members browse
  // all of it (not just the winner) rather than waiting for room.search, which is only set once a trip is decided.
  offerIdsFor(room: Room) { return room.trip || room.plan ? room.search?.offerIds ?? room.planning?.options.flatMap(option => option.offerIds) ?? [] : this.catalogIds; }
  /**
   * Searches several candidate trips at once for planning and replaces the room's results with all of them.
   * Rehearsal rooms get generated stays; live rooms query each configured provider per candidate.
   */
  async searchCandidates(room: Room, trips: Trip[]) {
    const byTrip: string[][] = [];
    const research: Record<string, StayResearch> = {}, refs: Record<string, LiteRef | ExternalRef> = {};
    const totals = new Map<ProviderResult["provider"], ProviderResult>();
    room.searching = true;
    try {
      for (const trip of trips) {
        let offers: Offer[];
        if (room.rehearsal) offers = demoStays(trip);
        else {
          const { liteApi, google } = this.providers;
          if (!liteApi && !google) throw new AppError(503, "STAY_SEARCH_UNAVAILABLE");
          const stays: LiveStay[] = [];
          for (const [provider, client] of [["LITEAPI", liteApi], ["GOOGLE_HOTELS", google]] as const) {
            const total = totals.get(provider) ?? { provider, status: client ? "OK" : "UNCONFIGURED", count: 0 };
            if (client) {
              try { const found = await client.search(trip); stays.push(...found); total.count += found.length; }
              catch (error) { if (!total.count) Object.assign(total, { status: "FAILED", detail: String((error as Error).message).slice(0, 160) }); }
            }
            totals.set(provider, total);
          }
          for (const stay of stays) { research[stay.offer.offerId] = stay.research; refs[stay.offer.offerId] = stay.ref; }
          offers = stays.map(stay => stay.offer);
        }
        // A regenerated rehearsal stay must not undo a merchant change made from the simulator.
        await this.#upsertLive(offers, { keepExisting: room.rehearsal });
        byTrip.push(offers.map(offer => offer.offerId));
      }
      room.search = { searchedAt: nowIso(), offerIds: [...new Set(byTrip.flat())], research, refs,
        providers: room.rehearsal ? [] : [...totals.values()], destinations: [...new Set(trips.map(trip => trip.destination))] };
      return byTrip;
    } finally { room.searching = false; this.#dirtyRooms.add(room.id); }
  }
  /** Ranks feasible offers for these members, best first, using the same scoring as a normal search. */
  async rankFeasible(offers: Offer[], members: Array<Member & { constraints: Constraints }>) {
    const feasible = offers.filter(offer => assessOffer(offer, members).feasible);
    const minTotal = feasible.length ? Math.min(...feasible.map(offer => offer.totalCents)) : 0;
    return feasible.sort((a, b) => this.score(b, members, minTotal) - this.score(a, members, minTotal) || a.totalCents - b.totalCents);
  }
  async allOffers(ids: readonly string[] = this.catalogIds): Promise<Offer[]> {
    await this.ready;
    // Sequential: Mongo transactions do not support concurrent operations on one session.
    return this.store.transaction(async tx => {
      const offers: Offer[] = [];
      for (const id of ids) { const record = await tx.getOffer(id); if (record) offers.push(compatibleOffer(record.offer)); }
      return offers;
    });
  }
  /** Runs the live providers, stores their offers as versioned merchant records, and stales an approved offer that changed. */
  async searchLive(room: Room, options: { destination?: string } = {}) {
    const extra = options.destination !== undefined;
    const trip: Trip = extra ? { ...room.trip!, destination: options.destination! } : room.trip!;
    const { liteApi, google } = this.providers;
    if (!liteApi && !google) throw new AppError(503, "STAY_SEARCH_UNAVAILABLE");
    room.searching = true;
    this.emit(room, "SEARCH_STARTED", `Searching live stays in ${trip.destination} for ${trip.checkIn} to ${trip.checkOut}.`);
    try {
      const previous = room.search;
      const reuseGoogle = !extra && !!previous?.googleSearchedAt && Date.now() - Date.parse(previous.googleSearchedAt) < GOOGLE_CACHE_MS;
      const run = async (provider: ProviderResult["provider"], client: { search(trip: Trip): Promise<LiveStay[]> } | undefined) => {
        if (!client) return { result: { provider, status: "UNCONFIGURED", count: 0 } as ProviderResult, stays: [] as LiveStay[] };
        try { const stays = await client.search(trip); return { result: { provider, status: "OK", count: stays.length } as ProviderResult, stays }; }
        catch (error) { return { result: { provider, status: "FAILED", count: 0, detail: String((error as Error).message).slice(0, 160) } as ProviderResult, stays: [] as LiveStay[] }; }
      };
      const [lite, fresh] = await Promise.all([run("LITEAPI", liteApi), reuseGoogle ? Promise.resolve(undefined) : run("GOOGLE_HOTELS", google)]);
      const googleIds = reuseGoogle ? previous!.offerIds.filter(id => id.startsWith("gh-")) : fresh!.stays.map(stay => stay.offer.offerId);
      const googleResult: ProviderResult = reuseGoogle ? { provider: "GOOGLE_HOTELS", status: "OK", count: googleIds.length, detail: "cached" } : fresh!.result;
      const label = (result: ProviderResult, noun: string) => result.status === "OK" ? `${result.count} ${noun}${result.detail === "cached" ? " (cached from the last 30 minutes)" : ""}` : result.status === "FAILED" ? `search failed, continuing without it` : "not configured";
      const where = extra ? ` in ${trip.destination}` : "";
      this.emit(room, "SEARCH_PROVIDER", `Nuitée Connect${where}: ${label(lite.result, "bookable hotel rates")}.`);
      this.emit(room, "SEARCH_PROVIDER", `Google Hotels${where}: ${label(googleResult, "vacation rentals")}.`);
      const stays = [...lite.stays, ...(fresh?.stays ?? [])];
      if (extra) {
        if (!stays.length || !previous) return;
        await this.#upsertLive(stays.map(stay => stay.offer));
        room.search = { ...previous, offerIds: [...new Set([...previous.offerIds, ...stays.map(stay => stay.offer.offerId)])],
          research: { ...previous.research, ...Object.fromEntries(stays.map(stay => [stay.offer.offerId, stay.research])) },
          refs: { ...previous.refs, ...Object.fromEntries(stays.map(stay => [stay.offer.offerId, stay.ref])) },
          destinations: [...(previous.destinations ?? []), trip.destination] };
        return;
      }
      if (!stays.length && !googleIds.length) {
        if (previous?.offerIds.length) { this.emit(room, "SEARCH_FALLBACK", "Live search returned nothing; showing the last successful results."); return; }
        room.search = { searchedAt: nowIso(), offerIds: [], providers: [lite.result, googleResult], research: {}, refs: {} };
        throw new AppError(503, "STAY_SEARCH_FAILED");
      }
      await this.#upsertLive(stays.map(stay => stay.offer));
      const keep = <T>(source: Record<string, T> | undefined, ids: string[]) => Object.fromEntries(ids.flatMap(id => source?.[id] ? [[id, source[id]!]] : []));
      room.search = {
        searchedAt: nowIso(), googleSearchedAt: reuseGoogle ? previous!.googleSearchedAt : fresh?.result.status === "OK" ? nowIso() : previous?.googleSearchedAt,
        offerIds: [...stays.filter(stay => stay.offer.source === "LITEAPI").map(stay => stay.offer.offerId), ...googleIds],
        providers: [lite.result, googleResult],
        research: { ...keep(previous?.research, googleIds), ...Object.fromEntries(stays.map(stay => [stay.offer.offerId, stay.research])) },
        refs: { ...keep(previous?.refs, googleIds), ...Object.fromEntries(stays.map(stay => [stay.offer.offerId, stay.ref])) },
      };
      const active = room.activeProposalId ? this.proposals.get(room.activeProposalId) : undefined;
      if (active && active.state !== "BOOKED") {
        const current = await this.currentOffer(active.snapshot.offer.offerId);
        if (current && !materialOfferEquals(current, active.snapshot.offer)) this.stale(room, "Live price or terms changed.");
      }
    } finally { room.searching = false; this.#dirtyRooms.add(room.id); }
  }
  async #upsertLive(offers: Offer[], options: { keepExisting?: boolean } = {}) {
    await this.store.transaction(async tx => {
      for (const offer of offers) {
        const existingRaw = await tx.getOffer(offer.offerId);
        const existing = existingRaw ? { ...existingRaw, offer: compatibleOffer(existingRaw.offer), original: compatibleOffer(existingRaw.original) } : undefined;
        if (!existing) { await tx.putOffer(offer.offerId, { offer, original: structuredClone(offer), failNextBooking: false, booked: false }); continue; }
        if (existing.booked || options.keepExisting) continue;
        const candidate = { ...offer, offerVersion: existing.offer.offerVersion, expiresAt: existing.offer.expiresAt };
        const next = materialOfferEquals(candidate, existing.offer)
          ? { ...existing.offer, expiresAt: offer.expiresAt, imageUrl: offer.imageUrl, rating: offer.rating, reviewCount: offer.reviewCount }
          : { ...offer, offerVersion: `v${Number(existing.offer.offerVersion.slice(1)) + 1}` };
        await tx.putOffer(offer.offerId, { ...existing, offer: OfferSchema.parse(next) });
      }
    });
  }
  /** Records a provider-observed change as a new offer version. */
  async #reviseOffer(offerId: string, changes: Partial<Offer>) {
    await this.store.transaction(async tx => {
      const record = await tx.getOffer(offerId);
      if (!record) return;
      await tx.putOffer(offerId, { ...record, offer: OfferSchema.parse({ ...record.offer, ...changes, offerVersion: `v${Number(record.offer.offerVersion.slice(1)) + 1}` }) });
    });
  }
  private confirmed(room: Room) {
    const members = room.memberIds.map(id => this.members.get(id)!);
    if (!members.length || members.some(member => !member.constraints)) throw new AppError(409, "MEMBERS_NOT_READY");
    return members as Array<Member & { constraints: Constraints }>;
  }
  private score(offer: Offer, members: Array<Member & { constraints: Constraints }>, minTotal: number) {
    let score = (offer.totalCents - minTotal) / -10000;
    for (const member of members) {
      const preference = member.constraints.softPreference.toLowerCase();
      if (/walkab/.test(preference) && offer.walkable) score += 10;
      if (/near activit|close to activit/.test(preference) && offer.nearActivities) score += 10;
      if (/quiet/.test(preference) && offer.quiet) score += 10;
      if (/lowest|cheap|price/.test(preference)) score += (minTotal / offer.totalCents) * 2;
    }
    return score;
  }
  private offerDTO(offer: Offer, room: Room, feasible: boolean): PublicOfferDTO {
    return { offerId: offer.offerId, offerVersion: offer.offerVersion, merchantName: offer.merchantName,
      propertyName: offer.propertyName, city: offer.city, roomType: offer.roomType,
      checkInDate: offer.checkInDate, checkOutDate: offer.checkOutDate,
      checkInAt: offer.checkInAt, checkOutAt: offer.checkOutAt,
      checkInTimeKnown: offer.checkInTimeKnown, checkOutTimeKnown: offer.checkOutTimeKnown, guestCapacity: offer.guestCapacity,
      timeZone: room.planning?.offerZones?.[offer.offerId] ?? room.trip?.timeZone ?? "America/New_York",
      stepFreeVerified: offer.stepFreeVerified,
      cancellationLabel: offer.cancellationPolicyCode === "FULL_CASH_REFUND" ? "Full cash refund" : offer.cancellationPolicyCode === "TRAVEL_CREDIT" ? "Travel credit only" : "Non-refundable",
      subtotalCents: offer.subtotalCents, mandatoryFeesCents: offer.mandatoryFeesCents, totalCents: offer.totalCents,
      equalShareCents: Math.ceil(offer.totalCents / room.memberIds.length), available: offer.available, expiresAt: offer.expiresAt,
      feasible, publicFeasibilityMessage: feasible ? "Meets every confirmed requirement." : "Does not meet all confirmed requirements.",
      source: offer.source ?? "DEMO", sourceLabel: sourceLabel(offer), bookingMode: offer.bookingMode ?? "SIMULATED",
      ...(offer.imageUrl ? { imageUrl: offer.imageUrl } : {}), ...(offer.address ? { address: offer.address } : {}),
      ...(offer.rating !== undefined ? { rating: offer.rating } : {}), ...(offer.reviewCount !== undefined ? { reviewCount: offer.reviewCount } : {}),
      ...(offer.externalUrl ? { externalUrl: offer.externalUrl } : {}),
      ...(room.search?.research[offer.offerId] ? { research: room.search.research[offer.offerId] } : {}) };
  }
  inventoryLabel(room: Room) {
    return room.rehearsal ? "Accord rehearsal stays — generated for your destination and dates; no real accommodation is reserved" : inventoryLabel;
  }
  async offers(room: Room): Promise<OffersDTO> {
    const members = this.confirmed(room), offers = await this.allOffers(this.offerIdsFor(room));
    const assessments = offers.map(offer => ({ offer, assessed: assessOffer(offer, members) }));
    const feasible = assessments.filter(item => item.assessed.feasible);
    // Google Hotels results remain useful comparisons, but only provider-bookable inventory can become an executable proposal.
    const proposalCandidates = isLive(room) ? feasible.filter(item => item.offer.source === "LITEAPI") : feasible;
    const minTotal = proposalCandidates.length ? Math.min(...proposalCandidates.map(item => item.offer.totalCents)) : 0;
    const ranked = [...proposalCandidates].sort((a, b) => this.score(b.offer, members, minTotal) - this.score(a.offer, members, minTotal) || a.offer.totalCents - b.offer.totalCents);
    const recommended = ranked[0]?.offer;
    const rank = new Map(ranked.map((item, index) => [item.offer.offerId, index]));
    const ordered = [...assessments].sort((a, b) => (rank.get(a.offer.offerId) ?? 1e6) - (rank.get(b.offer.offerId) ?? 1e6) || a.offer.totalCents - b.offer.totalCents);
    const live = isLive(room);
    const reasons = !recommended ? [] : [
      "Meets every confirmed requirement.",
      ...(live ? [`Real listing: ${sourceLabel(recommended)}.`] : []),
      ...(recommended.rating !== undefined ? [`Guest rating ${recommended.rating}/10${recommended.reviewCount ? ` from ${recommended.reviewCount.toLocaleString("en-US")} reviews` : ""}.`] : []),
      "Matches confirmed group preferences.",
    ];
    // Observed price history from Tiger Data; optional and time-boxed so the page never waits on analytics.
    const pulse = this.providers.pulse;
    const stability = live && pulse ? await Promise.race([
      pulse.stability(room.trip!, ordered.map(item => item.offer.offerId)).catch(() => undefined),
      new Promise<undefined>(resolve => setTimeout(resolve, 1500)),
    ]) : undefined;
    return { inventoryLabel: live ? `Live results: Nuitée Connect hotels (sandbox booking)${this.providers.google ? " and Google Hotels vacation rentals via SerpApi" : ""}${room.search ? ` · searched ${new Date(room.search.searchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: room.trip!.timeZone })}` : " · not searched yet"}` : this.inventoryLabel(room),
      offers: ordered.map(item => { const dto = this.offerDTO(item.offer, room, item.assessed.feasible), observed = stability?.get(item.offer.offerId); return observed ? { ...dto, stability: observed } : dto; }),
      recommendedOfferId: recommended?.offerId, recommendationReasons: reasons,
      providerResults: room.search?.providers.map(({ provider, status, count, detail }) => ({ provider, status, count, ...(detail ? { detail } : {}) })) ?? [],
      funnel: [{ label: live ? "Live stays checked" : "Demo stays checked", count: offers.length }, { label: "Current and available", count: offers.filter(offer => offer.available).length }, { label: "Suitable for everyone", count: feasible.length }, ...(live ? [{ label: "Bookable through Nuitée Connect", count: proposalCandidates.length }] : [])] };
  }
  async solve(room: Room, trigger: "MANUAL" | "READY" | "REPLAN" | "WIDEN" = "MANUAL", options: { search?: boolean } = {}): Promise<ProposalEnvelope | { noSolution: true }> {
    const current = room.activeProposalId ? this.proposals.get(room.activeProposalId) : undefined;
    if (current && (current.state === "OPEN" || current.state === "READY_TO_EXECUTE")) return this.publicProposal(current);
    const active = this.#activeSolves.get(room.id);
    if (active) return active;
    const running = this.#solve(room, trigger, options);
    this.#activeSolves.set(room.id, running);
    return running.finally(() => this.#activeSolves.delete(room.id));
  }
  async #solve(room: Room, trigger: "MANUAL" | "READY" | "REPLAN" | "WIDEN", options: { search?: boolean }): Promise<ProposalEnvelope | { noSolution: true }> {
    const members = this.confirmed(room);
    if (room.plan && !room.trip) throw new AppError(409, "TRIP_NOT_DECIDED");
    if (isLive(room) && options.search !== false) await this.searchLive(room);
    else this.emit(room, "SOLVE_STARTED", isLive(room) ? "Accord started replanning from the current observed stays." : trigger === "REPLAN" ? "Accord is re-checking every demo stay against everyone’s confirmed requirements." : "Accord started checking current demo stays.", undefined, { actor: "ACCORD" });
    const data = await this.offers(room);
    if (!data.recommendedOfferId) { this.emit(room, "SOLVE_COMPLETED", "No current stay satisfies every confirmed requirement.", undefined, { actor: "ACCORD", detail: `Checked ${data.offers.length} stays.` }); return { noSolution: true }; }
    const offer = (await this.currentOffer(data.recommendedOfferId))!;
    const assessment = assessOffer(offer, members);
    if (!assessment.feasible) throw new AppError(409, "OFFER_CHANGED");
    const id = randomUUID(), version = ++room.version, createdAt = nowIso();
    const snapshot = { roomId: room.id, proposalId: id, version, memberIds: [...room.memberIds].sort(),
      offer: structuredClone(offer), contributionsCents: assessment.shares,
      privateCapsuleVersions: Object.fromEntries(members.map(member => [member.id, member.capsuleVersion])),
      createdAt, expiresAt: offer.expiresAt };
    const providerRef = room.search?.refs[offer.offerId];
    const proposal: Proposal = { id, roomId: room.id, version, hash: proposalHash(snapshot), snapshot, state: "OPEN", approvals: new Map(), authorizations: new Map(), ledger: [], ...(providerRef ? { providerRef } : {}) };
    this.proposals.set(id, proposal); room.activeProposalId = id;
    const suitable = data.offers.filter(item => item.feasible).length;
    const share = money(Math.ceil(offer.totalCents / room.memberIds.length));
    this.emit(room, "SOLVE_COMPLETED", `${suitable} of ${data.offers.length} ${isLive(room) ? "live" : "demo"} stays meet every confirmed requirement.`, undefined, { actor: "ACCORD" });
    if (isLive(room)) void this.#summarize(room, data.offers.filter(item => item.feasible).slice(0, 3).map(item => item.offerId));
    const title = trigger === "REPLAN" || trigger === "WIDEN"
      ? `Accord found a new option: ${offer.propertyName} in ${offer.city}, ${share} each. Proposal v${version} needs everyone’s fresh approval.`
      : `Accord proposed ${offer.propertyName} in ${offer.city}: ${share} each (Proposal v${version}).`;
    this.emit(room, "PROPOSAL_CREATED", title, id, { actor: "ACCORD", detail: "It meets every member’s confirmed requirements. Nothing is booked until each person approves their exact share." });
    void this.#recordSolanaCommitment(room, proposal, "PROPOSAL_CREATED");
    return this.publicProposal(proposal);
  }
  requireProposal(id: string, session?: SessionRecord) {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new AppError(404, "PROPOSAL_NOT_FOUND");
    const { room, member } = this.requireRoom(proposal.roomId, session);
    return { proposal, room, member };
  }
  publicProposal(proposal: Proposal): ProposalEnvelope {
    const room = this.rooms.get(proposal.roomId)!;
    const offer = proposal.snapshot.offer;
    const approved = [...proposal.approvals.values()].filter(value => value.status === "APPROVED" && value.proposalHash === proposal.hash);
    const shared = this.#sharedPayment(proposal);
    const paymentStatus = shared?.status === "INVALIDATED" ? "RELEASED" : shared?.status ?? "PENDING";
    const funded = shared?.proposalHash === proposal.hash && (shared.status === "AUTHORIZED" || shared.status === "CAPTURED");
    const publicProposal: PublicProposalDTO = { proposalId: proposal.id, version: proposal.version, proposalHash: proposal.hash,
      state: proposal.state, offer: this.offerDTO(offer, room, proposal.state !== "STALE"),
      equalShareCents: Math.ceil(offer.totalCents / proposal.snapshot.memberIds.length),
      approval: { approvedCount: approved.length, requiredCount: proposal.snapshot.memberIds.length },
      authorization: { status: paymentStatus, transactionCount: shared?.providerRef ? 1 : 0,
        authorizedTotalCents: funded ? shared.amountCents : 0, requiredTotalCents: offer.totalCents },
      expiresAt: proposal.snapshot.expiresAt,
      solana: proposal.solana
        ? { status: proposal.solana.status, ...(proposal.solana.transactionSignature ? { transactionSignature: proposal.solana.transactionSignature } : {}), ...(proposal.solana.explorerUrl ? { explorerUrl: proposal.solana.explorerUrl } : {}) }
        : { status: "NOT_RECORDED" },
      watch: { lastCheckedAt: proposal.watch?.lastCheckedAt ?? proposal.snapshot.createdAt,
        method: offer.source === "LITEAPI" ? "PROVIDER_REQUOTE" : offer.source === "GOOGLE_HOTELS" ? "SEARCH_TIME" : "RECORD" } };
    return { roomId: room.id, proposal: publicProposal,
      paymentModeLabel: room.trip ? (this.providers.payment ? "One shared CyberSource Visa sandbox authorization — created only after every contribution is approved" : "CyberSource sandbox credentials required before payment") : "Controlled demo shared-wallet transaction",
      bookingModeLabel: offer.source === "LITEAPI" ? "Automatic Nuitée Connect sandbox reservation with CyberSource sandbox payment"
        : offer.source === "GOOGLE_HOTELS" ? `Approved listing — the host completes the purchase on ${offer.merchantName}`
        : "Controlled demo merchant booking — no real accommodation reserved",
      inventoryLabel: isLive(room) ? "Live provider inventory" : this.inventoryLabel(room),
      canExecute: proposal.state === "READY_TO_EXECUTE" };
  }
  async privateProposal(proposal: Proposal, member: Member): Promise<PrivateProposalEnvelope> {
    if (!proposal.snapshot.memberIds.includes(member.id) || !member.constraints) throw new AppError(403, "PROPOSAL_MEMBER_ACCESS_DENIED");
    const publicPart = this.publicProposal(proposal);
    const current = proposal.state === "STALE" ? await this.currentOffer(proposal.snapshot.offer.offerId) : undefined;
    const offer = current ?? proposal.snapshot.offer;
    // A stale proposal is judged against today's group: if someone left, everyone's share went up.
    const room = this.rooms.get(proposal.roomId)!;
    const group = proposal.state === "STALE" && room.memberIds.includes(member.id) ? room.memberIds : proposal.snapshot.memberIds;
    const share = equalShares(offer.totalCents, group)[member.id]!;
    const sharedPayment = this.#sharedPayment(proposal);
    const myPaymentStatus = this.#memberPaymentStatus(proposal, member.id);
    const allocation = proposal.snapshot.contributionsCents[member.id]!;
    return { ...publicPart, myContributionCents: proposal.snapshot.contributionsCents[member.id]!,
      myApprovalStatus: proposal.approvals.get(member.id)?.status ?? "PENDING",
      myPaymentStatus,
      wallet: { currency: "USD", provider: room.trip ? "CYBERSOURCE" : "DEMO",
        heldCents: sharedPayment?.status === "AUTHORIZED" ? allocation : 0,
        spentCents: sharedPayment?.status === "CAPTURED" ? allocation : 0,
        ...(sharedPayment?.reversalRef || sharedPayment?.captureRef || sharedPayment?.providerRef ? { transactionId: sharedPayment.reversalRef ?? sharedPayment.captureRef ?? sharedPayment.providerRef } : {}) },
      myConstraintChecks: checkMember(offer, member.constraints!, share, group.length) };
  }
  /** Public view plus a public-only diff explaining why a stale proposal can no longer be used. */
  async proposalView(proposal: Proposal): Promise<ProposalEnvelope> {
    const envelope = this.publicProposal(proposal);
    if (proposal.state !== "STALE") return envelope;
    const room = this.rooms.get(proposal.roomId)!, before = proposal.snapshot.offer;
    const after = await this.currentOffer(before.offerId) ?? before;
    const changes: PublicChange[] = [];
    if (after.totalCents !== before.totalCents) changes.push({ label: "Total price", before: money(before.totalCents), after: money(after.totalCents) });
    if (after.cancellationPolicyCode !== before.cancellationPolicyCode) changes.push({ label: "Cancellation", before: cancellationLabel(before), after: cancellationLabel(after) });
    if (after.available !== before.available) changes.push({ label: "Availability", before: "Available", after: after.available ? "Available" : "No longer available" });
    if (after.roomType !== before.roomType) changes.push({ label: "Room", before: before.roomType, after: after.roomType });
    if (after.checkOutAt !== before.checkOutAt) changes.push({ label: "Checkout", before: before.checkOutAt, after: after.checkOutAt });
    if (room.memberIds.length !== proposal.snapshot.memberIds.length) changes.push({ label: "Group size", before: `${proposal.snapshot.memberIds.length} people`, after: `${room.memberIds.length} people` });
    if (room.memberIds.length && room.memberIds.length !== proposal.snapshot.memberIds.length) changes.push({ label: "Equal share", before: money(Math.ceil(before.totalCents / proposal.snapshot.memberIds.length)), after: money(Math.ceil(after.totalCents / room.memberIds.length)) });
    return { ...envelope, changes };
  }
  async consent(proposal: Proposal, room: Room, member: Member, input: { proposalHash: string; version: number; amountCents: number }, key: string) {
    if (room.activeProposalId !== proposal.id || proposal.state === "STALE" || proposal.state === "BOOKED") throw new AppError(409, "PROPOSAL_STALE");
    if (proposal.hash !== input.proposalHash || proposal.version !== input.version || proposal.snapshot.contributionsCents[member.id] !== input.amountCents) throw new AppError(409, "PROPOSAL_STALE");
    if (Date.parse(proposal.snapshot.expiresAt) <= Date.now() || member.capsuleVersion !== proposal.snapshot.privateCapsuleVersions[member.id]) throw new AppError(409, "PROPOSAL_STALE");
    if (!member.constraints) throw new AppError(409, "CONSTRAINTS_REQUIRED");
    if (checkMember(proposal.snapshot.offer, member.constraints, input.amountCents, room.memberIds.length).some(item => item.status !== "PASS")) throw new AppError(409, "OWN_CONSTRAINT_FAILED");
    const existing = proposal.approvals.get(member.id);
    if (existing?.status !== "APPROVED" || existing.proposalHash !== proposal.hash) {
      proposal.approvals.set(member.id, { status: "APPROVED", proposalHash: proposal.hash, approvedAt: nowIso() });
      this.#ledger(proposal, { type: "CONTRIBUTION_COMMITTED", memberId: member.id, amountCents: input.amountCents });
      this.emit(room, "MEMBER_APPROVED", "A member approved the exact proposal.", proposal.id);
    }
    const allApproved = proposal.snapshot.memberIds.every(id => proposal.approvals.get(id)?.status === "APPROVED");
    if (allApproved) {
      proposal.state = "READY_TO_EXECUTE";
      this.emit(room, "GROUP_APPROVED", "Everyone approved. Accord is starting the payment and booking workflow.", proposal.id);
      if (!room.trip && !this.#sharedPayment(proposal)) {
        const simulated = { status: "AUTHORIZED" as const, proposalHash: proposal.hash, amountCents: proposal.snapshot.offer.totalCents, providerRef: `sim_${randomUUID()}` };
        proposal.authorizations.set(GROUP_PAYMENT_KEY, simulated);
        this.#ledger(proposal, { type: "SHARED_AUTHORIZED", amountCents: simulated.amountCents, providerRef: simulated.providerRef });
      }
      this.providers.pulse?.event({ type: "PROPOSAL_READY", roomId: room.id, proposalId: proposal.id, metadata: { memberCount: proposal.snapshot.memberIds.length } });
      this.autopilot.onAllAuthorized(room, proposal);
      if (room.trip) await this.execute(proposal, room, this.members.get(room.hostId)!, `auto-${proposal.hash}-${key}`);
    }
    const payment = this.#sharedPayment(proposal)?.status ?? "PENDING";
    return { proposalId: proposal.id, version: proposal.version, proposalHash: proposal.hash, approvalStatus: "APPROVED" as const,
      paymentAuthorizationStatus: payment === "CAPTURED" ? "CAPTURED" as const : payment === "AUTHORIZED" ? "AUTHORIZED" as const : "PENDING" as const, amountCents: input.amountCents };
  }
  async execute(proposal: Proposal, room: Room, member: Member, key: string) {
    const active = this.#activeExecutions.get(proposal.id);
    if (active) return active;
    const running = this.#execute(proposal, room, member, key);
    this.#activeExecutions.set(proposal.id, running);
    try { return await running; }
    finally { this.#activeExecutions.delete(proposal.id); }
  }
  async #execute(proposal: Proposal, room: Room, member: Member, key: string) {
    if (room.booking && room.booking.proposalId === proposal.id) {
      if (proposal.state !== "BOOKED" && proposal.snapshot.offer.source === "LITEAPI") {
        await this.#captureSharedPayment(proposal, room);
        proposal.state = "BOOKED"; this.emit(room, "PAYMENT_RECOVERED", "The shared Visa sandbox capture completed.", proposal.id);
      }
      return this.receipt(room);
    }
    if (proposal.state !== "READY_TO_EXECUTE" || room.activeProposalId !== proposal.id) throw new AppError(409, "NOT_READY_TO_BOOK");
    if (!key || key.length > 160) throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED");
    if (proposal.hash !== proposalHash(proposal.snapshot) || proposal.snapshot.memberIds.join() !== [...room.memberIds].sort().join()) throw new AppError(409, "PROPOSAL_STALE");
    if (Date.parse(proposal.snapshot.expiresAt) <= Date.now()) { this.stale(room, "The offer expired."); throw new AppError(409, "PROPOSAL_STALE"); }
    const sum = proposal.snapshot.memberIds.reduce((total, id) => total + proposal.snapshot.contributionsCents[id]!, 0);
    if (sum !== proposal.snapshot.offer.totalCents) throw new AppError(409, "CONTRIBUTIONS_MISMATCH");
    for (const id of proposal.snapshot.memberIds) {
      const member = this.members.get(id)!;
      if (!member.constraints || member.capsuleVersion !== proposal.snapshot.privateCapsuleVersions[id] ||
          proposal.approvals.get(id)?.status !== "APPROVED" || proposal.approvals.get(id)?.proposalHash !== proposal.hash) throw new AppError(409, "MISSING_EXACT_CONSENT");
    }
    const current = await this.currentOffer(proposal.snapshot.offer.offerId);
    if (!current || !materialOfferEquals(current, proposal.snapshot.offer) || !assessOffer(current, proposal.snapshot.memberIds.map(id => ({ id, constraints: this.members.get(id)!.constraints! }))).feasible) {
      this.stale(room, "Merchant offer changed before booking."); throw new AppError(409, "PROPOSAL_STALE");
    }
    if (current.source === "LITEAPI") {
      await this.#authorizeSharedPayment(proposal, room);
      if (proposal.state !== "READY_TO_EXECUTE" || room.activeProposalId !== proposal.id) {
        await this.#releaseSharedPayment(proposal, room);
        throw new AppError(409, "PROPOSAL_STALE");
      }
      try { return await this.#bookLiteApi(proposal, room, member, current, key); }
      catch (error) { if (!room.booking) await this.#releaseSharedPayment(proposal, room); throw error; }
    }
    if (current.source === "GOOGLE_HOTELS") {
      room.booking = { reference: `approved-${proposal.hash.slice(0, 10)}`, confirmedAt: nowIso(), proposalId: proposal.id, mode: "EXTERNAL", ...(current.externalUrl ? { externalUrl: current.externalUrl } : {}) };
      proposal.state = "BOOKED"; this.#dirtyRooms.add(room.id);
      this.emit(room, "BOOKING_HANDOFF", `Everyone approved the exact listing. The host completes the purchase on ${current.merchantName}.`, proposal.id);
      return this.receipt(room);
    }
    let booking;
    try { booking = await this.merchant.execute({ offerId: current.offerId, expectedOfferVersion: current.offerVersion, idempotencyKey: key }); }
    catch { throw new AppError(409, "MERCHANT_BOOKING_FAILED"); }
    room.booking = { reference: booking.bookingReference, confirmedAt: booking.confirmedAt, proposalId: proposal.id };
    const simulated = this.#sharedPayment(proposal);
    if (simulated?.status === "AUTHORIZED") {
      simulated.status = "CAPTURED"; simulated.captureRef = `sim_capture_${randomUUID()}`;
      this.#ledger(proposal, { type: "SHARED_CAPTURED", amountCents: simulated.amountCents, providerRef: simulated.captureRef });
    }
    proposal.state = "BOOKED"; this.#dirtyRooms.add(room.id);
    try { await this.store.drain(async (_eventId, event) => { if (event.type === "BOOKING_CONFIRMED") this.emit(room, "BOOKING_CONFIRMED", "One controlled demo booking was confirmed.", proposal.id); }); }
    catch { /* Booking is confirmed. A failed optional event fanout cannot erase the receipt. */ }
    void this.#recordSolanaCommitment(room, proposal, "BOOKING_CONFIRMED");
    return this.receipt(room);
  }
  async #authorizeSharedPayment(proposal: Proposal, room: Room) {
    const gateway = this.providers.payment;
    if (!gateway) throw new AppError(503, "PAYMENT_PROVIDER_UNAVAILABLE");
    const existing = this.#sharedPayment(proposal);
    if (existing?.proposalHash === proposal.hash && (existing.status === "AUTHORIZED" || existing.status === "CAPTURED")) return;
    const amountCents = proposal.snapshot.offer.totalCents;
    const host = this.members.get(room.hostId)!;
    const [firstName, ...last] = host.displayName.trim().split(/\s+/);
    try {
      const payment = await gateway.authorize({ amountCents, currency: "USD", reference: `accord-${proposal.id.slice(0, 8)}-group-auth`, firstName: firstName || "Accord", lastName: last.join(" ") || "Group" });
      proposal.authorizations.set(GROUP_PAYMENT_KEY, { proposalHash: proposal.hash, amountCents, status: "AUTHORIZED", providerRef: payment.id });
      this.#ledger(proposal, { type: "SHARED_AUTHORIZED", amountCents, providerRef: payment.id });
      this.emit(room, "PAYMENT_AUTHORIZED", `One shared Visa sandbox authorization secured ${money(amountCents)} for the approved group total.`, proposal.id);
      await this.flush();
    } catch {
      proposal.authorizations.set(GROUP_PAYMENT_KEY, { proposalHash: proposal.hash, amountCents, status: "FAILED", providerRef: "" });
      this.#ledger(proposal, { type: "SHARED_AUTHORIZATION_FAILED", amountCents });
      this.emit(room, "PAYMENT_FAILED", "CyberSource could not authorize the shared group total. No booking was made.", proposal.id);
      throw new AppError(502, "PAYMENT_AUTHORIZATION_FAILED");
    }
  }
  async #captureSharedPayment(proposal: Proposal, room: Room) {
    const gateway = this.providers.payment;
    if (!gateway) throw new AppError(503, "PAYMENT_PROVIDER_UNAVAILABLE");
    const authorization = this.#sharedPayment(proposal);
    if (authorization?.status === "CAPTURED") return;
    if (!authorization || authorization.status !== "AUTHORIZED") throw new AppError(409, "MISSING_EXACT_CONSENT");
    try {
      const capture = await gateway.capture(authorization.providerRef, { amountCents: authorization.amountCents, currency: "USD", reference: `accord-${proposal.id.slice(0, 8)}-group-capture` });
      authorization.status = "CAPTURED"; authorization.captureRef = capture.id;
      this.#ledger(proposal, { type: "SHARED_CAPTURED", amountCents: authorization.amountCents, providerRef: capture.id });
      this.emit(room, "PAYMENT_CAPTURED", `The shared Visa sandbox payment captured ${money(authorization.amountCents)} in one transaction.`, proposal.id);
      await this.flush();
    } catch {
      this.#ledger(proposal, { type: "SHARED_CAPTURE_FAILED", amountCents: authorization.amountCents, providerRef: authorization.providerRef });
      this.emit(room, "PAYMENT_FAILED", "The hotel reservation succeeded, but the shared CyberSource capture needs review.", proposal.id);
      throw new AppError(502, "PAYMENT_CAPTURE_FAILED");
    }
  }
  async #releaseSharedPayment(proposal: Proposal, room: Room) {
    const active = this.#activeReversals.get(proposal.id);
    if (active) return active;
    const running = this.#releaseSharedPaymentOnce(proposal, room);
    this.#activeReversals.set(proposal.id, running);
    try { await running; }
    finally { this.#activeReversals.delete(proposal.id); }
  }
  async #releaseSharedPaymentOnce(proposal: Proposal, room: Room) {
    const authorization = this.#sharedPayment(proposal);
    if (!authorization || (authorization.status !== "AUTHORIZED" && authorization.status !== "INVALIDATED") || !authorization.providerRef) return;
    if (authorization.providerRef.startsWith("sim_")) {
      authorization.status = "RELEASED"; authorization.reversalRef = `sim_reversal_${randomUUID()}`;
      this.#ledger(proposal, { type: "SHARED_RELEASED", amountCents: authorization.amountCents, providerRef: authorization.reversalRef });
      this.emit(room, "PAYMENT_RELEASED", "The unused shared demo authorization was released.", proposal.id);
      await this.flush();
      return;
    }
    const gateway = this.providers.payment;
    if (!gateway) return;
    try {
      const reversal = await gateway.reverse(authorization.providerRef, { amountCents: authorization.amountCents, reference: `accord-${proposal.id.slice(0, 8)}-group-reverse` });
      authorization.status = "RELEASED"; authorization.reversalRef = reversal.id;
      this.#ledger(proposal, { type: "SHARED_RELEASED", amountCents: authorization.amountCents, providerRef: reversal.id });
      this.emit(room, "PAYMENT_RELEASED", `The unused ${money(authorization.amountCents)} shared Visa sandbox authorization was reversed.`, proposal.id);
    } catch {
      authorization.status = "FAILED";
      this.#ledger(proposal, { type: "SHARED_RELEASE_FAILED", amountCents: authorization.amountCents, providerRef: authorization.providerRef });
      this.emit(room, "PAYMENT_RELEASE_FAILED", "The shared Visa sandbox authorization reversal needs review. No booking was confirmed.", proposal.id);
    }
    await this.flush();
  }
  /** Re-quotes the exact room with LiteAPI; any price or terms change stales consent instead of booking. */
  async #bookLiteApi(proposal: Proposal, room: Room, host: Member, offer: Offer, key: string) {
    const liteApi = this.providers.liteApi, ref = proposal.providerRef;
    if (!liteApi || !room.trip || ref?.provider !== "LITEAPI") throw new AppError(503, "BOOKING_PROVIDER_UNAVAILABLE");
    return this.#serialize(async () => {
      if (room.booking?.proposalId === proposal.id) return this.receipt(room);
      let quote;
      try { quote = await liteApi.requote(room.trip!, ref); } catch { throw new AppError(503, "BOOKING_PROVIDER_UNAVAILABLE"); }
      if (await this.#staleOnQuoteChange(room, offer, ref, quote, "before booking") || !quote) throw new AppError(409, "PROPOSAL_STALE");
      let result;
      try {
        const prebook = await liteApi.prebook(quote.offerId);
        if (Math.abs(prebook.priceCents - offer.totalCents) > 1 || prebook.cancellationChanged) {
          await this.#reviseOffer(offer.offerId, { totalCents: prebook.priceCents, subtotalCents: prebook.priceCents, mandatoryFeesCents: 0 });
          this.stale(room, "The price changed at checkout."); throw new AppError(409, "PROPOSAL_STALE");
        }
        if (proposal.state !== "READY_TO_EXECUTE" || room.activeProposalId !== proposal.id) throw new AppError(409, "PROPOSAL_STALE");
        const [firstName, ...rest] = host.displayName.trim().split(/\s+/);
        result = await liteApi.book({ prebookId: prebook.prebookId, firstName: firstName || "Accord", lastName: rest.join(" ") || "Guest", email: "sandbox-guest@example.com", clientReference: key.slice(0, 64) });
      } catch (error) { if (error instanceof AppError) throw error; throw new AppError(409, "MERCHANT_BOOKING_FAILED"); }
      if (result.status !== "CONFIRMED") throw new AppError(409, "MERCHANT_BOOKING_FAILED");
      room.booking = { reference: result.bookingId, confirmedAt: nowIso(), proposalId: proposal.id, mode: "SANDBOX", ...(result.hotelConfirmationCode ? { hotelConfirmationCode: result.hotelConfirmationCode } : {}) };
      this.#dirtyRooms.add(room.id);
      await this.flush();
      await this.#captureSharedPayment(proposal, room);
      proposal.state = "BOOKED"; this.#dirtyRooms.add(room.id);
      this.emit(room, "BOOKING_CONFIRMED", `Nuitée Connect sandbox booking ${result.bookingId} and one shared CyberSource sandbox payment confirmed.`, proposal.id);
      void this.#recordSolanaCommitment(room, proposal, "BOOKING_CONFIRMED");
      return this.receipt(room);
    });
  }
  /** Records a changed or withdrawn LiteAPI quote as a new offer version and stales consent. Returns whether it did. */
  async #staleOnQuoteChange(room: Room, offer: Offer, ref: LiteRef, quote: Awaited<ReturnType<LiteApi["requote"]>>, when: string) {
    if (!quote) { await this.#reviseOffer(offer.offerId, { available: false }); this.stale(room, "The room is no longer offered."); return true; }
    if (quote.totalCents === offer.totalCents && quote.refundableTag === ref.refundableTag) return false;
    await this.#reviseOffer(offer.offerId, { totalCents: quote.totalCents, subtotalCents: quote.totalCents, mandatoryFeesCents: 0,
      ...(quote.refundableTag !== ref.refundableTag ? { cancellationPolicyCode: "NON_REFUNDABLE" as const, fullRefundDeadline: undefined } : {}) });
    this.stale(room, `The live price or terms changed ${when}.`);
    return true;
  }
  /** Coordinator watch: confirm the active offer still matches what the group is approving. */
  async recheck(proposal: Proposal) {
    const room = this.rooms.get(proposal.roomId)!;
    const active = () => room.activeProposalId === proposal.id && (proposal.state === "OPEN" || proposal.state === "READY_TO_EXECUTE");
    const offer = proposal.snapshot.offer;
    if (!active() || offer.source === "GOOGLE_HOTELS") return;
    if (offer.source === "LITEAPI") {
      const liteApi = this.providers.liteApi, ref = proposal.providerRef;
      if (!liteApi || !room.trip || ref?.provider !== "LITEAPI") return;
      let quote;
      const started = performance.now();
      try { quote = await liteApi.requote(room.trip, ref); } catch { return; }
      if (!active()) return;
      if (await this.#staleOnQuoteChange(room, offer, ref, quote, "while the group was deciding")) {
        // Time from starting the live price check to invalidating everyone's approval.
        this.providers.pulse?.event({ type: "STALE_DETECTED", roomId: room.id, proposalId: proposal.id, offerId: offer.offerId, latencyMs: performance.now() - started });
        return;
      }
    } else {
      const current = await this.currentOffer(offer.offerId);
      if (!active()) return;
      if (!current || !materialOfferEquals(current, offer)) { this.stale(room, "Merchant offer changed."); return; }
    }
    proposal.watch = { ...proposal.watch, lastCheckedAt: nowIso() };
    this.#dirtyRooms.add(room.id);
  }
  #bookingTail: Promise<unknown> = Promise.resolve();
  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#bookingTail.then(run, run);
    this.#bookingTail = next.catch(() => undefined);
    return next;
  }
  /** Optional AI summary from public listing facts only; never affects feasibility or ranking. */
  async #summarize(room: Room, offerIds: string[]) {
    const summarize = this.providers.summarize;
    if (!summarize || !room.search) return;
    try {
      const offers = await this.allOffers(offerIds);
      await Promise.all(offers.map(async offer => {
        const research = room.search?.research[offer.offerId];
        if (!research || research.summary) return;
        const summary = await summarize({ name: offer.propertyName, city: offer.city, room: offer.roomType, rating: offer.rating, reviews: offer.reviewCount,
          cancellation: cancellationLabel(offer), walkable: offer.walkable, nearActivities: offer.nearActivities, pros: research.pros, cons: research.cons, nearby: research.nearby }).catch(() => undefined);
        if (summary) research.summary = summary;
      }));
      this.emit(room, "RESEARCH_READY", "Accord added research notes to the top stays.");
      await this.flush();
    } catch { /* Research is optional. */ }
  }
  /** Best-effort devnet commitment of this exact proposal version. Never blocks or changes consent/booking. */
  async #recordSolanaCommitment(room: Room, proposal: Proposal, eventType: CommitmentInput["eventType"]) {
    const solana = this.providers.solana;
    if (!solana) return;
    try {
      const input: CommitmentInput = { roomPublicRef: room.id, proposalId: proposal.id, proposalVersion: proposal.version, proposalHash: proposal.hash, eventType };
      const result = await solana.record(input, async pending => {
        proposal.solana = { status: "PENDING", transactionSignature: pending.transactionSignature };
        this.#dirtyRooms.add(room.id);
        await this.flush();
      });
      proposal.solana = { status: result.status, ...(result.transactionSignature ? { transactionSignature: result.transactionSignature } : {}),
        ...(result.explorerUrl ? { explorerUrl: result.explorerUrl } : {}), ...(result.code ? { code: result.code } : {}) };
      this.#dirtyRooms.add(room.id);
      await this.flush();
    } catch { /* Advisory only; never affects consent or booking. */ }
  }
  receipt(room: Room): ReceiptDTO {
    if (!room.booking) throw new AppError(404, "BOOKING_NOT_FOUND");
    const proposal = this.proposals.get(room.booking.proposalId)!, offer = proposal.snapshot.offer;
    const shared = this.#sharedPayment(proposal);
    const payment = shared?.status === "CAPTURED" ? {
      provider: room.booking.mode === "SANDBOX" ? "CYBERSOURCE" as const : "SIMULATED" as const,
      environment: room.booking.mode === "SANDBOX" ? "SANDBOX" as const : "DEMO" as const,
      status: "CAPTURED" as const, transactionCount: 1, capturedTotalCents: shared.amountCents,
      transactionId: shared.captureRef ?? shared.providerRef,
    } : { provider: "SIMULATED" as const, environment: "DEMO" as const, status: "NOT_CAPTURED" as const, transactionCount: 0, capturedTotalCents: 0 };
    const base = { bookingReference: room.booking.reference, bookedAt: room.booking.confirmedAt, guestCount: proposal.snapshot.memberIds.length, payment, proposal: this.publicProposal(proposal).proposal };
    if (room.booking.mode === "SANDBOX") return { ...base, status: "CONFIRMED",
      providerModeLabel: "Nuitée Connect SANDBOX reservation + CyberSource Visa SANDBOX payment",
      confirmationLabel: `Reserved through Nuitée Connect at the exact price everyone approved${room.booking.hotelConfirmationCode ? ` (hotel code ${room.booking.hotelConfirmationCode})` : ""}. CyberSource captured one shared ${money(payment.capturedTotalCents)} sandbox payment.` };
    if (room.booking.mode === "EXTERNAL") return { ...base, status: "HANDOFF", ...(room.booking.externalUrl ? { externalUrl: room.booking.externalUrl } : {}),
      providerModeLabel: `Complete on ${offer.merchantName}`,
      confirmationLabel: `Everyone approved this exact listing at ${money(offer.totalCents)}. Accord doesn't sell this listing: the host completes the purchase on ${offer.merchantName}. No payment was captured.` };
    return { ...base, status: "CONFIRMED",
      providerModeLabel: "SIMULATED — no card charged", confirmationLabel: "Controlled demo merchant booking only; no real accommodation reserved." };
  }
  stale(room: Room, detail: string) {
    const proposal = room.activeProposalId ? this.proposals.get(room.activeProposalId) : undefined;
    if (!proposal || proposal.state === "STALE" || proposal.state === "BOOKED" || room.booking?.proposalId === proposal.id) return;
    proposal.state = "STALE";
    for (const approval of proposal.approvals.values()) approval.status = "INVALIDATED";
    for (const authorization of proposal.authorizations.values()) authorization.status = "INVALIDATED";
    this.emit(room, "PROPOSAL_STALE", `Accord cancelled every approval for Proposal v${proposal.version}. ${detail}`, proposal.id,
      { actor: "ACCORD", detail: "Old approvals can’t be used for changed terms, so nothing was booked." });
    for (const id of room.memberIds) this.streams.publishPrivate(room.id, id, randomUUID(), { roomId: room.id, type: "PROPOSAL_STALE", proposalId: proposal.id, at: nowIso() });
    if (this.#sharedPayment(proposal)?.providerRef) setImmediate(() => void this.#releaseSharedPayment(proposal, room).catch(() => undefined));
    void this.#recordSolanaCommitment(room, proposal, "PROPOSAL_STALE");
    this.autopilot.onStale(room, proposal);
  }
  async mutate(offerId: string, expectedVersion: string, mutation: MerchantMutation) {
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const previous = this.#mutationTail;
    this.#mutationTail = next;
    await previous;
    try {
      const before = await this.currentOffer(offerId);
      if (!before) throw new AppError(404, "OFFER_NOT_FOUND");
      if (before.offerVersion !== expectedVersion) throw new AppError(409, "OFFER_VERSION_MISMATCH");
      let after: Offer;
      try { after = await this.merchant.mutate(offerId, mutation); }
      catch { throw new AppError(422, "INVALID_MERCHANT_MUTATION"); }
      await this.store.drain(async (_eventId, event) => {
        if (event.type !== "MERCHANT_OFFER_MUTATED") return;
        for (const room of this.rooms.values()) {
          if (!this.offerIdsFor(room).includes(offerId) && this.proposals.get(room.activeProposalId ?? "")?.snapshot.offer.offerId !== offerId) continue;
          this.emit(room, "MERCHANT_OFFER_MUTATED", `The merchant changed ${after.propertyName}.`, room.activeProposalId, { actor: "MERCHANT" });
          if (room.activeProposalId && this.proposals.get(room.activeProposalId)?.snapshot.offer.offerId === offerId) this.stale(room, `The merchant changed ${after.propertyName}.`);
          else this.autopilot.onOfferChanged(room);
        }
      });
      return after;
    } finally { release(); }
  }
  emit(room: Room, type: string, title: string, proposalId?: string, extra: Pick<EventDTO, "detail" | "actor"> = {}) {
    const event: EventDTO = { id: randomUUID(), occurredAt: nowIso(), title, ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.actor ? { actor: extra.actor } : {}) };
    room.events.push(event); this.#dirtyRooms.add(room.id);
    this.streams.publishPublic(room.id, event.id, { roomId: room.id, type, proposalId, at: event.occurredAt });
    this.providers.pulse?.event({ type, roomId: room.id, ...(proposalId ? { proposalId } : {}) });
  }
  #addSession(id: string, userId: string, roomId?: string, memberId?: string) {
    this.sessions.set(id, { userId, ...(roomId ? { roomId } : {}), ...(memberId ? { memberId } : {}), createdAt: nowIso() }); this.#dirtySessions.add(id);
  }
  #addInvitation(id: string, roomId: string) {
    this.invitations.set(id, roomId); this.#dirtyInvitations.add(id);
  }
  #aggregate(room: Room): RoomAggregate {
    const sealer = this.persistence!.sealer;
    const { id, events, planning, ...rest } = room;
    const sealedPlanning = planning && { ...structuredClone(planning), votes: {}, sealedVotes: sealer.seal(planning.votes) };
    return {
      room: { _id: id, ...structuredClone(rest), ...(sealedPlanning ? { planning: sealedPlanning } : {}), events: events.slice(-200) },
      users: [...new Set(room.memberIds.map(memberId => this.members.get(memberId)!.userId))].map(userId => {
        const { id: _id, ...fields } = this.users.get(userId)!;
        return { _id, ...fields };
      }),
      members: room.memberIds.map(memberId => {
        const { id: _id, constraints, inbox, ...fields } = this.members.get(memberId)!;
        return { _id, ...fields, sealedConstraints: constraints ? sealer.seal(constraints) : null, sealedInbox: inbox?.length ? sealer.seal(inbox) : null };
      }),
      proposals: [...this.proposals.values()].filter(proposal => proposal.roomId === room.id).map(proposal => ({
        _id: proposal.id, roomId: proposal.roomId, version: proposal.version, hash: proposal.hash, state: proposal.state, providerRef: proposal.providerRef ?? null, watch: proposal.watch ?? null,
        solana: proposal.solana ?? null,
        snapshot: structuredClone(proposal.snapshot),
        approvals: Object.fromEntries(proposal.approvals), authorizations: Object.fromEntries(proposal.authorizations), ledger: structuredClone(proposal.ledger),
      })),
    };
  }
  /** Persists everything changed since the last flush in one Mongo transaction. No-op in memory mode. */
  async flush() {
    const rooms = [...this.#dirtyRooms], users = [...this.#dirtyUsers], sessions = [...this.#dirtySessions], invitations = [...this.#dirtyInvitations];
    const removed = { members: [...this.#removedMembers], sessions: [...this.#removedSessions] };
    this.#dirtyRooms.clear(); this.#dirtyUsers.clear(); this.#dirtySessions.clear(); this.#dirtyInvitations.clear(); this.#removedMembers.clear(); this.#removedSessions.clear();
    if (!this.persistence || (!rooms.length && !users.length && !sessions.length && !invitations.length && !removed.members.length && !removed.sessions.length)) return;
    try {
      await this.persistence.save(
        rooms.map(id => this.rooms.get(id)).filter((room): room is Room => Boolean(room)).map(room => this.#aggregate(room)),
        users.flatMap(id => { const user = this.users.get(id); if (!user) return []; const { id: _id, ...fields } = user; return [{ _id, ...fields }]; }),
        sessions.flatMap(id => { const value = this.sessions.get(id); return value ? [{ id, value }] : []; }),
        invitations.flatMap(id => { const roomId = this.invitations.get(id); return roomId ? [{ id, roomId }] : []; }), removed);
    } catch {
      // Keep them dirty so the next flush retries; the caller reports the failure.
      rooms.forEach(id => this.#dirtyRooms.add(id)); users.forEach(id => this.#dirtyUsers.add(id)); sessions.forEach(id => this.#dirtySessions.add(id)); invitations.forEach(id => this.#dirtyInvitations.add(id));
      removed.members.forEach(id => this.#removedMembers.add(id)); removed.sessions.forEach(id => this.#removedSessions.add(id));
      throw new AppError(503, "PERSISTENCE_UNAVAILABLE");
    }
  }
  async #hydrate() {
    const sealer = this.persistence!.sealer;
    const data = await this.persistence!.load();
    for (const doc of data.rooms) {
      const { _id, planning, ...rest } = doc;
      const { sealedVotes, ...plan } = planning ?? {};
      this.rooms.set(String(_id), { ...(rest as Omit<Room, "id">), id: String(_id), searching: false,
        ...(planning ? { planning: { ...plan, votes: sealedVotes ? sealer.open<Record<string, string>>(sealedVotes as SealedValue) : {} } as NonNullable<Room["planning"]> } : {}) });
    }
    for (const doc of data.users) {
      const { _id, ...rest } = doc;
      const user = { ...(rest as Omit<User, "id">), id: String(_id) };
      this.users.set(String(_id), user);
      if (user.email) this.userIdsByEmail.set(normalizeEmail(user.email), user.id);
    }
    for (const doc of data.members) {
      const { _id, sealedConstraints, sealedInbox, ...rest } = doc;
      const userId = String(rest.userId ?? _id);
      if (!this.users.has(userId)) this.users.set(userId, { id: userId, displayName: String(rest.displayName), createdAt: nowIso() });
      this.members.set(String(_id), { ...(rest as Omit<Member, "id" | "constraints" | "userId" | "inbox">), id: String(_id), userId,
        constraints: sealedConstraints ? sealer.open<Constraints>(sealedConstraints as SealedValue) : null,
        ...(sealedInbox ? { inbox: sealer.open<InboxEntry[]>(sealedInbox as SealedValue) } : {}) });
    }
    for (const doc of data.proposals) {
      this.proposals.set(String(doc._id), { id: String(doc._id), roomId: doc.roomId, version: doc.version, hash: doc.hash, state: doc.state, ...(doc.providerRef ? { providerRef: doc.providerRef } : {}), ...(doc.watch ? { watch: doc.watch } : {}), ...(doc.solana ? { solana: doc.solana } : {}),
        snapshot: { ...doc.snapshot, offer: compatibleOffer(doc.snapshot.offer) }, approvals: new Map(Object.entries(doc.approvals ?? {})), authorizations: new Map(Object.entries(doc.authorizations ?? {})),
        ledger: Array.isArray(doc.ledger) ? doc.ledger as PaymentLedgerEntry[] : [] });
    }
    for (const doc of data.sessions) this.sessions.set(String(doc._id), { userId: String(doc.userId ?? doc.memberId), ...(doc.roomId ? { roomId: String(doc.roomId) } : {}), ...(doc.memberId ? { memberId: String(doc.memberId) } : {}), createdAt: new Date(doc.createdAt).toISOString() });
    for (const doc of data.invitations) this.invitations.set(String(doc._id), doc.roomId);
  }

  async #migrateStoredOffers() {
    const ids = new Set([...this.catalogIds, ...[...this.rooms.values()].flatMap(room => room.search?.offerIds ?? [])]);
    await this.store.transaction(async tx => {
      for (const id of ids) {
        const record = await tx.getOffer(id);
        if (!record) continue;
        await tx.putOffer(id, { ...record, offer: compatibleOffer(record.offer), original: compatibleOffer(record.original) });
      }
    });
  }
}
