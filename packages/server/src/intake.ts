import type { Extraction } from "@accord/domain";

export type IntakeTriage = { blocking?: string; followUps: string[]; notChecked: string[] };

const DATE_FIELDS = new Set(["earliestCheckInDate", "latestCheckInDate", "latestCheckOutDate", "earliestCheckInAt", "latestCheckInAt", "latestCheckOutAt"]);
const TIME_FIELDS = new Set(["earliestCheckInAt", "latestCheckInAt", "latestCheckOutAt"]);

/** The model may suggest questions, but an explicit "I don't care" is authoritative. */
export function respectExplicitOptionality(extraction: Extraction, latestMemberText: string): Extraction {
  const text = latestMemberText.toLowerCase().replace(/[’]/g, "'");
  const noDatePreference = /(?:no|without|don't have|do not have|dont have)\s+(?:any\s+)?(?:date|dates|check[- ]?in|check[- ]?out|arrival|departure)(?:\s+or\s+time)?\s+(?:preference|preferences|restriction|restrictions)/.test(text)
    || /(?:do not|don't|dont)\s+care\s+(?:about\s+)?(?:the\s+)?(?:date|dates|when|check[- ]?in|check[- ]?out|arrival|departure)/.test(text)
    || /\bany\s+(?:date|dates|check[- ]?in|check[- ]?out)\s+(?:is|are|works?|would work)/.test(text);
  const noTimePreference = /(?:no|without)\s+(?:arrival|departure|check[- ]?in|check[- ]?out)?\s*time\s+(?:preference|preferences|restriction|restrictions)/.test(text)
    || /(?:do not|don't|dont)\s+care\s+(?:about\s+)?(?:the\s+)?(?:arrival|departure|check[- ]?in|check[- ]?out)?\s*time/.test(text);
  const noOptionalPreferences = /\b(?:no|don't have|do not have)\s+(?:other\s+|any\s+)?preferences?\b/.test(text);
  if (!noDatePreference && !noTimePreference && !noOptionalPreferences) return extraction;
  const proposed = { ...extraction.proposed };
  const fieldsToClear = noDatePreference || noOptionalPreferences ? DATE_FIELDS : TIME_FIELDS;
  for (const field of fieldsToClear) delete (proposed as Record<string, unknown>)[field];
  if (noOptionalPreferences) {
    proposed.requiresFullCashRefund = false;
    proposed.requiresStepFreeAccess = false;
    proposed.softPreferences = [];
  }
  return {
    ...extraction,
    proposed,
    ambiguities: extraction.ambiguities.filter(item => !fieldsToClear.has(item.field)),
  };
}

export function triageExtraction(extraction: Extraction): IntakeTriage {
  return {
    blocking: extraction.ambiguities[0]?.question,
    followUps: [],
    notChecked: extraction.unsupportedHardRequirements.map(item => item.rawText),
  };
}
