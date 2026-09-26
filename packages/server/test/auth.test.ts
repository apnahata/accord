import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApi } from "../src/server.js";

test("email credentials survive sign-out and restore the same groups", async t => {
  const app = createApi();
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  t.after(async () => {
    app.state.streams.close(); app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });
  const call = async (path: string, body: unknown, cookie?: string) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { response, data: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };

  const registered = await call("/auth/register", { displayName: "Alex", email: "Alex@Example.com", password: "correct horse battery staple" });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.data.user.email, "alex@example.com");
  assert.ok(!JSON.stringify(registered.data).includes("correct horse"));
  const stored = [...app.state.users.values()][0] as any;
  assert.notEqual(stored.passwordHash, "correct horse battery staple");
  assert.ok(stored.passwordSalt);
  const invalid = await call("/auth/register", { displayName: "Bad", email: "not-an-email", password: "short" });
  assert.equal(invalid.response.status, 422);
  assert.deepEqual(invalid.data.issues[0].path, ["email"]);

  const created = await call("/rooms", { name: "Friends trip", goal: "A shared stay", displayName: "Alex" }, registered.cookie);
  assert.equal(created.response.status, 201);
  const roomId = created.data.roomId;
  const roomCookie = created.cookie!;
  assert.equal((await call("/logout", {}, roomCookie)).response.status, 200);
  assert.equal((await call("/auth/login", { email: "alex@example.com", password: "wrong-password" })).response.status, 401);

  const loggedIn = await call("/auth/login", { email: "alex@example.com", password: "correct horse battery staple" });
  assert.equal(loggedIn.response.status, 200);
  const account = await fetch(base + "/me", { headers: { cookie: loggedIn.cookie! } });
  const accountData = await account.json() as any;
  assert.equal(accountData.groups[0].roomId, roomId);
  assert.ok(!JSON.stringify(accountData).includes("passwordHash"));
  assert.equal((await call("/auth/register", { displayName: "Other", email: "ALEX@example.com", password: "another long password" })).response.status, 409);
});

test("an existing device profile can add credentials without losing its trip", async t => {
  const app = createApi();
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const created = await fetch(base + "/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Existing", goal: "Stay", displayName: "Priya" }) });
  const roomId = (await created.json() as any).roomId;
  const oldCookie = created.headers.get("set-cookie")!.split(";")[0]!;
  const claimed = await fetch(base + "/auth/register", { method: "POST", headers: { "content-type": "application/json", cookie: oldCookie }, body: JSON.stringify({ displayName: "Priya", email: "priya@example.com", password: "a secure demo password" }) });
  assert.equal(claimed.status, 201);
  const data = await claimed.json() as any;
  assert.equal(data.groups[0].roomId, roomId);
  assert.equal(app.state.sessionFromCookie(oldCookie), undefined, "claiming rotates the old device session");
});

test("production group creation requires a persistent authenticated account", async t => {
  const app = createApi({ allowAnonymousAccounts: false });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  t.after(async () => { app.state.streams.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); });
  const anonymous = await fetch(base + "/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Anonymous", goal: "Stay" }) });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json() as any).code, "ACCOUNT_REQUIRED");
  const registered = await fetch(base + "/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Alex", email: "alex-professional@example.com", password: "correct horse battery staple" }) });
  const cookie = registered.headers.get("set-cookie")!.split(";")[0]!;
  const created = await fetch(base + "/rooms", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Authenticated", goal: "Stay" }) });
  assert.equal(created.status, 201);
});
