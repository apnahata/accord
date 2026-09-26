import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { decodeSse, matches } from "../sse.mjs";
import { verifyDeployment, validateConfig } from "../verify-deployment.mjs";

const config = () => ({
  baseUrl: "http://127.0.0.1:3000", timeoutMs: 1000,
  sessions: ["alex", "priya", "jordan", "mateo"].map(name => ({ name, eventsPath: "/events", headers: { Cookie: `session=${name}` } })),
  expected: { event: "update", field: "type", value: "PROPOSAL_STALE" },
  trigger: { path: "/mutate", method: "POST", headers: { Authorization: "Bearer test-admin" }, body: { test: true } },
});

test("SSE decodes multiline fields, Unicode, comments and CRLF across byte boundaries", async () => {
  const raw = ': heartbeat\r\nid: real-id\r\nevent: update\r\ndata: {"type":\r\ndata: "café"}\r\n\r\n';
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const frames = [];
  for await (const frame of decodeSse(stream)) frames.push(frame);
  assert.deepEqual(frames, [{ id: "real-id", event: "update", data: '{"type":\n"café"}' }]);
  assert.ok(matches(frames[0], { field: "type", value: "café" }));
  assert.ok(!matches(frames[0], { field: "constructor", value: "café" }));
});

test("SSE stops oversized and incomplete events without producing a match", async () => {
  const stream = new Response("data: " + "a".repeat(100)).body;
  await assert.rejects(async () => { for await (const _ of decodeSse(stream, { maxFrameBytes: 20 })) {} }, /SSE_FRAME_TOO_LARGE/);
  const frames = [];
  for await (const frame of decodeSse(new Response("event: update\ndata: unfinished").body)) frames.push(frame);
  assert.deepEqual(frames, []);
});

test("event correlation excludes an unrelated stale proposal", () => {
  const expected = { event: "update", field: "type", value: "PROPOSAL_STALE", where: { "proposal.id": "current" } };
  assert.equal(matches({ event: "update", data: '{"type":"PROPOSAL_STALE","proposal":{"id":"old"}}' }, expected), false);
  assert.equal(matches({ event: "update", data: '{"type":"PROPOSAL_STALE","proposal":{"id":"current"}}' }, expected), true);
});

test("config requires four distinct authenticated sessions and a same-origin HTTPS target", () => {
  const c = config();
  assert.equal(validateConfig(c).hostname, "127.0.0.1");
  assert.throws(() => validateConfig({ ...c, baseUrl: "http://example.com" }), /HTTPS_REQUIRED/);
  assert.throws(() => validateConfig({ ...c, baseUrl: "https://secret:token@example.com" }), /INVALID_BASE_URL/);
  assert.throws(() => validateConfig({ ...c, sessions: c.sessions.slice(1) }), /FOUR_SESSIONS_REQUIRED/);
  assert.throws(() => validateConfig({ ...c, sessions: c.sessions.map(s => ({ ...s, headers: { cookie: "same" } })) }), /DISTINCT_CREDENTIALS_REQUIRED/);
  assert.throws(() => validateConfig({ ...c, trigger: { ...c.trigger, path: "//attacker.example/mutate" } }), /RELATIVE_PATH_REQUIRED/);
  assert.throws(() => validateConfig({ ...c, sessions: c.sessions.map(s => ({ ...s, eventsPath: "/\\attacker.example" })) }), /SAME_ORIGIN_REQUIRED/);
});

async function serverFixture(t, options = {}) {
  const clients = new Set();
  let triggers = 0;
  const server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ app: "UP", mongo: options.mongo ?? "UP", tiger: "UNCONFIGURED", privateSecret: "never-copy-health-body" }));
    } else if (request.url === "/events") {
      if (!request.headers.cookie && !options.allowAnonymous) { response.writeHead(401).end(); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('event: resync\ndata: {}\n\n');
      clients.add(response);
      response.once("close", () => clients.delete(response));
    } else if (request.url === "/mutate") {
      triggers++;
      assert.equal(request.headers.authorization, "Bearer test-admin");
      let index = 0;
      for (const client of clients) {
        if (index++ === 3 && options.dropFourth) continue;
        client.write('id: actual-local-test-event\nevent: update\ndata: {"type":"PROPOSAL_STALE","sensitive":"never-copy-event-body"}\n\n');
      }
      response.writeHead(200).end("{}");
    } else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const client of clients) client.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const c = config(); c.baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { config: c, triggers: () => triggers };
}

test("real local HTTP propagation reaches four sessions; proof excludes secrets and payloads", async t => {
  const fixture = await serverFixture(t);
  const report = await verifyDeployment(fixture.config, { allowTrigger: true });
  assert.equal(report.status, "PASSED");
  assert.equal(report.sessions.length, 4);
  assert.equal(report.unauthenticatedRejected, true);
  assert.equal(fixture.triggers(), 1);
  assert.equal(report.health.tiger, "UNCONFIGURED");
  const text = JSON.stringify(report);
  for (const secret of ["session=", "test-admin", "never-copy", "actual-local-test-event"]) assert.ok(!text.includes(secret));
});

test("no explicit trigger flag means no mutation request", async t => {
  const fixture = await serverFixture(t);
  const report = await verifyDeployment(fixture.config);
  assert.equal(report.status, "FAILED");
  assert.equal(report.failure, "TRIGGER_FLAG_REQUIRED");
  assert.equal(fixture.triggers(), 0);
});

test("missing fourth update is failure, never a synthetic success", async t => {
  const fixture = await serverFixture(t, { dropFourth: true });
  const report = await verifyDeployment(fixture.config, { allowTrigger: true });
  assert.equal(report.status, "FAILED");
  assert.equal(report.sessions.length, 3);
});

test("anonymous stream access fails verification before any mutation", async t => {
  const fixture = await serverFixture(t, { allowAnonymous: true });
  const report = await verifyDeployment(fixture.config, { allowTrigger: true });
  assert.equal(report.failure, "UNAUTHENTICATED_STREAM_ACCEPTED");
  assert.equal(fixture.triggers(), 0);
});

test("Mongo failure blocks readiness regardless of optional integrations", async t => {
  const fixture = await serverFixture(t, { mongo: "DOWN" });
  const report = await verifyDeployment(fixture.config, { allowTrigger: true });
  assert.equal(report.failure, "CORE_NOT_READY");
  assert.equal(fixture.triggers(), 0);
});
