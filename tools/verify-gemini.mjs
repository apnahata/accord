import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createApi } from "../packages/server/src/server.ts";

if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_MODEL) {
  process.stderr.write("GEMINI_NOT_CONFIGURED: set GEMINI_API_KEY and GEMINI_MODEL in the gitignored root .env.\n");
  process.exit(1);
}

const app = createApi();
app.server.listen(0, "127.0.0.1");
await once(app.server, "listening");
const base = "http://127.0.0.1:" + app.server.address().port + "/api";

try {
  const registeredResponse = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Test member", email: "gemini-verifier@example.test", password: "gemini verifier password" }),
  });
  const cookie = registeredResponse.headers.get("set-cookie")?.split(";")[0];
  if (registeredResponse.status !== 201 || !cookie) throw new Error("TEST_ACCOUNT_FAILED");
  const createdResponse = await fetch(base + "/rooms", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Live Gemini verification", goal: "A shared stay in Miami" }),
  });
  const created = await createdResponse.json();
  const roomCookie = createdResponse.headers.get("set-cookie")?.split(";")[0] ?? cookie;
  if (createdResponse.status !== 201) throw new Error(`TEST_ROOM_FAILED:${createdResponse.status}:${created.code ?? "UNKNOWN"}`);

  const route = base + "/rooms/" + created.roomId;
  const messages = [{ role: "user", content: "My personal maximum is $350. I must check out by Sunday, March 14, 2027 at noon Eastern Time. I would prefer a walkable neighborhood." }];
  const clarificationQuestions = [];
  let draft, httpStatus;
  for (let turn = 0; turn < 4; turn++) {
    const response = await fetch(route + "/me/intake/extract", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: roomCookie },
      body: JSON.stringify({ messages }),
    });
    httpStatus = response.status;
    draft = await response.json();
    if (httpStatus !== 200 || draft.stage !== "CLARIFYING" || turn === 3) break;
    clarificationQuestions.push(draft.reply);
    messages.push({ role: "assistant", content: draft.reply });
    messages.push({ role: "user", content: "To clarify: $350 is a firm personal maximum. Checkout must be no later than Sunday, March 14, 2027 at 12:00 PM in America/New_York. Walkability is only a preference. I do not require a full cash refund or step-free access." });
  }
  const savedResponse = await fetch(route + "/me/constraints", { headers: { cookie: roomCookie } });
  const saved = await savedResponse.json();
  const proof = {
    observedAt: new Date().toISOString(),
    scenario: "Synthetic private stay intake through the local Accord API",
    provider: "gemini",
    model: process.env.GEMINI_MODEL,
    route: "/api/rooms/:id/me/intake/extract",
    httpStatus,
    stage: draft?.stage,
    clarificationQuestions,
    requiresConfirmation: draft?.requiresConfirmation === true,
    maxContributionCents: draft?.constraints?.maxContributionCents,
    latestCheckOutAt: draft?.constraints?.latestCheckOutAt,
    softPreference: draft?.constraints?.softPreference,
    savedBeforeConfirmation: saved.constraints !== null,
    errorCode: draft?.code,
  };
  const valid = proof.httpStatus === 200 && proof.stage === "REVIEW" && proof.requiresConfirmation
    && proof.maxContributionCents === 35000 && proof.latestCheckOutAt === "2027-03-14T16:00:00.000Z"
    && proof.savedBeforeConfirmation === false;
  process.stdout.write(JSON.stringify({ ...proof, verified: valid }) + "\n");
  if (!valid) process.exitCode = 1;
  else if (process.argv.includes("--record")) {
    await mkdir("sponsor-evidence", { recursive: true });
    await writeFile("sponsor-evidence/gemini-live-smoke.json", JSON.stringify({ ...proof, verified: true }, null, 2) + "\n");
  }
} finally {
  app.state.streams.close();
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
}
