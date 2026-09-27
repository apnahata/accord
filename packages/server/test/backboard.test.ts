import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/server.js";

function fakeBackboard() {
  let nextAssistantId = 1, nextMemoryId = 1;
  const memoriesByAssistant = new Map<string, Array<{ id: string; content: string; metadata: Record<string, unknown> }>>();
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://app.backboard.io/api", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === "POST" && path === "/assistants") return json({ assistant_id: `assistant-${nextAssistantId++}` });
    const memories = /^\/assistants\/([^/]+)\/memories/.exec(path);
    if (memories && method === "POST") {
      const assistantId = decodeURIComponent(memories[1]!);
      const list = memoriesByAssistant.get(assistantId) ?? [];
      list.push({ id: `mem-${nextMemoryId++}`, content: body.content, metadata: body.metadata });
      memoriesByAssistant.set(assistantId, list);
      return json({ ok: true });
    }
    if (memories && method === "GET") {
      const assistantId = decodeURIComponent(memories[1]!);
      const list = memoriesByAssistant.get(assistantId) ?? [];
      return json({ memories: list, total_count: list.length });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, memoriesByAssistant };
}

async function start(t: test.TestContext, options: Parameters<typeof createApi>[0] = {}) {
  const app = createApi(options);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const call = async (path: string, method = "GET", body?: unknown, cookie?: string) => {
    const response = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const created = await call("/rooms", "POST", { name: "Trip", goal: "Shared stay", displayName: "Alex" });
  return { call, cookie: created.cookie!, roomId: created.data.roomId as string };
}

test("without a Backboard API key, health/capabilities report it off and the memory routes fail closed with no network call", async t => {
  const { call, cookie, roomId } = await start(t);
  assert.equal((await call("/health")).data.backboard, "UNCONFIGURED");
  assert.equal((await call("/capabilities")).data.backboard.available, false);
  const memories = await call(`/rooms/${roomId}/me/memories`, "GET", undefined, cookie);
  assert.equal(memories.status, 503);
  assert.equal(memories.data.code, "BACKBOARD_UNAVAILABLE");
});

test("with a Backboard API key, recalling memories provisions one cached assistant, and remember is never called without an explicit apply", async t => {
  const backboard = fakeBackboard();
  const { call, cookie, roomId } = await start(t, { backboardApiKey: "test-key", backboardFetch: backboard.fetchImpl });
  assert.equal((await call("/health")).data.backboard, "CONFIGURED");
  const first = await call(`/rooms/${roomId}/me/memories`, "GET", undefined, cookie);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { source: "BACKBOARD", memories: [] });
  assert.equal(backboard.calls.filter(c => c.method === "POST" && c.path === "/assistants").length, 1);
  assert.ok(!backboard.calls.some(c => c.method === "POST" && /\/memories$/.test(c.path)), "remember() must never be called automatically");

  const second = await call(`/rooms/${roomId}/me/memories`, "GET", undefined, cookie);
  assert.equal(second.status, 200);
  assert.equal(backboard.calls.filter(c => c.method === "POST" && c.path === "/assistants").length, 1, "the assistant is provisioned once, then cached on the user record");

  // Simulate a preference this member explicitly confirmed on a previous trip.
  backboard.memoriesByAssistant.set("assistant-1", [{ id: "mem-1", content: "Prefers walkable neighborhoods", metadata: { source: "accord_explicit_confirmation", preference: "WALKABLE" } }]);
  const withMemory = await call(`/rooms/${roomId}/me/memories`, "GET", undefined, cookie);
  assert.equal(withMemory.data.memories.length, 1);
  assert.deepEqual(withMemory.data.memories[0], { id: "mem-1", label: "Prefers walkable neighborhoods", applied: false });
});

test("applying a memory requires explicit confirmation, calls Backboard's remember, and marks it applied for this trip", async t => {
  const backboard = fakeBackboard();
  const { call, cookie, roomId } = await start(t, { backboardApiKey: "test-key", backboardFetch: backboard.fetchImpl });
  await call(`/rooms/${roomId}/me/memories`, "GET", undefined, cookie); // provisions assistant-1
  backboard.memoriesByAssistant.set("assistant-1", [{ id: "mem-1", content: "Prefers walkable neighborhoods", metadata: { source: "accord_explicit_confirmation", preference: "WALKABLE" } }]);

  const missingConfirmation = await call(`/rooms/${roomId}/me/memories/mem-1/apply`, "POST", {}, cookie);
  assert.equal(missingConfirmation.status, 422);

  const applied = await call(`/rooms/${roomId}/me/memories/mem-1/apply`, "POST", { confirmed: true }, cookie);
  assert.equal(applied.status, 200);
  assert.equal(applied.data.applied, true);
  assert.ok(backboard.calls.some(c => c.method === "POST" && c.path === "/assistants/assistant-1/memories" && c.body.metadata.preference === "WALKABLE"));

  const after = await call(`/rooms/${roomId}/me/memories`, "GET", undefined, cookie);
  const original = after.data.memories.find((memory: any) => memory.id === "mem-1");
  assert.equal(original.applied, true);

  const unknown = await call(`/rooms/${roomId}/me/memories/does-not-exist/apply`, "POST", { confirmed: true }, cookie);
  assert.equal(unknown.status, 404);
});

test("creating a new memory requires explicit confirmation, calls Backboard's remember, and the memory shows up on a later recall", async t => {
  const backboard = fakeBackboard();
  const { call, cookie, roomId } = await start(t, { backboardApiKey: "test-key", backboardFetch: backboard.fetchImpl });

  const missingConfirmation = await call(`/rooms/${roomId}/me/memories`, "POST", { preference: "WALKABLE" }, cookie);
  assert.equal(missingConfirmation.status, 422);
  assert.ok(!backboard.calls.some(c => c.method === "POST" && c.path === "/assistants"), "no network call is made without confirmation");

  const invalidPreference = await call(`/rooms/${roomId}/me/memories`, "POST", { preference: "NOT_REAL", confirmed: true }, cookie);
  assert.equal(invalidPreference.status, 422);
  assert.ok(!backboard.calls.some(c => c.method === "POST" && c.path === "/assistants"), "no network call is made for an invalid preference");

  const created = await call(`/rooms/${roomId}/me/memories`, "POST", { preference: "WALKABLE", confirmed: true }, cookie);
  assert.equal(created.status, 200);
  assert.equal(created.data.source, "BACKBOARD");
  assert.equal(created.data.applied, true);
  assert.equal(created.data.label, "Prefers walkable neighborhoods");
  assert.ok(backboard.calls.some(c => c.method === "POST" && /\/memories$/.test(c.path) && c.body.metadata.preference === "WALKABLE"));

  const recalled = await call(`/rooms/${roomId}/me/memories`, "GET", undefined, cookie);
  assert.equal(recalled.status, 200);
  assert.deepEqual(recalled.data.memories, [{ id: created.data.id, label: "Prefers walkable neighborhoods", applied: true }]);
});
