import { z } from "zod";
import { attempt, requestJson } from "./result.js";
import type { Fetch } from "./result.js";

// Provider wire formats, not Accord domain records.
const assistantResponse = z.object({ assistant_id: z.string().min(1) });
const memoryResponse = z.object({ id: z.string().min(1), content: z.string(), metadata: z.record(z.string(), z.unknown()).nullish() });

export class Backboard {
  constructor(private readonly config: { apiKey?: string; fetch?: Fetch }) {}

  private request(path: string, body?: unknown) {
    return requestJson(this.config.fetch ?? fetch, `https://app.backboard.io/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-API-Key": this.config.apiKey!, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Backend serializes provisioning per authenticated user and saves the ID in Mongo. */
  createAssistant() {
    return attempt("backboard", Boolean(this.config.apiKey), async () => assistantResponse.parse(await this.request("/assistants", {
      name: "Accord private preferences",
      system_prompt: "This assistant stores only reusable planning preferences explicitly confirmed by this Accord user. Never store budgets, private explanations, trip requirements, proposal approvals, payment authorizations, or credentials.",
      custom_fact_extraction_prompt: "Extract reusable travel preferences only when the user explicitly asks Accord to remember them. Never infer a preference, financial limit, health/accessibility fact, personal motivation, or current-trip requirement.",
    })));
  }

  /** This is an INTERNAL port. Resolve assistantId from session-owned Mongo user, never request parameters. */
  remember(assistantId: string, preference: "WALKABLE" | "QUIET" | "NEAR_ACTIVITIES" | "REFUNDABLE", explicitlyConfirmed: boolean) {
    const labels = { WALKABLE: "Prefers walkable neighborhoods", QUIET: "Prefers quiet properties", NEAR_ACTIVITIES: "Prefers staying near activities", REFUNDABLE: "Generally prefers refundable options" };
    return attempt("backboard", Boolean(this.config.apiKey), async () => {
      if (explicitlyConfirmed !== true || !Object.hasOwn(labels, preference)) throw new Error("Confirmation required");
      // The create endpoint documents no stable response body. Confirm the write by reading Backboard's real list.
      await this.request(`/assistants/${encodeURIComponent(assistantId)}/memories`, {
        content: labels[preference], metadata: { source: "accord_explicit_confirmation", preference },
      });
      const memories = await this.list(assistantId);
      const saved = memories.find(memory => memory.metadata?.source === "accord_explicit_confirmation" && memory.metadata.preference === preference && memory.content === labels[preference]);
      if (!saved) throw new Error("Backboard memory not visible after write");
      return saved;
    });
  }

  recall(assistantId: string) {
    return attempt("backboard", Boolean(this.config.apiKey), async () => {
      const memories = await this.list(assistantId);
      return memories.filter(memory => memory.metadata?.source === "accord_explicit_confirmation")
        .map(memory => ({ ...memory, requiresConfirmation: true as const, applied: false as const }));
    });
  }

  private async list(assistantId: string) {
    const path = `/assistants/${encodeURIComponent(assistantId)}/memories`;
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const result = z.object({ memories: z.array(memoryResponse), total_count: z.number().int().nonnegative() }).parse(
        await this.request(`${path}?page=${page}&page_size=100`));
      all.push(...result.memories);
      if (all.length >= result.total_count || result.memories.length === 0) return all;
    }
    throw new Error("Backboard memory list exceeds safe page limit");
  }
}
