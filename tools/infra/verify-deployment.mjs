import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { decodeSse, matches } from "./sse.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

export function validateConfig(config) {
  const base = new URL(config.baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("INVALID_BASE_URL");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) throw new Error("HTTPS_REQUIRED");
  if (!Array.isArray(config.sessions) || config.sessions.length !== 4) throw new Error("FOUR_SESSIONS_REQUIRED");
  const authHashes = new Set();
  const names = new Set();
  for (const session of config.sessions) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(session.name) || names.has(session.name)) throw new Error("UNIQUE_SESSION_NAMES_REQUIRED");
    names.add(session.name);
    const headers = new Headers(session.headers);
    const cookie = headers.get("cookie"), authorization = headers.get("authorization");
    if (!cookie && !authorization) throw new Error("AUTHENTICATED_SESSIONS_REQUIRED");
    authHashes.add(hash(JSON.stringify([cookie, authorization])));
    scopedUrl(base, session.eventsPath);
  }
  if (authHashes.size !== 4) throw new Error("DISTINCT_CREDENTIALS_REQUIRED");
  scopedUrl(base, config.healthPath ?? "/api/health");
  if (config.expected?.field && !/^[a-zA-Z0-9_.]{1,100}$/.test(config.expected.field)) throw new Error("INVALID_MATCH_FIELD");
  if (!config.expected || (!config.expected.event && !config.expected.field)) throw new Error("EXPECTED_EVENT_REQUIRED");
  if (config.expected.field && !["string", "number", "boolean"].includes(typeof config.expected.value)) throw new Error("EXPECTED_VALUE_REQUIRED");
  if (config.expected.event && !/^[a-zA-Z0-9_-]{1,80}$/.test(config.expected.event)) throw new Error("INVALID_EVENT_NAME");
  if (config.expected.where !== undefined) {
    if (!config.expected.where || typeof config.expected.where !== "object" || Array.isArray(config.expected.where)) throw new Error("INVALID_MATCH_CONDITIONS");
    for (const [field, value] of Object.entries(config.expected.where)) {
      if (!/^[a-zA-Z0-9_.]{1,100}$/.test(field) || !["string", "number", "boolean"].includes(typeof value)) throw new Error("INVALID_MATCH_CONDITIONS");
    }
  }
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 120_000)) throw new Error("INVALID_TIMEOUT");
  if (config.trigger) {
    scopedUrl(base, config.trigger.path);
    if (config.trigger.method !== "POST") throw new Error("TRIGGER_MUST_BE_POST");
  }
  return base;
}

function scopedUrl(base, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("RELATIVE_PATH_REQUIRED");
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.hash || url.username || url.password) throw new Error("SAME_ORIGIN_REQUIRED");
  return url;
}

