import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { ConstraintsSchema, ExtractionSchema, MerchantMutationSchema, TripSchema, equalShares } from "@accord/domain";
import { Gemini } from "../../integrations/src/ai.js";
import type { Fetch } from "../../integrations/src/result.js";
import { AccordState, AppError } from "./state.js";
import { MongoPersistence } from "./persistence.js";
import { GoogleHotels, LiteApi } from "./stays.js";
import { configuredSolana } from "./solana-config.js";
import type { SolanaCommitments } from "../../integrations/src/solana.js";
import { normalizeModelCheckout } from "./model-time.js";
import { triageExtraction } from "./intake.js";
import { explainPrivate, explainPublic, publicOffersFingerprint } from "./explanations.js";

const name = z.string().trim().min(1).max(100);
const roomIdPattern = /^\/api\/rooms\/([^/]+)(?:\/(.*))?$/;
const proposalPattern = /^\/api\/proposals\/([^/]+)\/(public|me|me\/explanation|consent|execute)$/;

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}
async function readJson(request: IncomingMessage, max = 32_000): Promise<unknown> {
  let size = 0, parts: Buffer[] = [];
  for await (const chunk of request) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > max) throw new AppError(413, "REQUEST_TOO_LARGE");
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { throw new AppError(400, "INVALID_JSON"); }
}
function sessionCookie(value: string, request: IncomingMessage) {
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `accord_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`;
}
function roomParam(raw: string) {
  try { return decodeURIComponent(raw); } catch { throw new AppError(400, "INVALID_ID"); }
}
function sessionRequired(state: AccordState, request: IncomingMessage) {
  const session = state.sessionFromCookie(request.headers.cookie);
  if (!session) throw new AppError(401, "SESSION_REQUIRED");
  return session;
}

async function serveFrontend(path: string, response: ServerResponse) {
  const root = resolve(process.cwd(), "frontend/dist");
  const asset = path.startsWith("/assets/") || path === "/favicon.svg";
  const file = asset ? resolve(root, `.${path}`) : resolve(root, "index.html");
  if (!file.startsWith(`${root}/`) && file !== `${root}/index.html`) throw new AppError(404, "NOT_FOUND");
  try {
    const bytes = await readFile(file);
    const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
    response.writeHead(200, { "content-type": type, "cache-control": asset ? "public, max-age=31536000, immutable" : "no-cache", "x-content-type-options": "nosniff" });
    response.end(bytes);
  } catch { throw new AppError(404, "FRONTEND_NOT_BUILT"); }
}

