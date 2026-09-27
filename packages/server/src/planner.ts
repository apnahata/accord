import {
  addDays, dateWindows, daysBetween, isHome, localDay, mentions, PLANNING_HORIZON_DAYS, planningSpan, preferredNights, rankDestinations, regionFor, TripSchema,
  type DateWindow, type PlanningDTO, type TripStyle,
} from "@accord/domain";
import { AppError } from "./errors.js";
import { dayRange, type AccordState, type Member, type Room } from "./state.js";
import type { Constraints } from "@accord/domain";

export type PlanOption = {
  id: string; destination: string; timeZone: string; checkIn: string; checkOut: string;
  /** Every stay found for this destination and these dates; the proposal is chosen from these. */
  offerIds: string[]; offerId: string; propertyName: string; totalCents: number; imageUrl?: string;
  why: string[]; fit: number;
};
export type Planning = {
  /** Member set and requirement versions this plan was made for; any change means planning again. */
  key: string;
  stage: "PLANNING" | "VOTING" | "DECIDED" | "NO_OPTION";
  message: string;
  windows: DateWindow[];
  destinations: DestinationIdea[];
  options: PlanOption[];
  /** Offer id → IANA zone of the destination it was searched for. Providers name cities inconsistently. */
  offerZones?: Record<string, string>;
  /** Member id → option id. Never exposed; the group only sees totals once voting closes. */
  votes: Record<string, string>;
  voteClosesAt?: string;
  decidedOptionId?: string; decidedBy?: "VOTE" | "ONLY_OPTION" | "DEADLINE";
};
export type DestinationIdea = { name: string; timeZone: string; why: string; styles: TripStyle[] };
/** Anonymous planning facts only: no names, no budgets, no one's individual answers. */
export type DestinationsInput = {
  /** Where members are leaving from, sorted so the order can't hint at who wrote what. */
  from: string[]; countryCode: string; nights: number; guests: number;
  windows: DateWindow[]; styleCounts: Partial<Record<TripStyle, number>>; ideas: string[]; avoid: string[];
};
type Ready = Array<Member & { constraints: Constraints }>;
export type PlannerHooks = {
  voteWindowMs: number; maxNudgesPerMember: number;
  /** Privately asks members who alone block a stay; true when anyone was asked or is still deciding. */
  nudge(room: Room): Promise<boolean>;
  /** Turns the decided trip into Proposal v1 through the normal proposal path. */
  propose(room: Room): Promise<void>;
};

const ACCORD = { actor: "ACCORD" as const };
const MAX_DESTINATIONS = 3, MAX_SEARCHES = 6;
const styleLabel: Record<TripStyle, string> = { BEACH: "beach", MOUNTAINS: "mountains", SKI: "ski", CITY: "city", NATURE: "nature", THEME_PARKS: "theme parks", LAKE: "lake" };
const list = (items: string[]) => items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const validZone = (zone: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; } };
// A specific place ("Reno, NV", "Ohio") is worth forcing back onto the shortlist if the model drops it;
// a vague wish ("somewhere warm") is not a searchable destination and would just fail every search.
const looksLikeAPlace = (text: string) => /^[A-Z]/.test(text) && !/\b(somewhere|anywhere|someplace|any\s?place)\b/i.test(text);
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};
// A suggested "City, ST" already covers an idea like "LA" (city initials) or "Ohio" (the state it's in),
// even though `mentions` alone won't see it: neither is in the internal catalog `mentions` knows about.
function alreadyCovers(idea: string, suggestionName: string): boolean {
  if (mentions(idea, suggestionName)) return true;
  const [city = "", abbreviation = ""] = suggestionName.split(",").map(part => part.trim());
  const initials = city.split(/\s+/).map(word => word[0] ?? "").join("").toUpperCase();
  const stateName = US_STATES[abbreviation.toUpperCase()];
  return initials === idea.trim().toUpperCase() || (!!stateName && idea.trim().toLowerCase() === stateName.toLowerCase());
}

