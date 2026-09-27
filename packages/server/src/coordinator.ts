import {
  assessOffer, checkMember, ConstraintsSchema, equalShares, localDay, nearMisses,
  type AutopilotDTO, type Constraints, type NearMiss, type Offer,
} from "@accord/domain";
import { AppError } from "./errors.js";
import { Planner } from "./planner.js";
import { dayRange, isLive, type AccordState, type InboxEntry, type Proposal, type Room } from "./state.js";

export type AutopilotOptions = {
  enabled?: boolean;
  /** Pause after the last member confirms, so the group sees "everyone is ready" before results arrive. */
  readyDelayMs?: number;
  /** Pause after consent goes stale, so the group sees the stale moment before Accord replans. */
  replanDelayMs?: number;
  watchIntervalMs?: number;
  recheckEveryMs?: number;
  remindAfterMs?: number;
  expiryWarningMs?: number;
  maxNudgesPerMember?: number;
  /** How long a trip vote stays open before Accord closes it with the votes cast. */
  voteWindowMs?: number;
};
export type AlternativesInput = {
  destination: string; countryCode: string; checkIn: string; checkOut: string; guests: number;
  staysChecked: number; staysAvailable: number;
  /** Number of stays that failed each kind of check for at least one member. No member identities or limits. */
  staysFailing: Record<string, number>;
};
type Trigger = "READY" | "REPLAN";
type Transient = { status: "SEARCHING" | "REPLANNING" | "WIDENING" | "PLANNING"; message: string };

const ACCORD = { actor: "ACCORD" as const };
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const wallTime = (instant: string, timeZone: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }).format(new Date(instant));
const isActive = (proposal?: Proposal) => proposal?.state === "OPEN" || proposal?.state === "READY_TO_EXECUTE";

/**
 * Accord's autonomous coordinator. It decides when to search, replan, widen, nudge and re-check,
 * but acts only through the same backend methods members use. It never approves, authorizes,
 * books, or changes a member's requirements without that member's explicit action.
 */
export class Coordinator {
  readonly options: Required<AutopilotOptions>;
  readonly planner: Planner;
  #timers = new Map<string, NodeJS.Timeout>();
  #locks = new Map<string, Promise<unknown>>();
  #transient = new Map<string, Transient>();
  #watch?: NodeJS.Timeout;
  #ticking = false;
  #disposed = false;

