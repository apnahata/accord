import type { Extraction } from "@accord/domain";

// A model question only blocks the draft when it is about something the member actually raised.
// Otherwise it becomes an optional follow-up shown next to the draft, which the member reviews anyway.
const raisedBy: Record<string, RegExp> = {
  latestCheckOutAt: /\b(leave|leaving|check ?out|depart\w*|home by|back by|by (noon|midnight|morning|evening|\d)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|noon|\d{1,2}(:\d\d)?\s?(am|pm|a\.m\.|p\.m\.)|date|deadline)\b/i,
  requiresFullCashRefund: /refund|cancel|credit/i,
  requiresStepFreeAccess: /step|stair|wheelchair|access|elevator|lift|mobility/i,
};

export type IntakeTriage = { blocking?: string; followUps: string[]; notChecked: string[] };

export function triageExtraction(extraction: Extraction, memberText: string): IntakeTriage {
  const followUps: string[] = [];
  let blocking: string | undefined;
  for (const { field, question } of extraction.ambiguities) {
    const blocks = field.includes("maxContributionCents") ||
      Object.entries(raisedBy).some(([key, pattern]) => field.includes(key) && pattern.test(memberText));
    if (blocks) blocking ??= question; else followUps.push(question);
  }
  return { blocking, followUps, notChecked: extraction.unsupportedHardRequirements.map(item => item.rawText) };
}