/** Real HTTP requests only. A trigger is sent only with explicit CLI --trigger. */
export async function verifyDeployment(config, { allowTrigger = false, fetcher = fetch } = {}) {
  const base = validateConfig(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
  const report = {
    formatVersion: 1, kind: "FOUR_SESSION_HTTP_SSE_CHECK", startedAt: new Date().toISOString(),
    origin: base.origin, status: "FAILED", health: {}, unauthenticatedRejected: false,
    triggerSent: false, sessions: [],
    limitations: ["HTTP clients, not browser UI proof", "Distinct credentials do not independently prove distinct backend member identities", "Does not prove private-channel isolation, consent invalidation, or payment execution"],
  };
  const openResponses = [];
  const request = (url, options = {}) => fetcher(url, { ...options, redirect: "error", signal: controller.signal });
  try {
    const health = await request(scopedUrl(base, config.healthPath ?? "/api/health"));
    if (!health.ok) throw new Error("HEALTH_HTTP_FAILURE");
    const healthBody = await health.text();
    if (healthBody.length > 16_384) throw new Error("HEALTH_RESPONSE_TOO_LARGE");
    const payload = JSON.parse(healthBody);
    // Allowlist status labels; never retain arbitrary health response fields.
    for (const name of ["app", "mongo", "ai", "tiger", "solana", "backboard", "elevenlabs"]) {
      report.health[name] = ["UP", "DOWN", "UNCONFIGURED", "NOT_CONFIGURED"].includes(payload[name]) ? payload[name] : "UNKNOWN";
    }
    if (report.health.app !== "UP" || report.health.mongo !== "UP") throw new Error("CORE_NOT_READY");
    const anonymous = await request(scopedUrl(base, config.sessions[0].eventsPath));
    report.unauthenticatedRejected = [401, 403].includes(anonymous.status);
    await anonymous.body?.cancel();
    if (!report.unauthenticatedRejected) throw new Error("UNAUTHENTICATED_STREAM_ACCEPTED");

    // Open all streams before triggering so a fast mutation cannot race subscription setup.
    const results = await Promise.allSettled(config.sessions.map(async session => {
      const response = await request(scopedUrl(base, session.eventsPath), { headers: session.headers });
      openResponses.push(response);
      if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("STREAM_UNAVAILABLE");
      return { session, response };
    }));
    if (results.some(result => result.status !== "fulfilled")) throw new Error("STREAM_UNAVAILABLE");
    const streams = results.map(result => result.value);

    // Start draining now, but require matches received after the measurement boundary.
    let measuring = !config.trigger;
    const observations = streams.map(async ({ session, response }) => {
      for await (const frame of decodeSse(response.body)) {
        if (measuring && matches(frame, config.expected)) {
          return { name: session.name, observedAt: new Date().toISOString(), event: frame.event, eventIdSha256: frame.id ? hash(frame.id) : null, matched: true };
        }
      }
      throw new Error("STREAM_CLOSED_BEFORE_EXPECTED_EVENT");
    });
    // Attach rejection handling before a trigger request can fail or time out.
    const completed = Promise.allSettled(observations);
    if (config.trigger) {
      if (!allowTrigger) throw new Error("TRIGGER_FLAG_REQUIRED");
      measuring = true;
      report.triggerSent = true;
      const response = await request(scopedUrl(base, config.trigger.path), {
        method: "POST", headers: { ...config.trigger.headers, "content-type": "application/json" },
        body: JSON.stringify(config.trigger.body),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("TRIGGER_REJECTED");
    }
    const observed = await completed;
    report.sessions = observed.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    if (report.sessions.length !== 4) throw new Error("FOUR_SESSION_PROPAGATION_NOT_OBSERVED");
    report.status = "PASSED";
  } catch (error) {
    // Only application error codes; never log exception messages from fetch/provider bodies.
    const code = error instanceof Error ? error.message : "";
    report.failure = /^[A-Z_]{3,80}$/.test(code) ? code : "REQUEST_FAILED_OR_TIMED_OUT";
  } finally {
    controller.abort(); clearTimeout(timer);
    await Promise.allSettled(openResponses.filter(response => !response.body?.locked).map(response => response.body?.cancel()));
  }
  return { ...report, finishedAt: new Date().toISOString() };
}

async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config"), outputIndex = args.indexOf("--output");
  if (configIndex < 0 || !args[configIndex + 1] || outputIndex < 0 || !args[outputIndex + 1]) {
    console.error("Usage: node tools/infra/verify-deployment.mjs --config /private/config.json --output /private/proof.json [--trigger]");
    process.exitCode = 2; return;
  }
  try {
    const config = JSON.parse(await readFile(args[configIndex + 1], "utf8"));
    const report = await verifyDeployment(config, { allowTrigger: args.includes("--trigger") });
    await writeFile(args[outputIndex + 1], JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`${report.status}: ${report.sessions.length}/4 HTTP sessions observed the configured event.`);
    process.exitCode = report.status === "PASSED" ? 0 : 1;
  } catch { console.error("Verification could not start or write a new report. Check config and output path."); process.exitCode = 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
