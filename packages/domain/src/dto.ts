/** Server-owned wire contracts. Public DTOs contain public fields only. */
import type { Constraints, Trip, TripPlan, TripStyle } from "./schemas.js";
export type PublicRoomDTO = {
  id: string; name: string; goal: string;
  status: 'COLLECTING' | 'SEARCHING' | 'PROPOSAL_ACTIVE' | 'STALE' | 'BOOKED';
  memberCount: number; readyMemberCount: number; activeProposalId?: string;
  /** Names and confirmation status only; requirements themselves are never included. */
  members: Array<{ id: string; displayName: string; ready: boolean; isHost: boolean; isYou: boolean }>;
  viewerIsHost: boolean;
  /** Present when the host created the room with real trip details (live search). */
  trip?: Trip;
  lastSearch?: { searchedAt: string; providers: Array<{ provider: string; status: string; count: number }> };
  /** What Accord's coordinator is doing on its own right now. Public-safe; never names a blocking member. */
  autopilot: AutopilotDTO;
  /** Present when the group asked Accord to help decide where and when. */
  planning?: PlanningDTO;
};
export type AutopilotDTO = {
  status: 'IDLE' | 'WAITING_FOR_MEMBERS' | 'SEARCHING' | 'REPLANNING' | 'WIDENING' | 'WATCHING' | 'NO_OPTION' | 'PLANNING' | 'VOTING';
  message: string;
};
export type TripOptionDTO = {
  id: string; destination: string; checkIn: string; checkOut: string; nights: number;
  propertyName: string; totalCents: number; equalShareCents: number; imageUrl?: string;
  /** Public-safe reasons: anonymous totals and facts about the stay, never a member's answer. */
  why: string[];
  /** Only revealed once voting closes. */
  votes?: number;
};
/** Everything here is an anonymous total across members or something Accord worked out from them. */
export type PlanningDTO = {
  plan: TripPlan;
  /** Days members can say they're free on. */
  horizon: { earliest: string; latest: string };
  stage: 'COLLECTING' | 'PLANNING' | 'VOTING' | 'DECIDED' | 'NO_OPTION';
  message?: string;
  answered: number; total: number;
  /** How many members picked each style; hidden until at least two people have answered. */
  styles: Array<{ style: TripStyle; count: number }>;
  windows: Array<{ checkIn: string; checkOut: string }>;
  destinations: Array<{ name: string; why: string }>;
  options: TripOptionDTO[];
  votesCast: number; myVoteOptionId?: string; voteClosesAt?: string;
  decidedOptionId?: string; decidedBy?: 'VOTE' | 'ONLY_OPTION' | 'DEADLINE';
  /** Demo planning uses Accord's generated rehearsal stays instead of live providers. */
  rehearsal: boolean;
};
export type StayResearchDTO = { sourceLabel: string; pros: string[]; cons: string[]; nearby: string[]; summary?: string };
export type PublicOfferDTO = {
  offerId: string; offerVersion: string; merchantName: string; propertyName: string;
  city: string; roomType: string; checkInDate: string; checkOutDate: string; checkInAt: string; checkOutAt: string;
  checkInTimeKnown: boolean; checkOutTimeKnown: boolean;
  /** IANA zone of the stay; check-in and check-out times are shown in it. */
  timeZone: string;
  guestCapacity: number; stepFreeVerified: boolean | null; cancellationLabel: string;
  subtotalCents: number; mandatoryFeesCents: number; totalCents: number;
  equalShareCents: number; available: boolean; expiresAt: string; feasible: boolean;
  publicFeasibilityMessage: string;
  source: 'DEMO' | 'LITEAPI' | 'GOOGLE_HOTELS';
  sourceLabel: string;
  bookingMode: 'SIMULATED' | 'SANDBOX' | 'EXTERNAL';
  imageUrl?: string; address?: string; rating?: number; reviewCount?: number; externalUrl?: string;
  research?: StayResearchDTO;
  /** Observed price stability for this exact trip (Tiger Data). history: 5-minute buckets, latest price per bucket. */
  stability?: { observationCount: number; materialChangeCount: number; label: 'STABLE' | 'MIXED' | 'VOLATILE';
    minCents?: number; maxCents?: number; history?: Array<{ at: string; totalCents: number }> };
};
export type PublicProposalDTO = {
  proposalId: string; version: number; proposalHash: string;
  state: 'OPEN' | 'READY_TO_EXECUTE' | 'STALE' | 'BOOKED' | 'CANCELLED';
  offer: PublicOfferDTO; equalShareCents: number;
  approval: { approvedCount: number; requiredCount: number };
  /** One shared provider transaction funds the group after every member approves their own contribution. */
  authorization: {
    status: 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'RELEASED' | 'FAILED';
    transactionCount: number; authorizedTotalCents: number; requiredTotalCents: number;
  };
  expiresAt: string;
  solana?: { status: 'NOT_RECORDED' | 'PENDING' | 'CONFIRMED' | 'FAILED'; transactionSignature?: string; explorerUrl?: string };
  /** PROVIDER_REQUOTE: re-priced with the provider; RECORD: compared to Accord's merchant record; SEARCH_TIME: not re-checkable after search. */
  watch?: { lastCheckedAt: string; method: 'PROVIDER_REQUOTE' | 'RECORD' | 'SEARCH_TIME' };
};
export type PrivateProposalDTO = {
  proposal: PublicProposalDTO; myContributionCents: number;
  myApprovalStatus: 'PENDING' | 'APPROVED' | 'INVALIDATED';
  myPaymentStatus: 'PENDING' | 'COMMITTED' | 'AUTHORIZED' | 'INVALIDATED' | 'CAPTURED' | 'RELEASED' | 'FAILED';
  wallet: {
    currency: 'USD'; provider: 'CYBERSOURCE' | 'DEMO';
    /** This member's allocation inside the shared authorization/capture, not a separate card charge. */
    heldCents: number; spentCents: number; transactionId?: string;
  };
  myConstraintChecks: Array<{ kind: string; label: string; status: 'PASS' | 'FAIL' | 'UNKNOWN'; privateExplanation: string }>;
};
export type ConsentResponseDTO = {
  proposalId: string; version: number; proposalHash: string; approvalStatus: 'APPROVED';
  paymentAuthorizationStatus: 'PENDING' | 'AUTHORIZED' | 'CAPTURED'; amountCents: number;
};
export type { Constraints, TripPlan, TripStyle, Availability } from "./schemas.js";
export type CapsuleDTO = { displayName: string; constraints: Constraints | null; confirmedAt?: string };
export type Capabilities = {
  ai: { available: boolean }; elevenLabs: { available: boolean };
  backboard: { available: boolean }; tiger: { available: boolean };
  autopilot: { available: boolean }; liveSearch: { available: boolean };
};
export type MemoryDTO = { id: string; label: string; applied: boolean };
export type EventDTO = { id: string; occurredAt: string; title: string; detail?: string; actor?: 'ACCORD' | 'MERCHANT' | 'GROUP' };
/** Private to one member. Only that member's own limits may appear in title/body. */
export type InboxMessageDTO = {
  id: string; at: string;
  kind: 'STALE_REASON' | 'NUDGE' | 'REMINDER' | 'READY_TO_BOOK' | 'EXPIRING' | 'INFO' | 'VOTE';
  title: string; body: string; proposalId?: string;
  nudge?: { status: 'OPEN' | 'ACCEPTED' | 'KEPT' | 'EXPIRED'; check: 'BUDGET' | 'REFUND' | 'CHECKOUT' | 'DATES' | 'PLACE'; acceptLabel: string; keepLabel: string };
};
export type InboxDTO = { messages: InboxMessageDTO[] };
export type PublicChange = { label: string; before: string; after: string };
export type ProposalEnvelope = {
  roomId: string; proposal: PublicProposalDTO; changes?: PublicChange[];
  previousProposalHash?: string; currentProposalHash?: string;
  paymentModeLabel: string; bookingModeLabel: string; inventoryLabel: string;
  canExecute: boolean;
};
export type PrivateProposalEnvelope = Omit<ProposalEnvelope, 'proposal'> & PrivateProposalDTO;
export type OffersDTO = {
  inventoryLabel: string; offers: PublicOfferDTO[];
  recommendedOfferId?: string; recommendationReasons: string[];
  providerResults: Array<{ provider: string; status: string; count: number; detail?: string }>;
  funnel: Array<{ label: string; count: number }>;
  matrix?: { offers: Array<{ id: string; label: string }>; rows: Array<{ id: string; label: string; results: Array<'PASS' | 'FAIL' | 'UNKNOWN'> }> };
};
export type ReceiptDTO = {
  /** HANDOFF: the group approved an external listing; the host completes the purchase on the listing site. */
  status: 'CONFIRMED' | 'HANDOFF'; bookingReference: string; bookedAt: string; externalUrl?: string;
  providerModeLabel: string; confirmationLabel: string; guestCount: number;
  payment: {
    provider: 'CYBERSOURCE' | 'SIMULATED'; environment: 'SANDBOX' | 'DEMO';
    status: 'CAPTURED' | 'NOT_CAPTURED'; transactionCount: number; capturedTotalCents: number; transactionId?: string;
  };
  proposal: PublicProposalDTO;
};
export type AccountDTO = {
  user: { id: string; displayName: string; email?: string; createdAt: string };
  groups: Array<{
    roomId: string; name: string; role: 'HOST' | 'MEMBER'; status: PublicRoomDTO['status'];
    memberCount: number; readyMemberCount: number; trip?: Trip; activeProposalId?: string;
    booking?: { reference: string; confirmedAt: string; propertyName: string; city: string; totalCents: number; ownContributionCents: number; paymentStatus: PrivateProposalDTO['myPaymentStatus'] };
  }>;
  payments: Array<{
    roomId: string; roomName: string; proposalId: string; proposalVersion: number; propertyName: string;
    amountCents: number; status: PrivateProposalDTO['myPaymentStatus']; provider: 'CYBERSOURCE' | 'DEMO';
    scope: 'MEMBER_COMMITMENT' | 'SHARED_PAYMENT'; label: string;
    recordedAt: string; transactionId?: string;
  }>;
};
export type MerchantDTO = {
  offers: Array<{ offerId: string; propertyName: string; offerVersion: string; totalCents: number; cancellationLabel: string; available: boolean }>;
  /** The offer in the group's current open proposal, if any. Changing it is what stales consent. */
  activeOfferId?: string;
  /** While the group is voting: the stay shown for each destination on the ballot. Changing one re-checks the ballot. */
  ballotOfferIds?: string[];
};
export type AnalyticsDTO = {
  source: 'TIGER'; points: Array<{ at: string; totalCents: number; label: string }>;
};
export type PulseDTO = {
  source: 'TIGER'; queryMs: number; generatedAt: string;
  totals: { observations: number; listings: number; destinations: number; firstObservedAt?: string; byProvider: Record<string, number> };
  storage: { totalBytes: number; chunks: number; compressedChunks: number; beforeBytes: number; afterBytes: number; ratio?: number };
  markets: Array<{ destination: string; points: Array<{ at: string; nightlyCents: number }> }>;
  movers: Array<{ offerId: string; propertyName: string; destination: string; changes: number; minCents: number; maxCents: number; latestCents: number }>;
  consensus: { proposals: number; ready: number; stale: number; booked: number; medianMinutesToReady?: number; medianSecondsStaleToReplan?: number; medianStaleDetectionMs?: number };
  activity: Array<{ at: string; counts: Record<string, number> }>;
};
/** Room-scoped slice of the same Tiger telemetry: how many live prices Accord has checked for this room's exact trip. */
export type RoomPulseDTO = { source: 'TIGER'; observations: number; listings: number };