  constructor(private readonly state: AccordState, options: AutopilotOptions = {}) {
    this.options = { enabled: true, readyDelayMs: 1200, replanDelayMs: 2500, watchIntervalMs: 20_000, recheckEveryMs: 120_000,
      remindAfterMs: 180_000, expiryWarningMs: 24 * 60 * 60 * 1000, maxNudgesPerMember: 3, voteWindowMs: 24 * 60 * 60 * 1000, ...options };
    this.planner = new Planner(state, { voteWindowMs: this.options.voteWindowMs, maxNudgesPerMember: this.options.maxNudgesPerMember,
      nudge: room => this.#nudge(room), propose: room => this.#propose(room) });
    if (this.options.enabled && this.options.watchIntervalMs > 0) {
      this.#watch = setInterval(() => void this.tick(), this.options.watchIntervalMs);
      this.#watch.unref();
    }
  }

  dispose() {
    this.#disposed = true;
    clearInterval(this.#watch);
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear(); this.#transient.clear();
  }

  /** Serializes every search/proposal decision for one room, whether a member or Accord started it. */
  #lock<T>(roomId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.#locks.get(roomId) ?? Promise.resolve()).then(run, run);
    const tail = next.catch(() => undefined);
    this.#locks.set(roomId, tail);
    void tail.then(() => { if (this.#locks.get(roomId) === tail) this.#locks.delete(roomId); });
    return next;
  }

  #wantsProposal(room: Room) {
    if (room.booking || room.memberIds.length < 2) return false;
    if (isActive(room.activeProposalId ? this.state.proposals.get(room.activeProposalId) : undefined)) return false;
    return !!this.state.readyMembers(room);
  }

  async #fingerprint(room: Room) {
    const offers = await this.state.allOffers(this.state.offerIdsFor(room));
    return JSON.stringify([
      [...room.memberIds].sort().map(id => [id, this.state.members.get(id)?.capsuleVersion ?? 0]),
      offers.map(offer => [offer.offerId, offer.offerVersion]),
    ]);
  }

  /** Called whenever readiness, membership or consent changes. Schedules a search if the group needs one. */
  kick(room: Room, trigger: Trigger) {
    if (!this.options.enabled || this.#disposed || !this.#wantsProposal(room)) {
      if (trigger === "REPLAN") this.#transient.delete(room.id);
      return;
    }
    if (trigger === "READY" && this.#timers.has(room.id)) return;
    const planning = this.planner.needsPlanning(room);
    if (planning && this.planner.current(room)) return;
    this.#transient.set(room.id, planning ? { status: "PLANNING", message: "Everyone has answered. Accord is working out where and when." }
      : trigger === "REPLAN"
      ? { status: "REPLANNING", message: "The offer changed, so Accord is looking for another option that works for everyone." }
      : { status: "SEARCHING", message: "Everyone is ready. Accord is starting the search." });
    if (planning) this.state.emit(room, "AUTOPILOT_READY", "Everyone has answered. Accord is working out where and when on its own.", undefined, ACCORD);
    else if (trigger === "READY") this.state.emit(room, "AUTOPILOT_READY", "Everyone has confirmed. Accord is starting the search on its own.", undefined, ACCORD);
    clearTimeout(this.#timers.get(room.id));
    const timer = setTimeout(() => void this.#advance(room.id, trigger), trigger === "REPLAN" ? this.options.replanDelayMs : this.options.readyDelayMs);
    timer.unref();
    this.#timers.set(room.id, timer);
  }

  async #advance(roomId: string, trigger: Trigger) {
    this.#timers.delete(roomId);
    if (this.#disposed) return;
    const room = this.state.rooms.get(roomId);
    if (!room) return;
    try {
      await this.#lock(roomId, async () => {
        if (this.#disposed || !this.#wantsProposal(room)) return;
        if (this.planner.needsPlanning(room)) { await this.planner.plan(room); return; }
        const fingerprint = await this.#fingerprint(room);
        if (room.noOption?.fingerprint === fingerprint) return;
        const result = await this.state.solve(room, trigger);
        if ("noSolution" in result) await this.#noSolution(room, fingerprint);
        else delete room.noOption;
      });
    } catch (error) {
      if (!this.#disposed) this.state.emit(room, "AUTOPILOT_FAILED", "Accord couldn’t finish its search. Anyone in the group can try again.",
        undefined, { ...ACCORD, detail: error instanceof AppError ? error.code : "UNEXPECTED" });
    } finally {
      this.#transient.delete(roomId);
      await this.state.flush().catch(() => undefined);
    }
  }

  /** A member asked Accord to plan now (autopilot off, or retrying after a failure). */
  async planNow(room: Room) {
    clearTimeout(this.#timers.get(room.id)); this.#timers.delete(room.id);
    if (!this.state.readyMembers(room)) throw new AppError(409, "MEMBERS_NOT_READY");
    if (room.memberIds.length < 2) throw new AppError(409, "MEMBERS_NOT_READY");
    try { await this.#lock(room.id, () => this.planner.plan(room)); }
    finally { this.#transient.delete(room.id); }
  }

  async vote(room: Room, memberId: string, optionId: string) {
    await this.#lock(room.id, async () => {
      if (this.planner.vote(room, memberId, optionId)) await this.planner.closeVote(room, "VOTE");
    });
  }

  /** The decided trip's first proposal, chosen from the stays already found for it. */
  async #propose(room: Room) {
    const fingerprint = await this.#fingerprint(room);
    const result = await this.state.solve(room, "READY", { search: false });
    if ("noSolution" in result) await this.#noSolution(room, fingerprint);
    else delete room.noOption;
  }

  /** A member asked Accord to search now. Shares the room lock so it never races an autonomous search. */
  async solveNow(room: Room) {
    clearTimeout(this.#timers.get(room.id)); this.#timers.delete(room.id);
    const result = await this.#lock(room.id, async () => {
      const outcome = await this.state.solve(room, "MANUAL");
      if (!("noSolution" in outcome)) { delete room.noOption; this.#transient.delete(room.id); }
      return outcome;
    });
    if ("noSolution" in result && this.options.enabled) {
      void this.#lock(room.id, async () => this.#noSolution(room, await this.#fingerprint(room)))
        .catch(() => undefined).finally(() => { this.#transient.delete(room.id); void this.state.flush().catch(() => undefined); });
    }
    return result;
  }

  /** Nothing fits: first look further afield, then privately ask only members who alone block an option. */
  async #noSolution(room: Room, fingerprint: string) {
    if (room.trip && isLive(room) && this.state.providers.suggestAlternatives && room.widenedFor !== fingerprint) {
      room.widenedFor = fingerprint;
      const destination = room.trip.destination;
      this.#transient.set(room.id, { status: "WIDENING", message: `Nothing in ${destination} works for everyone yet, so Accord is checking nearby areas.` });
      this.state.emit(room, "AUTOPILOT_WIDENING", `No stay in ${destination} works for everyone yet. Accord is checking nearby areas.`, undefined, ACCORD);
      const alternatives = await this.#alternatives(room);
      for (const alternative of alternatives) {
        this.state.emit(room, "AUTOPILOT_WIDENING", `Accord is also searching ${alternative}.`, undefined,
          { ...ACCORD, detail: "Suggested by Gemini from the trip details and anonymous search totals. Accord’s own checks still decide what fits." });
        await this.state.searchLive(room, { destination: alternative }).catch(() => undefined);
      }
      if (alternatives.length) {
        const retry = await this.state.solve(room, "WIDEN", { search: false });
        if (!("noSolution" in retry)) { delete room.noOption; return; }
      }
    }
    const nudged = await this.#nudge(room);
    const message = nudged
      ? "No stay works for everyone yet. Accord has privately checked in with some members and will keep looking."
      : "No current stay works for everyone’s confirmed requirements. Members can review their own requirements privately, or the host can change the trip.";
    room.noOption = { fingerprint: await this.#fingerprint(room), message };
    this.state.emit(room, "AUTOPILOT_NO_OPTION", message, undefined, ACCORD);
  }

  async #alternatives(room: Room) {
    const trip = room.trip!, members = this.state.readyMembers(room);
    const suggest = this.state.providers.suggestAlternatives;
    if (!members || !suggest) return [];
    const offers = await this.state.allOffers(this.state.offerIdsFor(room));
    const staysFailing: Record<string, number> = {};
    for (const offer of offers) {
      const { checks } = assessOffer(offer, members);
      const kinds = new Set(Object.values(checks).flat().filter(check => check.status !== "PASS").map(check => check.kind));
      for (const kind of kinds) staysFailing[kind] = (staysFailing[kind] ?? 0) + 1;
    }
    const input: AlternativesInput = { destination: trip.destination, countryCode: trip.countryCode, checkIn: trip.checkIn, checkOut: trip.checkOut,
      guests: trip.guests, staysChecked: offers.length, staysAvailable: offers.filter(offer => offer.available).length, staysFailing };
    const suggestions = await suggest(input).catch(() => undefined) ?? [];
    const seen = new Set([trip.destination.trim().toLowerCase(), ...(room.search?.destinations ?? []).map(value => value.toLowerCase())]);
    return suggestions.map(value => value.trim()).filter(value => {
      const key = value.toLowerCase();
      if (value.length < 2 || value.length > 120 || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 2);
  }

  async #nudge(room: Room) {
    const members = this.state.readyMembers(room);
    if (!members) return false;
    const offers = await this.state.allOffers(this.state.offerIdsFor(room));
    const timeZone = room.trip?.timeZone ?? "America/New_York";
    let waiting = false;
    for (const miss of nearMisses(offers, members)) {
      const member = this.state.members.get(miss.memberId)!;
      const inbox = member.inbox ?? [];
      if (inbox.some(entry => entry.nudge?.status === "OPEN")) { waiting = true; continue; }
      if (inbox.filter(entry => entry.kind === "NUDGE").length >= this.options.maxNudgesPerMember) continue;
      if (inbox.some(entry => entry.nudge?.status === "KEPT" && entry.nudge.offerId === miss.offerId && entry.nudge.check === miss.check)) continue;
      const offer = offers.find(item => item.offerId === miss.offerId)!;
      this.state.notify(room, member.id, nudgeEntry(offer, miss, member.constraints!, timeZone));
      waiting = true;
    }
    return waiting;
  }

  /** A member answers a private nudge. Accepting is an explicit, member-confirmed change to their own requirements. */
  respond(room: Room, memberId: string, messageId: string, action: "ACCEPT" | "KEEP") {
    const member = this.state.members.get(memberId)!;
    const entry = member.inbox?.find(item => item.id === messageId);
    if (!entry?.nudge) throw new AppError(404, "NUDGE_NOT_FOUND");
    if (entry.nudge.status !== "OPEN") throw new AppError(409, "NUDGE_CLOSED");
    if (!member.constraints) throw new AppError(409, "CONSTRAINTS_REQUIRED");
    if (action === "KEEP") {
      entry.nudge.status = "KEPT";
      this.state.touch(room);
      return;
    }
    const current = member.constraints, nudge = entry.nudge;
    const next: Constraints = nudge.check === "BUDGET" ? { ...current, maxContributionCents: Math.max(current.maxContributionCents, nudge.shareCents) }
      : nudge.check === "REFUND" ? { ...current, requiresFullCashRefund: false }
      : nudge.check === "DATES" ? { ...current, availability: [...(current.availability ?? []), { from: nudge.window!.checkIn, to: nudge.window!.checkOut }].slice(-6) }
      : { ...current, latestCheckOutAt: nudge.checkOutAt! };
    nudge.status = "ACCEPTED";
    this.state.confirmConstraints(room, member, ConstraintsSchema.parse(next));
  }

  /** Consent went stale: tell each member privately what it means for them, then replan. */
  onStale(room: Room, proposal: Proposal) {
    void this.#explainStale(room, proposal);
    this.kick(room, "REPLAN");
  }

  async #explainStale(room: Room, proposal: Proposal) {
    try {
      const current = await this.state.currentOffer(proposal.snapshot.offer.offerId) ?? proposal.snapshot.offer;
      const group = room.memberIds.filter(id => proposal.snapshot.memberIds.includes(id) && this.state.members.get(id)?.constraints);
      if (!group.length) return;
      const shares = equalShares(current.totalCents, room.memberIds);
      for (const id of group) {
        const constraints = this.state.members.get(id)!.constraints!;
        const personal = checkMember(current, constraints, shares[id]!, room.memberIds.length)
          .filter(check => check.status !== "PASS" && ["BUDGET", "REFUND", "CHECKOUT", "STEP_FREE", "DATES"].includes(check.kind));
        this.state.notify(room, id, personal.length
          ? { kind: "STALE_REASON", proposalId: proposal.id, title: `${current.propertyName} no longer works for you`,
              body: `${personal.map(check => check.privateExplanation).join(" ")} Your earlier approval won’t be used, and Accord won’t ask the group to change anything for you. It is already looking for another option.` }
          : { kind: "STALE_REASON", proposalId: proposal.id, title: `Your approval for Proposal v${proposal.version} was cancelled`,
              body: "Something about the offer or the group changed, so Accord cancelled every approval. Nothing was booked and no share was used. Accord is looking for a new option." });
      }
      await this.state.flush();
    } catch { /* The public stale state is already committed; private context is best-effort. */ }
  }

  onAllAuthorized(room: Room, proposal: Proposal) {
    this.state.emit(room, "AUTOPILOT_READY_TO_BOOK", `Everyone approved Proposal v${proposal.version}. Accord is verifying payment and booking automatically.`, proposal.id, ACCORD);
    this.state.notify(room, room.hostId, { kind: "READY_TO_BOOK", proposalId: proposal.id, title: "Everyone approved. Accord is checking out.",
      body: `All ${proposal.snapshot.memberIds.length} members approved their exact share of Proposal v${proposal.version}. Accord now re-checks the merchant’s current terms, authorizes the shared payment, and books only if nothing changed.` });
  }

  /** A merchant change can make a previously impossible trip possible again. */
  onOfferChanged(room: Room) {
    if (this.planner.needsPlanning(room) && room.planning?.stage === "NO_OPTION") { delete room.planning; this.kick(room, "READY"); }
    else if (room.noOption) this.kick(room, "REPLAN");
  }

  describe(room: Room): AutopilotDTO {
    if (!this.options.enabled) return { status: "IDLE", message: "" };
    if (room.booking) return { status: "IDLE", message: "Booked. Accord’s work for this trip is done." };
    const transient = this.#transient.get(room.id);
    if (transient) return transient;
    if (room.searching) return { status: "SEARCHING", message: "Accord is checking current stays against everyone’s confirmed requirements." };
    const proposal = room.activeProposalId ? this.state.proposals.get(room.activeProposalId) : undefined;
    if (isActive(proposal)) return { status: "WATCHING", message: "Accord is watching this offer while everyone decides. If anything changes, it cancels old approvals and looks again." };
    const ready = room.memberIds.filter(id => this.state.members.get(id)?.constraints).length;
    if (this.planner.needsPlanning(room)) {
      if (room.memberIds.length < 2) return { status: "WAITING_FOR_MEMBERS", message: "Accord starts planning once your friends join and answer a few private questions." };
      if (ready < room.memberIds.length) return { status: "WAITING_FOR_MEMBERS", message: `Accord plans on its own once everyone has answered (${ready} of ${room.memberIds.length} done).` };
      const planning = this.planner.current(room);
      if (planning?.stage === "VOTING") return { status: "VOTING", message: `${Object.keys(planning.votes).length} of ${room.memberIds.length} have voted. Accord picks the trip once everyone has, or when voting closes ${wallTime(planning.voteClosesAt!, "America/New_York")}.` };
      if (planning?.stage === "NO_OPTION") return { status: "NO_OPTION", message: planning.message };
      if (planning?.stage === "PLANNING") return { status: "PLANNING", message: planning.message };
      return { status: "IDLE", message: "Accord is ready to plan." };
    }
    if (room.memberIds.length < 2) return { status: "WAITING_FOR_MEMBERS", message: "Accord starts searching once your friends join and confirm their requirements." };
    if (ready < room.memberIds.length) return { status: "WAITING_FOR_MEMBERS", message: `Accord searches on its own once everyone has confirmed (${ready} of ${room.memberIds.length} ready).` };
    if (room.noOption) return { status: "NO_OPTION", message: room.noOption.message };
    return { status: "IDLE", message: "Accord is ready to search." };
  }

  /** Periodic watch: re-check the offer, remind undecided members once, warn before expiry, replan on lapse. */
  async tick(now = Date.now()) {
    if (this.#ticking || this.#disposed) return;
    this.#ticking = true;
    try {
      await this.state.ready;
      for (const room of this.state.rooms.values()) {
        const planning = room.planning;
        if (planning?.stage === "VOTING" && Date.parse(planning.voteClosesAt!) <= now) {
          await this.#lock(room.id, () => this.planner.closeVote(room, "DEADLINE")).catch(() => undefined);
          continue;
        }
        const proposal = room.activeProposalId ? this.state.proposals.get(room.activeProposalId) : undefined;
        if (!proposal || room.booking || !isActive(proposal)) continue;
        await this.#lock(room.id, () => this.#watchProposal(room, proposal, now)).catch(() => undefined);
      }
      await this.state.flush().catch(() => undefined);
    } finally { this.#ticking = false; }
  }

  async #watchProposal(room: Room, proposal: Proposal, now: number) {
    if (room.activeProposalId !== proposal.id || !isActive(proposal)) return;
    const expiresAt = Date.parse(proposal.snapshot.expiresAt);
    if (expiresAt <= now) { this.state.stale(room, "The offer expired."); return; }
    const lastChecked = Date.parse(proposal.watch?.lastCheckedAt ?? proposal.snapshot.createdAt);
    if (now - lastChecked >= this.options.recheckEveryMs) {
      await this.state.recheck(proposal);
      if (!isActive(proposal)) return;
    }
    const pending = proposal.snapshot.memberIds.filter(id => proposal.approvals.get(id)?.status !== "APPROVED");
    const timeZone = room.trip?.timeZone ?? "America/New_York";
    if (!proposal.watch?.expiryWarnedAt && expiresAt - now <= this.options.expiryWarningMs) {
      proposal.watch = { ...proposal.watch, expiryWarnedAt: new Date(now).toISOString() };
      this.state.emit(room, "AUTOPILOT_EXPIRING", `Proposal v${proposal.version} expires ${wallTime(proposal.snapshot.expiresAt, timeZone)}. If it lapses, Accord will look again.`, proposal.id, ACCORD);
      for (const id of pending) this.state.notify(room, id, { kind: "EXPIRING", proposalId: proposal.id, title: `Proposal v${proposal.version} expires soon`,
        body: `This offer expires ${wallTime(proposal.snapshot.expiresAt, timeZone)}. You don’t have to decide in a hurry: if it lapses, Accord cancels it and looks for another option.` });
    }
    if (proposal.state === "OPEN" && !proposal.watch?.remindedAt && now - Date.parse(proposal.snapshot.createdAt) >= this.options.remindAfterMs && pending.length) {
      proposal.watch = { ...proposal.watch, remindedAt: new Date(now).toISOString() };
      const approved = proposal.snapshot.memberIds.length - pending.length;
      for (const id of pending) this.state.notify(room, id, { kind: "REMINDER", proposalId: proposal.id, title: "Your group is waiting on a decision",
        body: `${approved} of ${proposal.snapshot.memberIds.length} members have approved Proposal v${proposal.version}. Take your time. Nothing is booked until everyone approves, and not approving is always an option.` });
    }
    this.state.touch(room);
  }
}

function nudgeEntry(offer: Offer, miss: NearMiss, constraints: Constraints, timeZone: string): Omit<InboxEntry, "id" | "at"> {
  const window = { checkIn: localDay(offer.checkInAt, timeZone), checkOut: localDay(offer.checkOutAt, timeZone) };
  const nudge = { status: "OPEN" as const, check: miss.check, offerId: offer.offerId, offerVersion: offer.offerVersion, shareCents: miss.shareCents,
    ...(miss.check === "CHECKOUT" ? { checkOutAt: offer.checkOutAt } : {}), ...(miss.check === "DATES" ? { window } : {}) };
  const closing = "No one else will see what you choose, and Accord will keep looking either way.";
  if (miss.check === "DATES") return { kind: "NUDGE", nudge, title: "One stay works for everyone but falls outside your dates",
    body: `${offer.propertyName} in ${offer.city} works for everyone else for ${dayRange(window)}. You can add those dates for this trip, or keep your dates. ${closing}` };
  if (miss.check === "BUDGET") return { kind: "NUDGE", nudge, title: "One stay is just above your limit",
    body: `${offer.propertyName} in ${offer.city} works for everyone else. Your share would be ${money(miss.shareCents)}, which is ${money(miss.gapCents!)} over your ${money(constraints.maxContributionCents)} limit. You can raise your limit to ${money(miss.shareCents)} for this trip, or keep it. ${closing}` };
  if (miss.check === "REFUND") return { kind: "NUDGE", nudge, title: "One stay has a different refund policy",
    body: `${offer.propertyName} in ${offer.city} works for everyone else, but it offers ${offer.cancellationPolicyCode === "TRAVEL_CREDIT" ? "travel credit" : "no refund"} instead of a full cash refund. You can keep requiring a full cash refund, or drop that requirement for this trip. ${closing}` };
  return { kind: "NUDGE", nudge, title: "One stay checks out later than your time",
    body: `${offer.propertyName} in ${offer.city} works for everyone else, but checkout is ${wallTime(offer.checkOutAt, timeZone)}, later than your ${wallTime(constraints.latestCheckOutAt!, timeZone)}. You can keep your checkout time, or accept this one for this trip. ${closing}` };
}