export function createApi(options: { geminiApiKey?: string; geminiModel?: string; geminiFetch?: Fetch; persistence?: MongoPersistence;
  liteApiKey?: string; serpApiKey?: string; staysFetch?: Fetch; solana?: SolanaCommitments } = {}) {
  const persistence = options.persistence;
  const model = new Gemini({ apiKey: options.geminiApiKey ?? process.env.GEMINI_API_KEY, model: options.geminiModel ?? process.env.GEMINI_MODEL, fetch: options.geminiFetch });
  const aiConfigured = Boolean((options.geminiApiKey ?? process.env.GEMINI_API_KEY) && (options.geminiModel ?? process.env.GEMINI_MODEL));
  const liteApiKey = options.liteApiKey ?? process.env.LITEAPI_KEY, serpApiKey = options.serpApiKey ?? process.env.SERPAPI_KEY;
  const providers = {
    ...(liteApiKey ? { liteApi: new LiteApi(liteApiKey, options.staysFetch) } : {}),
    ...(serpApiKey ? { google: new GoogleHotels(serpApiKey, options.staysFetch) } : {}),
    ...(options.solana ? { solana: options.solana } : {}),
    ...(aiConfigured ? { summarize: async (facts: unknown) => {
      const result = await model.generate({ input: z.unknown(), output: z.object({ summary: z.string().max(400) }).strict() }, facts,
        "Write one or two plain sentences (max 45 words) telling a group of friends what this stay is like, using only the supplied public listing facts. No names of group members, no budgets, no invented facts, no marketing language.");
      return result.status === "OK" ? result.value.data.summary : undefined;
    } } : {}),
  };
  let state = new AccordState(persistence, providers);
  const server = createServer(async (request, response) => {
    // Nothing is acknowledged to a client until the changes it caused are durable.
    const send = async (status: number, body: unknown) => { await state.flush(); json(response, status, body); };
    try {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (method === "GET" && path === "/api/health") {
        await send(200, { app: "UP", mongo: persistence ? (await persistence.ping() ? "UP" : "DOWN") : "UNCONFIGURED", ai: aiConfigured ? "DOWN" : "UNCONFIGURED", liteapi: liteApiKey ? "CONFIGURED" : "UNCONFIGURED", googleHotels: serpApiKey ? "CONFIGURED" : "UNCONFIGURED", tiger: "UNCONFIGURED", solana: options.solana ? (await options.solana.operatorReady() ? "UP" : "DOWN") : "UNCONFIGURED", backboard: "UNCONFIGURED", elevenlabs: "UNCONFIGURED" }); return;
      }
      if (method === "GET" && path === "/api/capabilities") {
        await send(200, { ai: { available: aiConfigured }, elevenLabs: { available: false }, backboard: { available: false }, tiger: { available: false } }); return;
      }
      if (method === "POST" && path === "/api/rooms") {
        const input = z.object({ name, goal: z.string().trim().max(500).optional(), displayName: z.string().trim().min(1).max(60), trip: TripSchema.optional() }).strict().parse(await readJson(request));
        if (input.trip && Date.parse(input.trip.checkIn) < Date.now() - 86_400_000) throw new AppError(422, "TRIP_IN_PAST");
        const goal = input.goal || (input.trip ? `A shared stay in ${input.trip.destination} for ${input.trip.guests}, ${input.trip.checkIn} to ${input.trip.checkOut}.` : "");
        if (!goal) throw new AppError(422, "VALIDATION_FAILED");
        const result = state.createRoom(input.name, goal, input.displayName, input.trip);
        response.setHeader("set-cookie", sessionCookie(result.sessionToken, request));
        await send(201, { roomId: result.roomId, inviteToken: result.inviteToken }); return;
      }
      const invitePreview = /^\/api\/invites\/([^/]+)$/.exec(path);
      if (method === "GET" && invitePreview) { await send(200, state.previewInvite(roomParam(invitePreview[1]!))); return; }
      const inviteJoin = /^\/api\/invites\/([^/]+)\/join$/.exec(path);
      if (method === "POST" && inviteJoin) {
        const input = z.object({ displayName: z.string().trim().min(1).max(60) }).strict().parse(await readJson(request));
        const result = state.join(roomParam(inviteJoin[1]!), input.displayName);
        response.setHeader("set-cookie", sessionCookie(result.sessionToken, request));
        await send(201, { roomId: result.roomId }); return;
      }
      const roomMatch = roomIdPattern.exec(path);
      if (roomMatch) {
        const roomId = roomParam(roomMatch[1]!);
        const route = roomMatch[2] ?? "";
        const session = sessionRequired(state, request);
        const { room, member } = state.requireRoom(roomId, session);
        if (route === "" && method === "GET") { await send(200, state.roomDTO(room, member.id)); return; }
        const removeMatch = /^members\/([^/]+)$/.exec(route);
        if (removeMatch && method === "DELETE") {
          state.removeMember(room, member, roomParam(removeMatch[1]!));
          await send(200, state.roomDTO(room, member.id)); return;
        }
        if (route === "invites" && method === "POST") { await send(200, { inviteToken: room.inviteToken }); return; }
        if (route === "me/leave" && method === "POST") {
          state.leave(room, member);
          response.setHeader("set-cookie", "accord_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
          await send(200, { left: true }); return;
        }
        if (route === "me/constraints" && method === "GET") { await send(200, { displayName: member.displayName, constraints: member.constraints, confirmedAt: member.confirmedAt }); return; }
        if (route === "me/constraints" && method === "POST") {
          const input = z.object({ confirmed: z.literal(true) }).extend(ConstraintsSchema.shape).strict().parse(await readJson(request));
          const { confirmed: _confirmed, ...fields } = input;
          state.confirmConstraints(room, member, ConstraintsSchema.parse(fields));
          await send(200, { displayName: member.displayName, constraints: member.constraints, confirmedAt: member.confirmedAt }); return;
        }
        if (route === "me/intake/extract" && method === "POST") {
          const message = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(1000) }).strict();
          const { messages } = z.object({ messages: z.array(message).min(1).max(24) }).strict().parse(await readJson(request));
          if (messages.length % 2 !== 1 || messages.some((entry, index) => entry.role !== (index % 2 === 0 ? "user" : "assistant"))) throw new AppError(422, "INVALID_CONVERSATION");
          if (!aiConfigured) throw new AppError(503, "AI_UNAVAILABLE");
          const result = await model.generate({ input: z.object({ roomGoal: z.string(), timeZone: z.string(), messages: z.array(message) }).strict(), output: ExtractionSchema },
            { roomGoal: room.goal, timeZone: "America/New_York", messages },
            "Read the full private stay conversation. Extract an EXPLICIT personal spending maximum into maxContributionCents: $350 means 35000 cents; never omit an explicit maximum and never invent a missing one. The supported hard fields are maximum contribution, latest checkout date/time, full cash refund, and verified step-free access. A stated checkout date/time belongs in latestCheckOutAt. A walkable/quiet/near-activities/low-price wish is a soft preference, not an unsupported hard requirement. Only list a hard requirement as unsupported when none of the supported fields can represent it. Ask one concise functional clarification only when a stated requirement is genuinely ambiguous. Resolve relative dates only from supplied dates; otherwise ask for the calendar date. Express latestCheckOutAt as the requested checkout WALL CLOCK in America/New_York with a numeric offset, for example 2027-03-14T12:00:00-04:00. NEVER return a Z/UTC timestamp; the backend will verify and normalize the Eastern offset. If the member gives another timezone, convert its wall time to equivalent Eastern wall time first. The latest member answer may revise earlier statements. Only ask about requirements the member actually mentioned; never ask about a field they did not bring up. Phrase any money question in dollars, never cents. Never infer a private reason. This is an unconfirmed draft, never permission to spend.");
          if (result.status !== "OK") throw new AppError(503, "AI_UNAVAILABLE");
          const extraction = result.value.data;
          const triage = triageExtraction(extraction, messages.filter(entry => entry.role === "user").map(entry => entry.content).join("\n"));
          if (triage.blocking) { await send(200, { stage: "CLARIFYING", reply: triage.blocking }); return; }
          if (extraction.proposed.maxContributionCents === undefined) { await send(200, { stage: "CLARIFYING", reply: "What is the most you would personally contribute to this stay?" }); return; }
          let latestCheckOutAt: string | undefined;
          try {
            latestCheckOutAt = extraction.proposed.latestCheckOutAt
              ? normalizeModelCheckout(extraction.proposed.latestCheckOutAt) : undefined;
          } catch {
            await send(200, { stage: "CLARIFYING", reply: "Please confirm the exact checkout date and time in Eastern Time." }); return;
          }
          const constraints = ConstraintsSchema.parse({
            maxContributionCents: extraction.proposed.maxContributionCents,
            latestCheckOutAt,
            requiresFullCashRefund: extraction.proposed.requiresFullCashRefund ?? false,
            requiresStepFreeAccess: extraction.proposed.requiresStepFreeAccess ?? false,
            softPreference: extraction.proposed.softPreferences?.map(item => item.kind.toLowerCase().replaceAll("_", " ")).join(", ") ?? "",
          });
          const reply = triage.notChecked.length
            ? "I have a draft for you to review. Some of what you mentioned isn't something Accord can check for a stay, so it isn't part of the draft. Nothing has been applied yet."
            : "I have a draft for you to review. Nothing has been applied yet.";
          await send(200, { stage: "REVIEW", reply, constraints, requiresConfirmation: true, followUps: triage.followUps, notChecked: triage.notChecked }); return;
        }
        if (route === "solve" && method === "POST") {
          await readJson(request);
          const result = await state.solve(room);
          if ("noSolution" in result) { await send(409, { code: "NO_FEASIBLE_OFFER" }); return; }
          await send(200, result); return;
        }
        if (route === "offers" && method === "GET") { await send(200, await state.offers(room)); return; }
        if (route === "offers/explanation" && method === "POST") {
          const expected = z.object({ recommendedOfferId: z.string(), offerVersion: z.string() }).strict().parse(await readJson(request));
          if (!aiConfigured) throw new AppError(503, "AI_UNAVAILABLE");
          const offers = await state.offers(room);
          const recommendation = offers.offers.find(offer => offer.offerId === offers.recommendedOfferId);
          if (offers.recommendedOfferId !== expected.recommendedOfferId || recommendation?.offerVersion !== expected.offerVersion) throw new AppError(409, "OFFER_CHANGED");
          const fingerprint = publicOffersFingerprint(offers);
          const explanation = await explainPublic(model, offers);
          const current = await state.offers(room);
          state.requireRoom(roomId, sessionRequired(state, request));
          if (publicOffersFingerprint(current) !== fingerprint) throw new AppError(409, "OFFER_CHANGED");
          await send(200, explanation); return;
        }
        if (route === "events" && method === "GET") { await send(200, { events: room.events.slice(-100) }); return; }
        if (route === "events/stream" && method === "GET") { await state.streams.connect(request, response, roomId, "public"); return; }
        if (route === "me/events/stream" && method === "GET") { await state.streams.connect(request, response, roomId, "private"); return; }
        if (route === "receipt" && method === "GET") { await send(200, state.receipt(room)); return; }
        if (route === "me/memories" && method === "GET") throw new AppError(503, "BACKBOARD_UNAVAILABLE");
      }
      const proposalMatch = proposalPattern.exec(path);
      if (proposalMatch) {
        const id = roomParam(proposalMatch[1]!), route = proposalMatch[2]!;
        const session = sessionRequired(state, request);
        const { proposal, room, member } = state.requireProposal(id, session);
        if (route === "public" && method === "GET") { await send(200, await state.proposalView(proposal)); return; }
        if (route === "me" && method === "GET") { await send(200, await state.privateProposal(proposal, member)); return; }
        if (route === "me/explanation" && method === "POST") {
          const input = z.object({ proposalHash: z.string() }).strict().parse(await readJson(request));
          if (input.proposalHash !== proposal.hash) throw new AppError(409, "PROPOSAL_STALE");
          if (!aiConfigured) throw new AppError(503, "AI_UNAVAILABLE");
          const own = await state.privateProposal(proposal, member);
          const currentOffer = proposal.state === "STALE" ? await state.currentOffer(proposal.snapshot.offer.offerId) : undefined;
          const currentVersion = currentOffer?.offerVersion ?? proposal.snapshot.offer.offerVersion;
          const currentShare = equalShares((currentOffer ?? proposal.snapshot.offer).totalCents, proposal.snapshot.memberIds)[member.id]!;
          const fingerprint = JSON.stringify([own.proposal.state, own.myConstraintChecks, own.myContributionCents, currentVersion, member.capsuleVersion]);
          const explanation = await explainPrivate(model, own, member.constraints!, currentShare);
          const latest = state.requireProposal(id, sessionRequired(state, request));
          const latestOwn = await state.privateProposal(latest.proposal, latest.member);
          const latestOffer = latest.proposal.state === "STALE" ? await state.currentOffer(latest.proposal.snapshot.offer.offerId) : undefined;
          const latestVersion = latestOffer?.offerVersion ?? latest.proposal.snapshot.offer.offerVersion;
          if (JSON.stringify([latestOwn.proposal.state, latestOwn.myConstraintChecks, latestOwn.myContributionCents, latestVersion, latest.member.capsuleVersion]) !== fingerprint) throw new AppError(409, "PROPOSAL_STALE");
          await send(200, explanation); return;
        }
        if (route === "consent" && method === "POST") {
          const input = z.object({ proposalHash: z.string(), version: z.number().int(), amountCents: z.number().int().nonnegative() }).strict().parse(await readJson(request));
          if (!request.headers["idempotency-key"]) throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED");
          await send(200, state.consent(proposal, room, member, input)); return;
        }
        if (route === "execute" && method === "POST") {
          const input = z.object({ proposalHash: z.string() }).strict().parse(await readJson(request));
          if (input.proposalHash !== proposal.hash) throw new AppError(409, "PROPOSAL_STALE");
          const key = request.headers["idempotency-key"];
          await send(200, await state.execute(proposal, room, member, typeof key === "string" ? key : "")); return;
        }
      }
      if (path === "/api/demo/merchant" && method === "GET") {
        const session = sessionRequired(state, request); const { room } = state.requireHost(session.roomId, session);
        await send(200, { offers: (await state.allOffers(state.offerIdsFor(room))).map(offer => ({ offerId: offer.offerId, propertyName: offer.propertyName, offerVersion: offer.offerVersion, totalCents: offer.totalCents, cancellationLabel: offer.cancellationPolicyCode, available: offer.available })) }); return;
      }
      if (path === "/api/merchant/events" && method === "POST") {
        const session = sessionRequired(state, request); state.requireHost(session.roomId, session);
        const input = z.object({ offerId: z.string().min(1), expectedOfferVersion: z.string().min(1), mutation: MerchantMutationSchema }).strict().parse(await readJson(request));
        const offer = await state.mutate(input.offerId, input.expectedOfferVersion, input.mutation);
        await send(200, { offerId: offer.offerId, offerVersion: offer.offerVersion }); return;
      }
      if (path === "/api/demo/reset" && method === "POST") {
        const session = sessionRequired(state, request); state.requireHost(session.roomId, session);
        z.object({ confirmed: z.literal(true) }).strict().parse(await readJson(request));
        state.streams.close(); await persistence?.clear(); state = new AccordState(persistence, providers); await state.ready;
        response.setHeader("set-cookie", "accord_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        await send(200, { reset: true, sessionsInvalidated: true }); return;
      }
      if (path === "/api/demo/analytics" && method === "GET") throw new AppError(503, "TIGER_UNAVAILABLE");
      if (path === "/api/intake/transcribe" && method === "POST") throw new AppError(503, "ELEVENLABS_UNAVAILABLE");
      if (method === "GET" && !path.startsWith("/api/")) { await serveFrontend(path, response); return; }
      throw new AppError(404, "NOT_FOUND");
    } catch (error) {
      // A rejected request may still have changed state (e.g. marked a proposal stale); persist that before replying.
      try { await state.flush(); } catch { /* reported by the original error or the next request */ }
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof z.ZodError) { json(response, 422, { code: "VALIDATION_FAILED" }); return; }
      if (error instanceof AppError) { json(response, error.status, { code: error.code }); return; }
      json(response, 500, { code: "INTERNAL_ERROR" });
    }
  });
  return { server, get state() { return state; } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let persistence: MongoPersistence | undefined;
  if (process.env.MONGODB_URI) {
    if (!process.env.ACCORD_ENCRYPTION_KEY) throw new Error("ACCORD_ENCRYPTION_KEY is required when MONGODB_URI is set");
    try { persistence = await MongoPersistence.connect(process.env.MONGODB_URI, process.env.MONGODB_DB ?? "accord", process.env.ACCORD_ENCRYPTION_KEY); }
    catch (error) {
      process.stderr.write(`\nCould not connect to MongoDB (${(error as Error).name}).\n` +
        "If you use Atlas, your current IP is probably not allowed: Atlas → Security → Network Access → Add IP Address.\n" +
        "To run without Mongo (state in memory only), start with MONGODB_URI set to an empty value.\n\n");
      process.exit(1);
    }
  }
  const solana = await configuredSolana();
  const { server, state } = createApi({ persistence, solana });
  await state.ready;
  const port = Number(process.env.PORT ?? "3000");
  server.listen(port, "0.0.0.0", () => process.stdout.write(`Accord API listening on ${port} (state: ${persistence ? "MongoDB" : "memory only"})\n`));
}
