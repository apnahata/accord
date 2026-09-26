/** Server-owned wire contracts. Public DTOs contain public fields only. */
import type { Constraints, Trip } from "./schemas.js";
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
};
export type StayResearchDTO = { sourceLabel: string; pros: string[]; cons: string[]; nearby: string[]; summary?: string };
export type PublicOfferDTO = {
  offerId: string; offerVersion: string; merchantName: string; propertyName: string;
  city: string; roomType: string; checkInDate: string; checkOutDate: string; checkInAt: string; checkOutAt: string;
  checkInTimeKnown: boolean; checkOutTimeKnown: boolean;
  guestCapacity: number; stepFreeVerified: boolean | null; cancellationLabel: string;
  subtotalCents: number; mandatoryFeesCents: number; totalCents: number;
  equalShareCents: number; available: boolean; expiresAt: string; feasible: boolean;
  publicFeasibilityMessage: string;
  source: 'DEMO' | 'LITEAPI' | 'GOOGLE_HOTELS';
  sourceLabel: string;
  bookingMode: 'SIMULATED' | 'SANDBOX' | 'EXTERNAL';
  imageUrl?: string; address?: string; rating?: number; reviewCount?: number; externalUrl?: string;
  research?: StayResearchDTO;
  stability?: { observationCount: number; materialChangeCount: number; label: 'STABLE' | 'MIXED' | 'VOLATILE' };
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
export type { Constraints } from "./schemas.js";
export type CapsuleDTO = { displayName: string; constraints: Constraints | null; confirmedAt?: string };
export type Capabilities = {
  ai: { available: boolean }; elevenLabs: { available: boolean };
  backboard: { available: boolean }; tiger: { available: boolean };
};
export type MemoryDTO = { id: string; label: string; applied: boolean };
export type EventDTO = { id: string; occurredAt: string; title: string; detail?: string };
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
};
export type AnalyticsDTO = {
  source: 'TIGER'; points: Array<{ at: string; totalCents: number; label: string }>;
};
