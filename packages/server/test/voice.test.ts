import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/server.js";

function fakeElevenLabsFetch(transcript = "I can spend up to $350 and need to leave by noon Sunday.") {
  const calls: Array<{ hasApiKeyHeader: boolean }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ hasApiKeyHeader: Boolean(headers.get("xi-api-key")) });
    return new Response(JSON.stringify({ text: transcript, language_code: "en" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
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
  return { base, cookie: created.cookie! };
}

function audioForm() {
  const form = new FormData();
  form.set("audio", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }), "private-intake.webm");
  return form;
}

test("without an ElevenLabs key, health/capabilities report it off and transcription fails closed with no network call", async t => {
  const { base, cookie } = await start(t);
  const health = await fetch(`${base}/health`);
  assert.equal((await health.json()).elevenlabs, "UNCONFIGURED");
  const response = await fetch(`${base}/intake/transcribe`, { method: "POST", headers: { cookie }, body: audioForm() });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "ELEVENLABS_UNAVAILABLE");
});

test("an unauthenticated request is rejected before any transcription is attempted", async t => {
  const eleven = fakeElevenLabsFetch();
  const { base } = await start(t, { elevenLabsApiKey: "test-key", elevenLabsFetch: eleven.fetchImpl });
  const response = await fetch(`${base}/intake/transcribe`, { method: "POST", body: audioForm() });
  assert.equal(response.status, 401);
  assert.equal(eleven.calls.length, 0);
});

test("with an ElevenLabs key, uploaded audio is transcribed and the private transcript is returned for the same confirmation intake pipeline", async t => {
  const eleven = fakeElevenLabsFetch("I can spend up to $350 and need to leave by noon Sunday.");
  const { base, cookie } = await start(t, { elevenLabsApiKey: "test-key", elevenLabsFetch: eleven.fetchImpl });
  assert.equal((await (await fetch(`${base}/health`)).json()).elevenlabs, "CONFIGURED");
  const response = await fetch(`${base}/intake/transcribe`, { method: "POST", headers: { cookie }, body: audioForm() });
  assert.equal(response.status, 200);
  const data = await response.json() as { transcript: string };
  assert.equal(data.transcript, "I can spend up to $350 and need to leave by noon Sunday.");
  assert.equal(eleven.calls.length, 1);
  assert.equal(eleven.calls[0]!.hasApiKeyHeader, true);
});

test("a non-multipart body or a missing audio field is rejected before calling ElevenLabs", async t => {
  const eleven = fakeElevenLabsFetch();
  const { base, cookie } = await start(t, { elevenLabsApiKey: "test-key", elevenLabsFetch: eleven.fetchImpl });
  const wrongType = await fetch(`${base}/intake/transcribe`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(wrongType.status, 422);
  const emptyForm = new FormData();
  const missingField = await fetch(`${base}/intake/transcribe`, { method: "POST", headers: { cookie }, body: emptyForm });
  assert.equal(missingField.status, 422);
  assert.equal(eleven.calls.length, 0);
});
