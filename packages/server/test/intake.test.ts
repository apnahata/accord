import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { addDays, localDay } from "@accord/domain";
import { createApi } from "../src/server.js";

const modelResponse = (value: unknown) => new Response(JSON.stringify({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
}), { headers: { "content-type": "application/json" } });

test("private multi-turn AI intake asks a functional question and never saves before confirmation", async t => {
  const modelInputs: unknown[] = [];
  const app = createApi({
    geminiApiKey: "test-only",
    geminiModel: "test-model",
    geminiFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      modelInputs.push(body.contents[0].parts[0].text);
      return modelResponse(modelInputs.length === 1 ? {
        proposed: { maxContributionCents: 35000 },
        privacy: { reasonPrivate: true },
        unsupportedHardRequirements: [],
        ambiguities: [{ field: "latestCheckOutAt", question: "Which calendar date is the Sunday you need to leave by noon?" }],
      } : {
        proposed: { maxContributionCents: 35000, latestCheckOutAt: "2027-03-14T12:00:00-05:00" },
        privacy: { reasonPrivate: true },
        unsupportedHardRequirements: [],
        ambiguities: [],
      });
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.state.streams.close();
    app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  async function call(path: string, method = "GET", body?: unknown, cookie?: string) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const created = await call("/rooms", "POST", { name: "Trip", goal: "Shared stay", displayName: "Alex" });
  const roomPath = `/rooms/${created.data.roomId}`;
  const cookie = created.cookie!;
  const first = [{ role: "user", content: "I can spend $350. I need to leave by noon Sunday but don't want to explain why." }];
  const asked = await call(roomPath + "/me/intake/extract", "POST", { messages: first }, cookie);
  assert.equal(asked.status, 200);
  assert.equal(asked.data.stage, "CLARIFYING");
  assert.match(asked.data.reply, /which calendar date/i);
  assert.equal(asked.data.constraints, undefined);
  const second = [...first, { role: "assistant", content: asked.data.reply }, { role: "user", content: "Sunday, March 14, 2027." }];
  const drafted = await call(roomPath + "/me/intake/extract", "POST", { messages: second }, cookie);
  assert.equal(drafted.status, 200);
  assert.equal(drafted.data.stage, "REVIEW");
  assert.equal(drafted.data.requiresConfirmation, true);
  assert.equal(drafted.data.constraints.latestCheckOutAt, "2027-03-14T16:00:00.000Z");
  assert.equal((await call(roomPath + "/me/constraints", "GET", undefined, cookie)).data.constraints, null);
  assert.equal(modelInputs.length, 2);
  assert.match(String(modelInputs[1]), /Sunday, March 14, 2027/);
  assert.doesNotMatch(String(modelInputs[0]), /March 10–14, 2027/);
  const confirmed = await call(roomPath + "/me/constraints", "POST", { ...drafted.data.constraints, confirmed: true }, cookie);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.constraints.maxContributionCents, 35000);
  assert.ok(!JSON.stringify((await call(roomPath, "GET", undefined, cookie)).data).includes("35000"));
});

test("while a trip is still being planned, the intake asks for dates and picks up trip length and departure", async t => {
  const day = (offset: number) => addDays(localDay(new Date().toISOString()), offset);
  const prompts: string[] = [];
  const app = createApi({
    geminiApiKey: "test-only",
    geminiModel: "test-model",
    geminiFetch: async (_url, init) => {
      prompts.push(JSON.stringify(JSON.parse(String(init?.body))));
      return modelResponse(prompts.length === 1
        ? { proposed: { maxContributionCents: 50000, tripStyles: ["BEACH"] }, privacy: { reasonPrivate: false }, unsupportedHardRequirements: [], ambiguities: [] }
        : { proposed: { maxContributionCents: 50000, tripStyles: ["BEACH"], availability: [{ from: day(40), to: day(400) }], nights: 4, leavingFrom: "Boston" },
          privacy: { reasonPrivate: false }, unsupportedHardRequirements: [], ambiguities: [] });
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const created = await fetch(base + "/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Trip", displayName: "Alex", plan: {}, rehearsal: true }) });
  const { roomId } = await created.json() as any;
  const extract = async (messages: unknown[]) => (await fetch(`${base}/rooms/${roomId}/me/intake/extract`, {
    method: "POST", headers: { "content-type": "application/json", cookie: created.headers.get("set-cookie")!.split(";")[0]! }, body: JSON.stringify({ messages }),
  })).json() as Promise<any>;

  const first = [{ role: "user", content: "Up to $500, and I'd love a beach." }];
  const asked = await extract(first);
  assert.equal(asked.stage, "CLARIFYING");
  assert.match(asked.reply, /When could you travel/);
  assert.match(prompts[0]!, /trip length/);
  const drafted = await extract([...first, { role: "assistant", content: asked.reply }, { role: "user", content: "Any time after the 40th day from now, about 4 nights, from Boston." }]);
  assert.equal(drafted.stage, "REVIEW");
  assert.deepEqual(drafted.constraints.availability, [{ from: day(40), to: day(180) }], "dates past six months are trimmed");
  assert.equal(drafted.constraints.nights, 4);
  assert.equal(drafted.constraints.leavingFrom, "Boston");
});

test("questions about unmentioned fields and uncheckable requirements do not block the draft", async t => {
  const app = createApi({
    geminiApiKey: "test-only",
    geminiModel: "test-model",
    geminiFetch: async () => modelResponse({
      proposed: { maxContributionCents: 40000, requiresFullCashRefund: true },
      privacy: { reasonPrivate: false },
      unsupportedHardRequirements: [{ rawText: "No red-eye flights", reason: "Flights are not part of a stay." }],
      ambiguities: [{ field: "latestCheckOutAt", question: "What is the latest checkout time you need?" }],
    }),
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const created = await fetch(base + "/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Trip", goal: "Stay", displayName: "Alex" }) });
  const { roomId } = await created.json() as any;
  const response = await fetch(`${base}/rooms/${roomId}/me/intake/extract`, {
    method: "POST", headers: { "content-type": "application/json", cookie: created.headers.get("set-cookie")!.split(";")[0]! },
    body: JSON.stringify({ messages: [{ role: "user", content: "I can pay at most $400, I need a full refund, and no red-eye flights." }] }),
  });
  const data = await response.json() as any;
  assert.equal(data.stage, "REVIEW");
  assert.equal(data.constraints.maxContributionCents, 40000);
  assert.equal(data.constraints.requiresFullCashRefund, true);
  assert.deepEqual(data.followUps, ["What is the latest checkout time you need?"]);
  assert.deepEqual(data.notChecked, ["No red-eye flights"]);
});
