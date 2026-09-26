import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { RoomStreams } from "../src/realtime.js";

test("real HTTP SSE connections isolate private recipients and honor session revocation", { timeout: 10_000 }, async t => {
  const sessions = new Map([["alex-session", "alex"], ["priya-session", "priya"]]);
  const streams = new RoomStreams(z.strictObject({ state: z.string() }), z.strictObject({ reason: z.string() }), async (request, roomId) => {
    const memberId = sessions.get(request.headers.cookie ?? "");
    return memberId && roomId === "room-1" ? { memberId, roomId } : null;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    void streams.connect(request, response, url.pathname.includes("room-2") ? "room-2" : "room-1", url.pathname.endsWith("/private") ? "private" : "public");
  });
  const controllers: AbortController[] = [];
  t.after(() => { controllers.forEach(controller => controller.abort()); streams.close(); server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const info = server.address(); assert.ok(info && typeof info !== "string");
  const root = `http://127.0.0.1:${info.port}`;
  async function connect(path: string, cookie: string) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(root + path, { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: resync/);
    return reader;
  }
  const alex = await connect("/room-1/private?memberId=priya", "alex-session");
  const priya = await connect("/room-1/private?memberId=alex", "priya-session");
  const groupA = await connect("/room-1/public", "alex-session");
  const groupB = await connect("/room-1/public", "priya-session");
  streams.publishPrivate("room-1", "alex", "e1", { reason: "Own budget check failed" });
  streams.publishPrivate("room-1", "priya", "e2", { reason: "Fresh consent required" });
  streams.publishPublic("room-1", "e3", { state: "STALE" });
  assert.match(new TextDecoder().decode((await alex.read()).value), /Own budget check failed/);
  const priyaMessage = new TextDecoder().decode((await priya.read()).value);
  assert.match(priyaMessage, /Fresh consent required/); assert.doesNotMatch(priyaMessage, /budget/);
  for (const reader of [groupA, groupB]) {
    const message = new TextDecoder().decode((await reader.read()).value);
    assert.match(message, /STALE/); assert.doesNotMatch(message, /budget|reason/);
  }
  assert.throws(() => streams.publishPublic("room-1", "e4", { state: "STALE", privateCap: 35000 } as { state: string }));
  sessions.delete("alex-session");
  streams.publishPrivate("room-1", "alex", "e5", { reason: "must not arrive" });
  assert.equal((await alex.read()).done, true);
  assert.equal((await fetch(root + "/room-2/private", { headers: { cookie: "priya-session" } })).status, 401);
  assert.equal((await fetch(root + "/room-1/private")).status, 401);
});
