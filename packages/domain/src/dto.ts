/** Server-owned wire contracts. Public DTOs contain public fields only. */
import type { Constraints } from "./schemas.js";
export type PublicRoomDTO = {
  id: string; name: string; goal: string;
  status: 'COLLECTING' | 'SEARCHING' | 'PROPOSAL_ACTIVE' | 'STALE' | 'BOOKED';
  memberCount: number; readyMemberCount: number; activeProposalId?: string;
};
export type PublicOfferDTO = {
  offerId: string; offerVersion: string; merchantName: string; propertyName: string;
  city: string; roomType: string; checkInAt: string; checkOutAt: string;
  guestCapacity: number; stepFreeVerified: boolean | null; cancellationLabel: string;
  subtotalCents: number; mandatoryFeesCents: number; totalCents: number;
  equalShareCents: number; available: boolean; expiresAt: string; feasible: boolean;
  publicFeasibilityMessage: string;
  stability?: { observationCount: number; materialChangeCount: number; label: 'STABLE' | 'MIXED' | 'VOLATILE' };
};
export type PublicProposalDTO = {
  proposalId: string; version: number; proposalHash: string;
  state: 'OPEN' | 'READY_TO_EXECUTE' | 'STALE' | 'BOOKED' | 'CANCELLED';
  offer: PublicOfferDTO; equalShareCents: number;
  authorization: { authorizedCount: number; requiredCount: number; authorizedTotalCents: number; requiredTotalCents: number };
  expiresAt: string;
  solana?: { status: 'NOT_RECORDED' | 'PENDING' | 'CONFIRMED' | 'FAILED'; transactionSignature?: string; explorerUrl?: string };
};
export type PrivateProposalDTO = {
  proposal: PublicProposalDTO; myContributionCents: number;
  myApprovalStatus: 'PENDING' | 'APPROVED' | 'INVALIDATED';
  myPaymentStatus: 'PENDING' | 'AUTHORIZED' | 'INVALIDATED' | 'CAPTURED' | 'RELEASED' | 'FAILED';
  myConstraintChecks: Array<{ kind: string; label: string; status: 'PASS' | 'FAIL' | 'UNKNOWN'; privateExplanation: string }>;
};
export type ConsentResponseDTO = {
  proposalId: string; version: number; proposalHash: string; approvalStatus: 'APPROVED';
  paymentAuthorizationStatus: 'AUTHORIZED'; amountCents: number;
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
  funnel: Array<{ label: string; count: number }>;
  matrix?: { offers: Array<{ id: string; label: string }>; rows: Array<{ id: string; label: string; results: Array<'PASS' | 'FAIL' | 'UNKNOWN'> }> };
};
export type ReceiptDTO = {
  status: 'CONFIRMED'; bookingReference: string; bookedAt: string;
  providerModeLabel: string; confirmationLabel: string; guestCount: number;
  proposal: PublicProposalDTO;
};
export type MerchantDTO = {
  offers: Array<{ offerId: string; propertyName: string; offerVersion: string; totalCents: number; cancellationLabel: string; available: boolean }>;
};
export type AnalyticsDTO = {
  source: 'TIGER'; points: Array<{ at: string; totalCents: number; label: string }>;
};