/**
 * Decides where and when for a group that hasn't. Dates come from a deterministic overlap of everyone's
 * private availability; destinations are advisory (Gemini or Accord's own catalog); feasibility is always
 * Accord's own checks. The group votes on the shortlist, and the winner becomes an ordinary trip.
 */
export class Planner {
  constructor(private readonly state: AccordState, private readonly hooks: PlannerHooks) {}

  needsPlanning(room: Room) { return !!room.plan && !room.trip; }

  key(room: Room) {
    return JSON.stringify([...room.memberIds].sort().map(id => [id, this.state.members.get(id)?.capsuleVersion ?? 0]));
  }

  /** The plan for the current group, if Accord has made one. A decided plan stands until the host reopens it. */
  current(room: Room) {
    const planning = room.planning;
    return planning && (planning.stage === "DECIDED" || planning.key === this.key(room)) ? planning : undefined;
  }

  async plan(room: Room) {
    const members = this.state.readyMembers(room);
    if (!members || !room.plan || room.trip) return;
    const key = this.key(room);
    if (room.planning?.key === key && room.planning.stage !== "PLANNING") return;
    const planning: Planning = { key, stage: "PLANNING", message: "Accord is working out where and when.", windows: [], destinations: [], options: [], votes: {} };
    room.planning = planning; this.state.touch(room);

    const span = planningSpan(members, localDay(new Date().toISOString()));
    if (!span) { this.#settle(room, planning, "NO_OPTION", "Everyone’s dates have passed or are too far away. Members can update when they’re free."); return; }
    const wanted = preferredNights(members);
    let nights = wanted, dates = dateWindows({ ...span, nights }, members);
    // A shorter trip everyone can make beats asking someone to move their dates.
    for (let shorter = wanted - 1; !dates.windows.length && shorter >= 2; shorter--) {
      const tried = dateWindows({ ...span, nights: shorter }, members);
      if (tried.windows.length) { dates = tried; nights = shorter; }
    }
    const { windows, near, sharedCount } = dates;
    if (!windows.length) { await this.#noDates(room, planning, near, wanted); return; }
    planning.windows = windows;
    for (const member of members) for (const entry of member.inbox ?? []) if (entry.nudge?.check === "DATES" && entry.nudge.status === "OPEN") entry.nudge.status = "EXPIRED";
    this.state.emit(room, "PLAN_DATES", `${sharedCount === 1
      ? `Only one ${nights}-night stretch works for everyone: ${dayRange(windows[0]!)}.`
      : `${sharedCount} possible ${nights}-night stretches work for everyone. Accord will price ${list(windows.map(dayRange))}.`}${nights < wanted ? ` Most people wanted ${wanted} nights, but no ${wanted}-night stretch fits everyone’s dates.` : ""}`, undefined,
      { ...ACCORD, detail: "Worked out from everyone’s private availability and the trip length most people asked for. No one’s answers are shown to the group." });

    const { ideas, source } = await this.#destinations(room, members, windows);
    planning.destinations = ideas;
    if (!ideas.length) { await this.#noDestinations(room, planning, members, windows); return; }
    this.state.emit(room, "PLAN_DESTINATIONS", `Accord is considering ${list(ideas.map(idea => idea.name))}.`, undefined,
      { ...ACCORD, detail: source === "AI"
        ? "Suggested by Gemini from anonymous totals of the trip styles people picked. Budgets and names were not shared."
        : "Picked from Accord’s destination list by the trip styles people chose, skipping anywhere someone ruled out." });

    const candidates = ideas.flatMap(idea => windows.map(window => ({ idea, window }))).slice(0, MAX_SEARCHES);
    const trips = candidates.map(({ idea, window }) => TripSchema.parse({ destination: idea.name, countryCode: room.plan!.countryCode,
      checkIn: window.checkIn, checkOut: window.checkOut, guests: members.length, timeZone: idea.timeZone }));
    const found = await this.state.searchCandidates(room, trips);
    if (room.planning !== planning) return;
    planning.offerZones = Object.fromEntries(candidates.flatMap(({ idea }, index) => found[index]!.map(id => [id, idea.timeZone])));

    const options: PlanOption[] = [];
    for (const idea of ideas) {
      const indexes = candidates.flatMap((candidate, index) => candidate.idea === idea ? [index] : []);
      const offers = await this.state.allOffers(indexes.flatMap(index => found[index]!));
      const best = (await this.state.rankFeasible(offers, members))[0];
      if (!best) continue;
      const index = indexes.find(i => found[i]!.includes(best.offerId))!;
      const window = candidates[index]!.window;
      options.push({ id: `${idea.name}|${window.checkIn}`, destination: idea.name, timeZone: idea.timeZone, checkIn: window.checkIn, checkOut: window.checkOut,
        offerIds: found[index]!, offerId: best.offerId, propertyName: best.propertyName, totalCents: best.totalCents,
        ...(best.imageUrl ? { imageUrl: best.imageUrl } : {}), ...this.#why(idea, window, members, best.cancellationPolicyCode) });
    }
    options.sort((a, b) => b.fit - a.fit || a.totalCents - b.totalCents);
    planning.options = options;
    const checked = new Set(found.flat()).size;
    this.state.emit(room, "PLAN_SEARCHED", options.length
      ? `Checked ${checked} stays across ${trips.length} trips. ${options.length === 1 ? "One destination has" : `${options.length} destinations have`} a stay that works for everyone.`
      : `Checked ${checked} stays across ${trips.length} trips. None works for everyone yet.`, undefined, ACCORD);

    if (!options.length) {
      const nudged = await this.hooks.nudge(room);
      this.#settle(room, planning, "NO_OPTION", nudged
        ? "No trip works for everyone yet. Accord has privately checked in with some members and will keep planning."
        : "No trip works for everyone’s confirmed requirements yet. Members can review their own answers privately.");
      return;
    }
    if (options.length === 1) { await this.#decide(room, planning, options[0]!, "ONLY_OPTION"); return; }
    planning.stage = "VOTING";
    planning.voteClosesAt = new Date(Date.now() + this.hooks.voteWindowMs).toISOString();
    planning.message = `Vote privately for your favorite of ${options.length} trips. Accord picks the winner once everyone has voted.`;
    this.state.emit(room, "PLAN_VOTING", `Accord shortlisted ${list(options.map(option => option.destination))}. Everyone votes privately.`, undefined,
      { ...ACCORD, detail: "Each works for every confirmed requirement. Totals are shown when voting closes; a tie goes to the trip that fits the group best." });
    for (const member of members) this.state.notify(room, member.id, { kind: "VOTE", title: "Vote on where you’re going",
      body: `Accord found ${options.length} trips that work for everyone: ${list(options.map(option => `${option.destination} (${dayRange(option)})`))}. Your vote is private.` });
    this.state.touch(room);
  }

  vote(room: Room, memberId: string, optionId: string) {
    const planning = room.planning;
    if (!planning || planning.stage !== "VOTING" || planning.key !== this.key(room)) throw new AppError(409, "VOTING_CLOSED");
    if (!planning.options.some(option => option.id === optionId)) throw new AppError(404, "OPTION_NOT_FOUND");
    const first = !(memberId in planning.votes);
    planning.votes[memberId] = optionId; this.state.touch(room);
    const cast = Object.keys(planning.votes).length;
    if (first) this.state.emit(room, "PLAN_VOTE", `${cast} of ${room.memberIds.length} people have voted.`, undefined, { actor: "GROUP" });
    return cast === room.memberIds.length;
  }

  /**
   * A stay on the ballot changed while the group is voting. Re-check that destination against everyone's
   * requirements right away: update its price, or take it off the ballot if it no longer works for everyone.
   */
  async refreshBallot(room: Room, offerId: string) {
    const planning = room.planning;
    if (!planning || planning.stage !== "VOTING") return;
    const option = planning.options.find(item => item.offerIds.includes(offerId));
    const members = this.state.readyMembers(room);
    if (!option || !members) return;
    const best = (await this.state.rankFeasible(await this.state.allOffers(option.offerIds), members))[0];
    if (room.planning !== planning || planning.stage !== "VOTING") return;
    const share = (cents: number) => (Math.ceil(cents / room.memberIds.length) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
    if (best) {
      const before = option.totalCents;
      const idea = planning.destinations.find(item => item.name === option.destination);
      Object.assign(option, { offerId: best.offerId, propertyName: best.propertyName, totalCents: best.totalCents,
        ...(idea ? this.#why(idea, option, members, best.cancellationPolicyCode) : {}) });
      if (best.totalCents !== before) this.state.emit(room, "PLAN_OPTION_UPDATED",
        `${option.destination} changed price: now ${share(best.totalCents)} per person (was ${share(before)}). The ballot is updated.`, undefined,
        { ...ACCORD, detail: "Accord re-checked this destination against everyone’s confirmed requirements. It still works for everyone." });
      this.state.touch(room);
      return;
    }
    planning.options = planning.options.filter(item => item !== option);
    for (const [memberId, vote] of Object.entries(planning.votes)) if (vote === option.id) delete planning.votes[memberId];
    this.state.emit(room, "PLAN_OPTION_REMOVED", `${option.destination} changed and no longer works for everyone, so Accord took it off the ballot.`, undefined,
      { ...ACCORD, detail: "Anyone who picked it can vote again. No one’s requirements or votes are shown to the group." });
    if (!planning.options.length) this.#settle(room, planning, "NO_OPTION", "No trip on the ballot works for everyone anymore. Accord will keep planning.");
    else if (planning.options.length === 1) await this.#decide(room, planning, planning.options[0]!, "ONLY_OPTION");
    else if (Object.keys(planning.votes).length === room.memberIds.length) await this.closeVote(room, "VOTE");
    this.state.touch(room);
  }

  async closeVote(room: Room, by: "VOTE" | "DEADLINE") {
    const planning = room.planning;
    if (!planning || planning.stage !== "VOTING") return;
    const tally = (id: string) => Object.values(planning.votes).filter(vote => vote === id).length;
    // Options are already ordered by fit, so the first with the most votes also wins ties.
    const winner = planning.options.reduce((best, option) => tally(option.id) > tally(best.id) ? option : best, planning.options[0]!);
    await this.#decide(room, planning, winner, by);
  }

  /** Host-only: forget the decided trip and plan again with everyone’s current answers. */
  reopen(room: Room) {
    if (!room.plan) throw new AppError(409, "NOT_A_PLANNED_TRIP");
    if (room.booking) throw new AppError(409, "ALREADY_BOOKED");
    delete room.trip; delete room.search; delete room.planning; delete room.noOption; delete room.widenedFor;
    this.state.emit(room, "PLAN_REOPENED", "The host reopened planning. Accord will work out where and when again.", undefined, { actor: "GROUP" });
    this.state.stale(room, "The host reopened planning.");
  }

  dto(room: Room, viewerId: string): PlanningDTO {
    const members = room.memberIds.map(id => this.state.members.get(id)!);
    const answered = members.filter(member => member.constraints);
    const current = this.current(room);
    const counts = new Map<TripStyle, number>();
    for (const member of answered) for (const style of member.constraints!.tripStyles ?? []) counts.set(style, (counts.get(style) ?? 0) + 1);
    const stage: PlanningDTO["stage"] = current?.stage ?? (answered.length < members.length || members.length < 2 ? "COLLECTING" : "PLANNING");
    const closed = current?.stage === "DECIDED";
    const today = localDay(new Date().toISOString());
    return {
      plan: room.plan!, horizon: { earliest: addDays(today, 1), latest: addDays(today, PLANNING_HORIZON_DAYS) }, stage, ...(current?.message ? { message: current.message } : {}),
      answered: answered.length, total: members.length,
      styles: answered.length >= 2 ? [...counts].sort((a, b) => b[1] - a[1]).map(([style, count]) => ({ style, count })) : [],
      windows: current?.windows ?? [], destinations: (current?.destinations ?? []).map(({ name, why }) => ({ name, why })),
      options: (current?.options ?? []).map(option => ({ id: option.id, destination: option.destination, checkIn: option.checkIn, checkOut: option.checkOut,
        nights: daysBetween(option.checkIn, option.checkOut), propertyName: option.propertyName, totalCents: option.totalCents,
        equalShareCents: Math.ceil(option.totalCents / room.memberIds.length), why: option.why, ...(option.imageUrl ? { imageUrl: option.imageUrl } : {}),
        ...(closed ? { votes: Object.values(current!.votes).filter(vote => vote === option.id).length } : {}) })),
      votesCast: Object.keys(current?.votes ?? {}).length,
      ...(current?.votes[viewerId] ? { myVoteOptionId: current.votes[viewerId] } : {}),
      ...(current?.voteClosesAt && current.stage === "VOTING" ? { voteClosesAt: current.voteClosesAt } : {}),
      ...(current?.decidedOptionId ? { decidedOptionId: current.decidedOptionId, decidedBy: current.decidedBy } : {}),
      rehearsal: !!room.rehearsal,
    };
  }

  async #decide(room: Room, planning: Planning, option: PlanOption, by: NonNullable<Planning["decidedBy"]>) {
    planning.stage = "DECIDED"; planning.decidedOptionId = option.id; planning.decidedBy = by; delete planning.voteClosesAt;
    const tally = (id: string) => Object.values(planning.votes).filter(vote => vote === id).length;
    const votes = tally(option.id);
    const tied = planning.options.some(other => other.id !== option.id && tally(other.id) === votes);
    planning.message = `${option.destination}, ${dayRange(option)}.`;
    room.trip = TripSchema.parse({ destination: option.destination, countryCode: room.plan!.countryCode, checkIn: option.checkIn, checkOut: option.checkOut,
      guests: room.memberIds.length, timeZone: option.timeZone });
    if (room.search) room.search = { ...room.search, offerIds: option.offerIds, destinations: [option.destination] };
    delete room.noOption; delete room.widenedFor;
    this.state.emit(room, "PLAN_DECIDED", by === "ONLY_OPTION"
      ? `Only ${option.destination}, ${dayRange(option)} works for everyone, so Accord is going with it.`
      : `${by === "DEADLINE" ? "Voting closed. " : "Everyone voted. "}${tied
        ? `It was a tie at ${votes} ${votes === 1 ? "vote" : "votes"} each, so Accord went with the trip that fits the group best: ${option.destination}, ${dayRange(option)}.`
        : `The group picked ${option.destination}, ${dayRange(option)} (${votes} of ${room.memberIds.length} votes).`}`,
      undefined, ACCORD);
    this.state.touch(room);
    await this.hooks.propose(room);
  }

  #settle(room: Room, planning: Planning, stage: Planning["stage"], message: string) {
    planning.stage = stage; planning.message = message; this.state.touch(room);
    this.state.emit(room, "AUTOPILOT_NO_OPTION", message, undefined, ACCORD);
  }

  async #noDates(room: Room, planning: Planning, near: Array<DateWindow & { memberId: string }>, nights: number) {
    let waiting = false;
    for (const window of near) {
      const inbox = this.state.members.get(window.memberId)?.inbox ?? [];
      if (inbox.some(entry => entry.nudge?.status === "OPEN")) { waiting = true; continue; }
      if (inbox.filter(entry => entry.kind === "NUDGE").length >= this.hooks.maxNudgesPerMember) continue;
      if (inbox.some(entry => entry.nudge?.status === "KEPT" && entry.nudge.check === "DATES" && entry.nudge.window?.checkIn === window.checkIn)) continue;
      this.state.notify(room, window.memberId, { kind: "NUDGE", title: "One set of dates works for everyone but you",
        body: `Everyone else can travel ${dayRange(window)} (${nights} ${nights === 1 ? "night" : "nights"}). If you can make it, Accord can start planning. You can also keep your dates. No one else will see what you choose.`,
        nudge: { status: "OPEN", check: "DATES", shareCents: 0, window: { checkIn: window.checkIn, checkOut: window.checkOut } } });
      waiting = true;
    }
    this.#settle(room, planning, "NO_OPTION", waiting
      ? "No dates work for everyone yet. Accord has privately checked in with some members."
      : "No dates work for everyone. Members can update when they’re free.");
  }

  /** Every catalog/AI destination was ruled out by someone's avoid list. Privately ask whoever alone blocks a workable trip. */
  async #noDestinations(room: Room, planning: Planning, members: Ready, windows: DateWindow[]) {
    const styleCounts: Partial<Record<TripStyle, number>> = {};
    for (const member of members) for (const style of member.constraints.tripStyles ?? []) styleCounts[style] = (styleCounts[style] ?? 0) + 1;
    const ideas = members.map(member => member.constraints.placeIdeas?.trim()).filter((text): text is string => !!text).sort();
    const from = members.map(member => member.constraints.leavingFrom?.trim()).filter((text): text is string => !!text).sort();
    const months = [...new Set(windows.flatMap(window => [window.checkIn, window.checkOut]).map(day => Number(day.slice(5, 7))))];
    const blockers = members.filter(member => member.constraints.placesToAvoid?.trim());
    let waiting = false;
    for (const member of blockers) {
      const place = member.constraints.placesToAvoid!.trim();
      const avoidWithoutMe = blockers.filter(other => other.id !== member.id).map(other => other.constraints.placesToAvoid!.trim());
      // If a good trip still doesn't emerge even without this member's avoid list, they aren't the (sole) blocker; don't ask them.
      const unlocked = rankDestinations({ region: regionFor(from), styleCounts, ideas, avoid: avoidWithoutMe, from, months }, 1);
      if (!unlocked.length) continue;
      const inbox = member.inbox ?? [];
      if (inbox.some(entry => entry.nudge?.status === "OPEN")) { waiting = true; continue; }
      if (inbox.filter(entry => entry.kind === "NUDGE").length >= this.hooks.maxNudgesPerMember) continue;
      if (inbox.some(entry => entry.nudge?.status === "KEPT" && entry.nudge.check === "PLACE" && entry.nudge.place === place)) continue;
      this.state.notify(room, member.id, { kind: "NUDGE", title: "One trip works for everyone but you",
        body: `${unlocked[0]!.name} could work for everyone else, but you said to avoid it. You can drop that for this trip, or keep it. No one else will see what you choose.`,
        nudge: { status: "OPEN", check: "PLACE", shareCents: 0, place } });
      waiting = true;
    }
    this.#settle(room, planning, "NO_OPTION", waiting
      ? "No destination works for everyone yet. Accord has privately checked in with some members."
      : "Every destination Accord considered was ruled out by someone. Members can revisit the places they’d rather avoid.");
  }

  async #destinations(room: Room, members: Ready, windows: DateWindow[]) {
    const styleCounts: Partial<Record<TripStyle, number>> = {};
    for (const member of members) for (const style of member.constraints.tripStyles ?? []) styleCounts[style] = (styleCounts[style] ?? 0) + 1;
    // Sorted so the order can't hint at who wrote what.
    const answers = (pick: (constraints: Constraints) => string | undefined) => members.map(member => pick(member.constraints)?.trim()).filter((text): text is string => !!text).sort();
    const ideas = answers(item => item.placeIdeas), avoid = answers(item => item.placesToAvoid), from = answers(item => item.leavingFrom);
    const ruledOut = (name: string) => avoid.some(text => mentions(text, name)) || from.some(text => isHome(text, name));
    // Specific places people asked for (not vague wishes, not ruled out by anyone else).
    const named = [...new Map(ideas.filter(idea => looksLikeAPlace(idea) && !ruledOut(idea)).map(idea => [idea.toLowerCase(), idea])).values()];
    // When people named places, the ballot is exactly those places: every one is represented, and nothing
    // nobody asked for is added. The group then settles it by private vote. With no named places, Accord picks.
    const honor = <T extends { name: string }>(candidates: T[], make: (idea: string) => T) => {
      if (!named.length) return candidates.slice(0, MAX_DESTINATIONS);
      const asked = candidates.filter(item => named.some(idea => alreadyCovers(idea, item.name)));
      const missed = named.filter(idea => !asked.some(item => alreadyCovers(idea, item.name)));
      return [...asked, ...missed.map(make)];
    };
    const suggest = this.state.providers.suggestDestinations;
    if (suggest) {
      const input: DestinationsInput = { from, countryCode: room.plan!.countryCode, nights: daysBetween(windows[0]!.checkIn, windows[0]!.checkOut),
        guests: members.length, windows, styleCounts, ideas, avoid };
      const suggested = (await suggest(input).catch(() => undefined) ?? [])
        .map(idea => ({ name: idea.name.trim(), timeZone: validZone(idea.timeZone) ? idea.timeZone : "America/New_York", why: idea.why.trim().slice(0, 160), styles: idea.styles }))
        .filter((idea, index, all) => idea.name.length >= 2 && !ruledOut(idea.name) && all.findIndex(other => other.name.toLowerCase() === idea.name.toLowerCase()) === index);
      // The model can drop or substitute a place someone asked for; its judgment never overrides an explicit request.
      const chosen = honor(suggested, idea => ({ name: idea, timeZone: "America/New_York", why: "Someone in the group asked to go here.", styles: [] as TripStyle[] }));
      if (chosen.length) return { ideas: chosen, source: "AI" as const };
    }
    const months = [...new Set(windows.flatMap(window => [window.checkIn, window.checkOut]).map(day => Number(day.slice(5, 7))))];
    const ranked = rankDestinations({ region: regionFor(from), styleCounts, ideas, avoid, from, months }, Math.max(MAX_DESTINATIONS, named.length)).map(item => {
      const matched = item.styles.filter(style => styleCounts[style]);
      return { name: item.name, timeZone: item.timeZone, styles: item.styles,
        why: matched.length ? `Known for ${list(matched.map(style => styleLabel[style]))}.` : ideas.some(text => mentions(text, item.name)) ? "Someone suggested it." : "A popular group trip." };
    });
    return { source: "ACCORD" as const, ideas: honor(ranked, idea => ({ name: idea, timeZone: "America/New_York", styles: [] as TripStyle[], why: "Someone in the group asked to go here." })) };
  }

  /** Public-safe reasons: anonymous totals and facts about the stay, never an individual's answer. */
  #why({ name: destination, styles }: DestinationIdea, window: DateWindow, members: Ready, cancellation: string) {
    const fans = members.filter(member => member.constraints.tripStyles?.some(style => styles.includes(style)));
    const picked = [...new Set(fans.flatMap(member => member.constraints.tripStyles ?? []).filter(style => styles.includes(style)))];
    // An anonymous count, like the style totals: how many people asked for this place, never who.
    const askers = members.filter(member => member.constraints.placeIdeas && alreadyCovers(member.constraints.placeIdeas, destination)).length;
    const why = [
      ...(askers ? [`${askers} of ${members.length} ${members.length === 1 ? "person" : "people"} asked to go here.`] : []),
      ...(fans.length ? [`Fits the ${list(picked.map(style => styleLabel[style]))} ${picked.length === 1 ? "pick" : "picks"} of ${fans.length} of ${members.length} people.`] : []),
      `Everyone is free ${dayRange(window)}.`,
      "The stay meets every confirmed requirement.",
      ...(cancellation === "FULL_CASH_REFUND" ? ["Fully refundable."] : []),
    ];
    // A place people explicitly asked for outweighs a style match, so the most-requested place leads the ballot and wins ties.
    return { why, fit: fans.length + 2 * askers };
  }
}

