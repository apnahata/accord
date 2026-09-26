import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  applyMerchantMutation, assessOffer, checkMember, demoCatalog, equalShares, materialOfferEquals,
  MerchantEventSchema, MerchantMutationSchema, OfferSchema, proposalHash, PublicEventSchema, PrivateEventSchema,
  type Constraints, type MerchantEvent, type MerchantMutation, type Offer,
  type PublicRoomDTO, type PublicOfferDTO, type PublicProposalDTO, type ProposalEnvelope,
  type PrivateProposalEnvelope, type OffersDTO, type ReceiptDTO, type EventDTO,
} from "@accord/domain";
import { Merchant, type MerchantContract } from "../../integrations/src/merchant.js";
import { RoomStreams } from "../../integrations/src/realtime.js";
import { MemoryMerchantStore } from "./memory-merchant.js";
import { SESSION_TTL_SECONDS, type MongoPersistence, type RoomAggregate, type SealedValue, type SessionRecord } from "./persistence.js";

export class AppError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
type Member = { id: string; roomId: string; displayName: string; constraints: Constraints | null; confirmedAt?: string; capsuleVersion: number };
type Approval = { proposalHash: string; status: "APPROVED" | "INVALIDATED"; approvedAt: string };
type Authorization = { proposalHash: string; amountCents: number; status: "AUTHORIZED" | "INVALIDATED"; providerRef: string };
type Proposal = {
  id: string; roomId: string; version: number; hash: string; snapshot: {
    roomId: string; proposalId: string; version: number; memberIds: string[]; offer: Offer;
    contributionsCents: Record<string, number>; privateCapsuleVersions: Record<string, number>;
    createdAt: string; expiresAt: string;
  };
  state: "OPEN" | "READY_TO_EXECUTE" | "STALE" | "BOOKED" | "CANCELLED";
  approvals: Map<string, Approval>; authorizations: Map<string, Authorization>;
};
type Room = {
  id: string; name: string; goal: string; inviteToken: string; hostId: string;
  memberIds: string[]; createdAt: string; activeProposalId?: string; version: number;
  events: EventDTO[]; booking?: { reference: string; confirmedAt: string; proposalId: string };
};

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
type MerchantBackend = {
  transaction: MemoryMerchantStore<Offer, MerchantEvent>["transaction"];
  drain(deliver: (id: string, event: MerchantEvent) => Promise<void>): Promise<number>;
};
const inventoryLabel = "Controlled synthetic demo merchant inventory — no real accommodation is reserved";

export class AccordState {
  readonly rooms = new Map<string, Room>();
  readonly members = new Map<string, Member>();
  readonly proposals = new Map<string, Proposal>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly invitations = new Map<string, string>();
  readonly store: MerchantBackend;
  readonly merchant: Merchant<Offer, MerchantMutation, MerchantEvent>;
  readonly catalogIds = demoCatalog().map(offer => offer.offerId);
  readonly ready: Promise<void>;
  readonly streams: RoomStreams<z.infer<typeof PublicEventSchema>, z.infer<typeof PrivateEventSchema>>;
  #mutationTail: Promise<void> = Promise.resolve();
  #dirtyRooms = new Set<string>();
  #dirtySessions = new Set<string>();
  #dirtyInvitations = new Set<string>();

