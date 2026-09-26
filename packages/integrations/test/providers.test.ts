import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Backboard, ElevenLabs, Gemini, createIntelligence, health } from "../src/index.js";
import type { Fetch } from "../src/result.js";

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const task = { input: z.object({ text: z.string() }), output: z.strictObject({ question: z.string() }) };

test("unconfigured adapters report unavailable without fabricating content", async () => {
  assert.equal((await new Gemini({}).generate(task, { text: "hello" }, "Extract")).status, "UNAVAILABLE");
  assert.equal((await new Backboard({}).recall("user-owned-assistant")).status, "UNAVAILABLE");
  assert.equal((await new ElevenLabs({}).transcribe(new Blob())).status, "UNAVAILABLE");
});
test("mocked Gemini call uses validated projection and requires confirmation", async () => {
  let body = "";
  const model = new Gemini({ apiKey: "test-only", model: "test-model", fetch: async (_url, init) => {
    body = String(init?.body);
    return response({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"question":"Is noon a hard deadline?"}' }] } }] });
  } });
  const result = await model.generate(task, { text: "noon Sunday", maxBudget: 123456 }, "Extract");
  assert.equal(result.status, "OK");
  assert.equal(body.includes("123456"), false);
  if (result.status === "OK") assert.equal(result.value.requiresConfirmation, true);
  assert.ok(body.includes("responseJsonSchema"));
});
test("malformed and incomplete model responses fail without echoing private input", async () => {
  for (const finishReason of ["STOP", "MAX_TOKENS", "SAFETY"]) {
    const model = new Gemini({ apiKey: "secret-key", model: "test-model", fetch: async () => response({ candidates: [{ finishReason, content: { parts: [{ text: '{"budget":"private"}' }] } }] }) });
    const result = await model.generate(task, { text: "private-input" }, "Extract");
    assert.equal(result.status, "FAILED");
    assert.equal(JSON.stringify(result).includes("private-input"), false);
  }
});
test("public explanation model receives only backend's public projection", async () => {
  let transmitted = "";
  const model = new Gemini({ apiKey: "test", model: "test", fetch: async (_url, init) => {
    transmitted = String(init?.body);
    return response({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"question":"public answer"}' }] } }] });
  } });
  const ai = createIntelligence(model, { extraction: task, clarification: task, publicExplanation: task, privateExplanation: task, comparison: task });
  await ai.explainPublic({ text: "aggregate feasibility", secretCapsule: "never transmit me" } as { text: string });
  assert.equal(transmitted.includes("never transmit me"), false);
});
test("Backboard rejects unconfirmed and non-reusable financial memory", async () => {
  let calls = 0;
  const provider = new Backboard({ apiKey: "test", fetch: async () => { calls++; return response({}); } });
  assert.equal((await provider.remember("a", "WALKABLE", false)).status, "FAILED");
  assert.equal((await provider.remember("a", "PAYMENT_AUTHORIZATION" as "QUIET", true)).status, "FAILED");
  assert.equal(calls, 0);
});
test("mocked Backboard writes approved preference and retrieves with fresh confirmation", async () => {
  let saved: unknown;
  const provider = new Backboard({ apiKey: "test", fetch: async (_url, init) => {
    if (init?.method === "POST") { saved = { id: "memory-1", ...JSON.parse(String(init.body)) }; return response(saved); }
    return response({ memories: [saved], total_count: 1 });
  } });
  const write = await provider.remember("assistant-owned-by-session", "WALKABLE", true);
  assert.equal(write.status, "OK");
  const read = await provider.recall("assistant-owned-by-session");
  assert.equal(read.status, "OK");
  if (read.status === "OK") { assert.equal(read.value[0]?.applied, false); assert.equal(read.value[0]?.requiresConfirmation, true); }
});
test("voice sends multipart audio to provider and never bypasses confirmation", async () => {
  let sent = false;
  const provider = new ElevenLabs({ apiKey: "test", model: "test", fetch: async (_url, init) => {
    assert.ok(init?.body instanceof FormData); sent = true;
    return response({ text: "I need to leave by noon", language_code: "eng" });
  } });
  const result = await provider.transcribe(new Blob(["test audio bytes"], { type: "audio/webm" }));
  assert.ok(sent); assert.equal(result.status, "OK");
  if (result.status === "OK") assert.ok(result.value.requiresConfirmation);
});
test("provider errors do not leak response bodies or credentials", async () => {
  const fetcher: Fetch = async () => new Response("sensitive response", { status: 403 });
  const result = await new Gemini({ apiKey: "secret", model: "test", fetch: fetcher }).generate(task, { text: "input" }, "Extract");
  assert.deepEqual(result, { provider: "gemini", status: "FAILED", code: "HTTP_403" });
});
test("health distinguishes an absent configuration from actual successful probes", async () => {
  assert.deepEqual(await health({ ai: undefined, mongo: async () => true, tiger: async () => { throw Error("down"); } }), { app: "UP", ai: "UNCONFIGURED", mongo: "UP", tiger: "DOWN" });
});
