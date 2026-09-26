import { z } from "zod";
import { ConstraintsSchema, type OffersDTO, type PrivateProposalEnvelope } from "@accord/domain";
import { Gemini } from "../../integrations/src/ai.js";
import { AppError } from "./state.js";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const fact = z.object({ id: z.string(), text: z.string() }).strict();
const publicInput = z.object({ recommendedOfferId: z.string(), reasons: z.array(fact), tradeoffs: z.array(fact) }).strict();
const publicChoice = z.object({ reasonIds: z.array(z.string()).min(1).max(4), tradeoffIds: z.array(z.string()).max(3) }).strict();
const privateInput = z.object({
  proposalHash: z.string(), proposalState: z.string(), propertyName: z.string(),
  originalContributionCents: z.number().int(), currentContributionCents: z.number().int(),
  ownConstraints: ConstraintsSchema,
  ownChecks: z.array(z.object({ kind: z.string(), status: z.enum(["PASS", "FAIL", "UNKNOWN"]), explanation: z.string() }).strict()),
}).strict();

/** A public projection assembled exclusively from the domain's public solver DTO. */
export function publicExplanationInput(data: OffersDTO) {
  const recommended = data.offers.find(offer => offer.offerId === data.recommendedOfferId && offer.feasible);
  if (!recommended) throw new AppError(409, "NO_FEASIBLE_OFFER");
  const feasible = data.offers.filter(offer => offer.feasible);
  const reasons = [
    { id: "requirements", text: `${recommended.propertyName} meets every confirmed group requirement according to Accord's backend checks.` },
    { id: "price", text: `${recommended.propertyName} costs ${money(recommended.totalCents)} total, or up to ${money(recommended.equalShareCents)} per person.` },
    { id: "terms", text: `${recommended.propertyName} has ${recommended.cancellationLabel.toLowerCase()} cancellation terms.` },
    { id: "checkout", text: `${recommended.propertyName} has a listed checkout time of ${recommended.checkOutAt}.` },
    { id: "ranking", text: `Accord's deterministic ranking selected ${recommended.propertyName} from ${feasible.length} feasible ${feasible.length === 1 ? "stay" : "stays"}.` },
  ];
  const tradeoffs = feasible.filter(offer => offer.offerId !== recommended.offerId).map(offer => ({
    id: `alternative:${offer.offerId}`,
    text: `${offer.propertyName} is also feasible and costs ${money(offer.totalCents)} total, ${offer.totalCents < recommended.totalCents ? `${money(recommended.totalCents - offer.totalCents)} less` : offer.totalCents > recommended.totalCents ? `${money(offer.totalCents - recommended.totalCents)} more` : "the same amount"} than ${recommended.propertyName}.`,
  }));
  if (!tradeoffs.length) tradeoffs.push({ id: "only-option", text: "No other current catalog stay satisfies every confirmed group requirement." });
  return { recommendedOfferId: recommended.offerId, reasons, tradeoffs };
}

function selectedFacts(ids: string[], allowed: Array<{ id: string; text: string }>) {
  const unique = new Set(ids);
  const byId = new Map(allowed.map(item => [item.id, item.text]));
  if (unique.size !== ids.length || ids.some(id => !byId.has(id))) throw new AppError(503, "AI_UNAVAILABLE");
  return ids.map(id => byId.get(id)!);
}

export async function explainPublic(model: Gemini, data: OffersDTO) {
  const input = publicExplanationInput(data);
  const result = await model.generate({ input: publicInput, output: publicChoice }, input,
    "Choose the most useful public facts to explain the backend's already-selected feasible stay. Return only IDs copied from the supplied reason and tradeoff lists. Prioritize the verified group fit, price, and meaningful alternative comparisons. Do not write new claims, change the recommendation, or mention individual members or their requirements.");
  if (result.status !== "OK") throw new AppError(503, "AI_UNAVAILABLE");
  if (!result.value.data.reasonIds.includes("requirements")) throw new AppError(503, "AI_UNAVAILABLE");
  const reasons = selectedFacts(result.value.data.reasonIds, input.reasons);
  const tradeoffs = selectedFacts(result.value.data.tradeoffIds, input.tradeoffs);
  const recommended = data.offers.find(offer => offer.offerId === input.recommendedOfferId)!;
  return { source: "GEMINI" as const, model: result.value.model, recommendedOfferId: recommended.offerId,
    offerVersion: recommended.offerVersion, headline: `Why Accord recommends ${recommended.propertyName}`,
    reasons, tradeoffs, nextAction: "Compare the stays, then review the exact proposal together." };
}

export async function explainPrivate(model: Gemini, data: PrivateProposalEnvelope, ownConstraints: z.infer<typeof ConstraintsSchema>, currentContributionCents: number) {
  const input = {
    proposalHash: data.proposal.proposalHash, proposalState: data.proposal.state,
    propertyName: data.proposal.offer.propertyName,
    originalContributionCents: data.myContributionCents, currentContributionCents,
    ownConstraints,
    ownChecks: data.myConstraintChecks.map(check => ({ kind: check.kind, status: check.status, explanation: check.privateExplanation })),
  };
  const blockers = data.myConstraintChecks.filter(check => check.status !== "PASS").length;
  const privateChoice = z.object({ selectedCheckKinds: z.array(z.string()).min(1).max(Math.max(3, blockers)) }).strict();
  const result = await model.generate({ input: privateInput, output: privateChoice }, input,
    "Select the most important deterministic check IDs in order. If all checks pass, choose at most three that are useful to this member. Include every FAIL or UNKNOWN check before any PASS check. Return only kind IDs from ownChecks. You cannot alter a check or infer why a member has a requirement. Do not discuss other members.");
  if (result.status !== "OK") throw new AppError(503, "AI_UNAVAILABLE");
  const ids = result.value.data.selectedCheckKinds;
  const checks = new Map(data.myConstraintChecks.map(check => [check.kind, check]));
  if (new Set(ids).size !== ids.length || ids.some(id => !checks.has(id)) ||
      data.myConstraintChecks.some(check => check.status !== "PASS" && !ids.includes(check.kind))) throw new AppError(503, "AI_UNAVAILABLE");
  const blocked = data.myConstraintChecks.some(check => check.status !== "PASS");
  return { source: "GEMINI" as const, model: result.value.model, proposalHash: data.proposal.proposalHash,
    headline: data.proposal.state === "STALE" ? "This proposal needs a fresh decision" : blocked ? "This stay does not meet all your requirements" : "Your confirmed requirements are met",
    reasons: ids.map(id => checks.get(id)!.privateExplanation),
    nextAction: data.proposal.state === "STALE" ? "Review a new proposal before authorizing anything." : blocked ? "Do not authorize this proposal. Review your requirements or wait for another stay." : "Review the exact offer and your share before you decide whether to authorize." };
}

export function publicOffersFingerprint(data: OffersDTO) {
  return JSON.stringify({ recommendedOfferId: data.recommendedOfferId,
    offers: data.offers.map(offer => [offer.offerId, offer.offerVersion, offer.feasible, offer.totalCents, offer.cancellationLabel, offer.available, offer.expiresAt]) });
}