  /** Without persistence, state is process memory only. With Mongo, memory is a write-through working copy. */
  constructor(readonly persistence?: MongoPersistence) {
    this.store = persistence ? persistence.merchantStore as MerchantBackend : new MemoryMerchantStore<Offer, MerchantEvent>();
    const merchant = this.merchant = new Merchant(this.store, merchantContract);
    this.ready = (async () => { if (persistence) await this.#hydrate(); await merchant.seed(demoCatalog()); })();
    this.streams = new RoomStreams(PublicEventSchema, PrivateEventSchema, async request => {
      const session = this.sessionFromCookie(request.headers.cookie);
      return session ? { roomId: session.roomId, memberId: session.memberId } : null;
    });
  }
  sessionFromCookie(cookie?: string) {
    const value = cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("accord_session="))?.slice("accord_session=".length);
    const session = value ? this.sessions.get(hashToken(value)) : undefined;
    return session && Date.parse(session.createdAt) + SESSION_TTL_SECONDS * 1000 > Date.now() ? session : undefined;
  }
  createRoom(name: string, goal: string, displayName: string) {
    const roomId = randomUUID(), memberId = randomUUID(), inviteToken = token(), sessionToken = token();
    const room: Room = { id: roomId, name, goal, inviteToken, hostId: memberId, memberIds: [memberId], createdAt: nowIso(), version: 0, events: [] };
    this.rooms.set(roomId, room); this.#addInvitation(hashToken(inviteToken), roomId);
    this.members.set(memberId, { id: memberId, roomId, displayName, constraints: null, capsuleVersion: 0 });
    this.#addSession(hashToken(sessionToken), roomId, memberId);
    this.emit(room, "MEMBER_JOINED", "One member joined the room.");
    return { roomId, inviteToken, sessionToken };
  }
  previewInvite(inviteToken: string) {
    const room = this.rooms.get(this.invitations.get(hashToken(inviteToken)) ?? "");
    if (!room) throw new AppError(404, "INVITE_NOT_FOUND");
    return { name: room.name, goal: room.goal, memberCount: room.memberIds.length };
  }
  join(inviteToken: string, displayName: string) {
    const room = this.rooms.get(this.invitations.get(hashToken(inviteToken)) ?? "");
    if (!room) throw new AppError(404, "INVITE_NOT_FOUND");
    if (room.memberIds.length >= 8) throw new AppError(409, "ROOM_FULL");
    const memberId = randomUUID(), sessionToken = token();
    this.members.set(memberId, { id: memberId, roomId: room.id, displayName, constraints: null, capsuleVersion: 0 });
    room.memberIds.push(memberId);
    this.#addSession(hashToken(sessionToken), room.id, memberId);
    this.stale(room, "The member set changed.");
    this.emit(room, "MEMBER_JOINED", "A member joined the room.");
    return { roomId: room.id, sessionToken };
  }
  requireRoom(roomId: string, session?: { roomId: string; memberId: string }) {
    const room = this.rooms.get(roomId);
    if (!room) throw new AppError(404, "ROOM_NOT_FOUND");
    if (!session || session.roomId !== roomId || !room.memberIds.includes(session.memberId)) throw new AppError(403, "ROOM_ACCESS_DENIED");
    return { room, member: this.members.get(session.memberId)! };
  }
  requireHost(roomId: string, session?: { roomId: string; memberId: string }) {
    const { room, member } = this.requireRoom(roomId, session);
    if (member.id !== room.hostId) throw new AppError(403, "ADMIN_ACCESS_DENIED");
    return { room, member };
  }
  roomDTO(room: Room): PublicRoomDTO {
    const proposal = room.activeProposalId ? this.proposals.get(room.activeProposalId) : undefined;
    return { id: room.id, name: room.name, goal: room.goal,
      status: room.booking ? "BOOKED" : proposal?.state === "STALE" ? "STALE" : proposal ? "PROPOSAL_ACTIVE" : "COLLECTING",
      memberCount: room.memberIds.length,
      readyMemberCount: room.memberIds.filter(id => this.members.get(id)?.constraints).length,
      activeProposalId: room.activeProposalId };
  }
  confirmConstraints(room: Room, member: Member, constraints: Constraints) {
    member.constraints = structuredClone(constraints); member.capsuleVersion++; member.confirmedAt = nowIso();
    this.stale(room, "Confirmed requirements changed.");
    this.emit(room, "CONSTRAINTS_CONFIRMED", "A member confirmed private requirements.");
    this.streams.publishPrivate(room.id, member.id, randomUUID(), { roomId: room.id, type: "CONSTRAINTS_CONFIRMED", at: nowIso() });
  }
  async currentOffer(id: string) {
    await this.ready;
    return this.store.transaction(async tx => (await tx.getOffer(id))?.offer);
  }
  async allOffers(): Promise<Offer[]> {
    await this.ready;
    // Sequential: Mongo transactions do not support concurrent operations on one session.
    return this.store.transaction(async tx => {
      const offers: Offer[] = [];
      for (const id of this.catalogIds) offers.push((await tx.getOffer(id))!.offer);
      return offers;
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
      checkInAt: offer.checkInAt, checkOutAt: offer.checkOutAt, guestCapacity: offer.guestCapacity,
      stepFreeVerified: offer.stepFreeVerified,
      cancellationLabel: offer.cancellationPolicyCode === "FULL_CASH_REFUND" ? "Full cash refund" : offer.cancellationPolicyCode === "TRAVEL_CREDIT" ? "Travel credit only" : "Non-refundable",
      subtotalCents: offer.subtotalCents, mandatoryFeesCents: offer.mandatoryFeesCents, totalCents: offer.totalCents,
      equalShareCents: Math.ceil(offer.totalCents / room.memberIds.length), available: offer.available, expiresAt: offer.expiresAt,
      feasible, publicFeasibilityMessage: feasible ? "Meets every confirmed requirement." : "Does not meet all confirmed requirements." };
  }
  async offers(room: Room): Promise<OffersDTO> {
    const members = this.confirmed(room), offers = await this.allOffers();
    const assessments = offers.map(offer => ({ offer, assessed: assessOffer(offer, members) }));
    const feasible = assessments.filter(item => item.assessed.feasible);
    const minTotal = feasible.length ? Math.min(...feasible.map(item => item.offer.totalCents)) : 0;
    const ranked = [...feasible].sort((a, b) => this.score(b.offer, members, minTotal) - this.score(a.offer, members, minTotal) || a.offer.totalCents - b.offer.totalCents);
    const recommended = ranked[0]?.offer;
    return { inventoryLabel, offers: assessments.map(item => this.offerDTO(item.offer, room, item.assessed.feasible)),
      recommendedOfferId: recommended?.offerId,
      recommendationReasons: recommended ? ["Meets every confirmed requirement.", "Matches confirmed group preferences."] : [],
      funnel: [{ label: "Demo stays checked", count: offers.length }, { label: "Current and available", count: offers.filter(offer => offer.available).length }, { label: "Suitable for everyone", count: feasible.length }] };
  }
  async solve(room: Room): Promise<ProposalEnvelope | { noSolution: true }> {
    const members = this.confirmed(room);
    this.emit(room, "SOLVE_STARTED", "Accord started checking current demo stays.");
    const data = await this.offers(room);
    if (!data.recommendedOfferId) { this.emit(room, "SOLVE_COMPLETED", "No current stay satisfies every confirmed requirement."); return { noSolution: true }; }
    const offer = (await this.currentOffer(data.recommendedOfferId))!;
    const assessment = assessOffer(offer, members);
    if (!assessment.feasible) throw new AppError(409, "OFFER_CHANGED");
    const id = randomUUID(), version = ++room.version, createdAt = nowIso();
    const snapshot = { roomId: room.id, proposalId: id, version, memberIds: [...room.memberIds].sort(),
      offer: structuredClone(offer), contributionsCents: assessment.shares,
      privateCapsuleVersions: Object.fromEntries(members.map(member => [member.id, member.capsuleVersion])),
      createdAt, expiresAt: offer.expiresAt };
    const proposal: Proposal = { id, roomId: room.id, version, hash: proposalHash(snapshot), snapshot, state: "OPEN", approvals: new Map(), authorizations: new Map() };
    this.proposals.set(id, proposal); room.activeProposalId = id;
    this.emit(room, "SOLVE_COMPLETED", `Accord evaluated ${data.offers.length} demo stays.`);
    this.emit(room, "PROPOSAL_CREATED", `Proposal v${version} opened.`, id);
    return this.publicProposal(proposal);
  }
  requireProposal(id: string, session?: { roomId: string; memberId: string }) {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new AppError(404, "PROPOSAL_NOT_FOUND");
    const { room, member } = this.requireRoom(proposal.roomId, session);
    return { proposal, room, member };
  }
  publicProposal(proposal: Proposal): ProposalEnvelope {
    const room = this.rooms.get(proposal.roomId)!;
    const offer = proposal.snapshot.offer;
    const authorized = [...proposal.authorizations.values()].filter(value => value.status === "AUTHORIZED" && value.proposalHash === proposal.hash);
    const publicProposal: PublicProposalDTO = { proposalId: proposal.id, version: proposal.version, proposalHash: proposal.hash,
      state: proposal.state, offer: this.offerDTO(offer, room, proposal.state !== "STALE"),
      equalShareCents: Math.ceil(offer.totalCents / proposal.snapshot.memberIds.length),
      authorization: { authorizedCount: authorized.length, requiredCount: proposal.snapshot.memberIds.length,
        authorizedTotalCents: authorized.reduce((sum, value) => sum + value.amountCents, 0), requiredTotalCents: offer.totalCents },
      expiresAt: proposal.snapshot.expiresAt, solana: { status: "NOT_RECORDED" } };
    return { roomId: room.id, proposal: publicProposal,
      paymentModeLabel: "Simulated contribution authorization — no card charged",
      bookingModeLabel: "Controlled demo merchant booking — no real accommodation reserved", inventoryLabel,
      canExecute: proposal.state === "READY_TO_EXECUTE" };
  }
  async privateProposal(proposal: Proposal, member: Member): Promise<PrivateProposalEnvelope> {
    if (!proposal.snapshot.memberIds.includes(member.id) || !member.constraints) throw new AppError(403, "PROPOSAL_MEMBER_ACCESS_DENIED");
    const publicPart = this.publicProposal(proposal);
    const current = proposal.state === "STALE" ? await this.currentOffer(proposal.snapshot.offer.offerId) : undefined;
    const offer = current ?? proposal.snapshot.offer;
    const share = equalShares(offer.totalCents, proposal.snapshot.memberIds)[member.id]!;
    return { ...publicPart, myContributionCents: proposal.snapshot.contributionsCents[member.id]!,
      myApprovalStatus: proposal.approvals.get(member.id)?.status ?? "PENDING",
      myPaymentStatus: proposal.authorizations.get(member.id)?.status ?? "PENDING",
      myConstraintChecks: checkMember(offer, member.constraints!, share, proposal.snapshot.memberIds.length) };
  }
  consent(proposal: Proposal, room: Room, member: Member, input: { proposalHash: string; version: number; amountCents: number }) {
    if (room.activeProposalId !== proposal.id || proposal.state === "STALE" || proposal.state === "BOOKED") throw new AppError(409, "PROPOSAL_STALE");
    if (proposal.hash !== input.proposalHash || proposal.version !== input.version || proposal.snapshot.contributionsCents[member.id] !== input.amountCents) throw new AppError(409, "PROPOSAL_STALE");
    if (Date.parse(proposal.snapshot.expiresAt) <= Date.now() || member.capsuleVersion !== proposal.snapshot.privateCapsuleVersions[member.id]) throw new AppError(409, "PROPOSAL_STALE");
    if (!member.constraints) throw new AppError(409, "CONSTRAINTS_REQUIRED");
    if (checkMember(proposal.snapshot.offer, member.constraints, input.amountCents, room.memberIds.length).some(item => item.status !== "PASS")) throw new AppError(409, "OWN_CONSTRAINT_FAILED");
    const existing = proposal.authorizations.get(member.id);
    if (existing?.status === "AUTHORIZED" && existing.proposalHash === proposal.hash && existing.amountCents === input.amountCents) return { proposalId: proposal.id, version: proposal.version, proposalHash: proposal.hash, approvalStatus: "APPROVED" as const, paymentAuthorizationStatus: "AUTHORIZED" as const, amountCents: input.amountCents };
    proposal.approvals.set(member.id, { status: "APPROVED", proposalHash: proposal.hash, approvedAt: nowIso() });
    proposal.authorizations.set(member.id, { status: "AUTHORIZED", proposalHash: proposal.hash, amountCents: input.amountCents, providerRef: `sim_${randomUUID()}` });
    this.emit(room, "MEMBER_APPROVED", "A member approved the exact proposal.", proposal.id);
    this.emit(room, "PAYMENT_AUTHORIZED", `${proposal.authorizations.size}/${room.memberIds.length} simulated contributions authorized.`, proposal.id);
    if (proposal.snapshot.memberIds.every(id => proposal.authorizations.get(id)?.status === "AUTHORIZED" && proposal.approvals.get(id)?.status === "APPROVED")) proposal.state = "READY_TO_EXECUTE";
    return { proposalId: proposal.id, version: proposal.version, proposalHash: proposal.hash, approvalStatus: "APPROVED" as const, paymentAuthorizationStatus: "AUTHORIZED" as const, amountCents: input.amountCents };
  }
  async execute(proposal: Proposal, room: Room, member: Member, key: string) {
    if (member.id !== room.hostId) throw new AppError(403, "ADMIN_ACCESS_DENIED");
    if (room.booking && room.booking.proposalId === proposal.id) return this.receipt(room);
    if (proposal.state !== "READY_TO_EXECUTE" || room.activeProposalId !== proposal.id) throw new AppError(409, "NOT_READY_TO_BOOK");
    if (!key || key.length > 160) throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED");
    if (proposal.hash !== proposalHash(proposal.snapshot) || proposal.snapshot.memberIds.join() !== [...room.memberIds].sort().join()) throw new AppError(409, "PROPOSAL_STALE");
    if (Date.parse(proposal.snapshot.expiresAt) <= Date.now()) { this.stale(room, "The offer expired."); throw new AppError(409, "PROPOSAL_STALE"); }
    const sum = proposal.snapshot.memberIds.reduce((total, id) => total + proposal.snapshot.contributionsCents[id]!, 0);
    if (sum !== proposal.snapshot.offer.totalCents) throw new AppError(409, "CONTRIBUTIONS_MISMATCH");
    for (const id of proposal.snapshot.memberIds) {
      const member = this.members.get(id)!;
      if (!member.constraints || member.capsuleVersion !== proposal.snapshot.privateCapsuleVersions[id] ||
          proposal.approvals.get(id)?.status !== "APPROVED" || proposal.approvals.get(id)?.proposalHash !== proposal.hash ||
          proposal.authorizations.get(id)?.status !== "AUTHORIZED" || proposal.authorizations.get(id)?.proposalHash !== proposal.hash ||
          proposal.authorizations.get(id)?.amountCents !== proposal.snapshot.contributionsCents[id]) throw new AppError(409, "MISSING_EXACT_CONSENT");
    }
    const current = await this.currentOffer(proposal.snapshot.offer.offerId);
    if (!current || !materialOfferEquals(current, proposal.snapshot.offer) || !assessOffer(current, proposal.snapshot.memberIds.map(id => ({ id, constraints: this.members.get(id)!.constraints! }))).feasible) {
      this.stale(room, "Merchant offer changed before booking."); throw new AppError(409, "PROPOSAL_STALE");
    }
    let booking;
    try { booking = await this.merchant.execute({ offerId: current.offerId, expectedOfferVersion: current.offerVersion, idempotencyKey: key }); }
    catch { throw new AppError(409, "MERCHANT_BOOKING_FAILED"); }
    room.booking = { reference: booking.bookingReference, confirmedAt: booking.confirmedAt, proposalId: proposal.id };
    proposal.state = "BOOKED"; this.#dirtyRooms.add(room.id);
    try { await this.store.drain(async (_eventId, event) => { if (event.type === "BOOKING_CONFIRMED") this.emit(room, "BOOKING_CONFIRMED", "One controlled demo booking was confirmed.", proposal.id); }); }
    catch { /* Booking is confirmed. A failed optional event fanout cannot erase the receipt. */ }
    return this.receipt(room);
  }
  receipt(room: Room): ReceiptDTO {
    if (!room.booking) throw new AppError(404, "BOOKING_NOT_FOUND");
    const proposal = this.proposals.get(room.booking.proposalId)!;
    return { status: "CONFIRMED", bookingReference: room.booking.reference, bookedAt: room.booking.confirmedAt,
      providerModeLabel: "SIMULATED — no card charged", confirmationLabel: "Controlled demo merchant booking only; no real accommodation reserved.",
      guestCount: proposal.snapshot.memberIds.length, proposal: this.publicProposal(proposal).proposal };
  }
  stale(room: Room, detail: string) {
    const proposal = room.activeProposalId ? this.proposals.get(room.activeProposalId) : undefined;
    if (!proposal || proposal.state === "STALE" || proposal.state === "BOOKED") return;
    proposal.state = "STALE";
    for (const approval of proposal.approvals.values()) approval.status = "INVALIDATED";
    for (const authorization of proposal.authorizations.values()) authorization.status = "INVALIDATED";
    this.emit(room, "PROPOSAL_STALE", "The offer changed. Previous approval cannot be used.", proposal.id);
    for (const id of room.memberIds) this.streams.publishPrivate(room.id, id, randomUUID(), { roomId: room.id, type: "PROPOSAL_STALE", proposalId: proposal.id, at: nowIso() });
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
          this.emit(room, "MERCHANT_OFFER_MUTATED", "The demo merchant changed an offer.", room.activeProposalId);
          if (room.activeProposalId && this.proposals.get(room.activeProposalId)?.snapshot.offer.offerId === offerId) this.stale(room, "Merchant offer changed.");
        }
      });
      return after;
    } finally { release(); }
  }
  emit(room: Room, type: string, title: string, proposalId?: string) {
    const event: EventDTO = { id: randomUUID(), occurredAt: nowIso(), title };
    room.events.push(event); this.#dirtyRooms.add(room.id);
    this.streams.publishPublic(room.id, event.id, { roomId: room.id, type, proposalId, at: event.occurredAt });
  }
  #addSession(id: string, roomId: string, memberId: string) {
    this.sessions.set(id, { roomId, memberId, createdAt: nowIso() }); this.#dirtySessions.add(id);
  }
  #addInvitation(id: string, roomId: string) {
    this.invitations.set(id, roomId); this.#dirtyInvitations.add(id);
  }
  #aggregate(room: Room): RoomAggregate {
    const sealer = this.persistence!.sealer;
    const { id, events, ...rest } = room;
    return {
      room: { _id: id, ...structuredClone(rest), events: events.slice(-200) },
      members: room.memberIds.map(memberId => {
        const { id: _id, constraints, ...fields } = this.members.get(memberId)!;
        return { _id, ...fields, sealedConstraints: constraints ? sealer.seal(constraints) : null };
      }),
      proposals: [...this.proposals.values()].filter(proposal => proposal.roomId === room.id).map(proposal => ({
        _id: proposal.id, roomId: proposal.roomId, version: proposal.version, hash: proposal.hash, state: proposal.state,
        snapshot: structuredClone(proposal.snapshot),
        approvals: Object.fromEntries(proposal.approvals), authorizations: Object.fromEntries(proposal.authorizations),
      })),
    };
  }
  /** Persists everything changed since the last flush in one Mongo transaction. No-op in memory mode. */
  async flush() {
    const rooms = [...this.#dirtyRooms], sessions = [...this.#dirtySessions], invitations = [...this.#dirtyInvitations];
    this.#dirtyRooms.clear(); this.#dirtySessions.clear(); this.#dirtyInvitations.clear();
    if (!this.persistence || (!rooms.length && !sessions.length && !invitations.length)) return;
    try {
      await this.persistence.save(
        rooms.map(id => this.rooms.get(id)).filter((room): room is Room => Boolean(room)).map(room => this.#aggregate(room)),
        sessions.flatMap(id => { const value = this.sessions.get(id); return value ? [{ id, value }] : []; }),
        invitations.flatMap(id => { const roomId = this.invitations.get(id); return roomId ? [{ id, roomId }] : []; }));
    } catch {
      // Keep them dirty so the next flush retries; the caller reports the failure.
      rooms.forEach(id => this.#dirtyRooms.add(id)); sessions.forEach(id => this.#dirtySessions.add(id)); invitations.forEach(id => this.#dirtyInvitations.add(id));
      throw new AppError(503, "PERSISTENCE_UNAVAILABLE");
    }
  }
  async #hydrate() {
    const sealer = this.persistence!.sealer;
    const data = await this.persistence!.load();
    for (const doc of data.rooms) {
      const { _id, ...rest } = doc;
      this.rooms.set(String(_id), { ...(rest as Omit<Room, "id">), id: String(_id) });
    }
    for (const doc of data.members) {
      const { _id, sealedConstraints, ...rest } = doc;
      this.members.set(String(_id), { ...(rest as Omit<Member, "id" | "constraints">), id: String(_id),
        constraints: sealedConstraints ? sealer.open<Constraints>(sealedConstraints as SealedValue) : null });
    }
    for (const doc of data.proposals) {
      this.proposals.set(String(doc._id), { id: String(doc._id), roomId: doc.roomId, version: doc.version, hash: doc.hash, state: doc.state,
        snapshot: doc.snapshot, approvals: new Map(Object.entries(doc.approvals ?? {})), authorizations: new Map(Object.entries(doc.authorizations ?? {})) });
    }
    for (const doc of data.sessions) this.sessions.set(String(doc._id), { roomId: doc.roomId, memberId: doc.memberId, createdAt: new Date(doc.createdAt).toISOString() });
    for (const doc of data.invitations) this.invitations.set(String(doc._id), doc.roomId);
  }
}
