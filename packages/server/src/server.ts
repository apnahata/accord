import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { ConstraintsSchema, ExtractionSchema, MerchantMutationSchema } from "@accord/domain";
import { Gemini } from "../../integrations/src/ai.js";
import type { Fetch } from "../../integrations/src/result.js";
import { AccordState, AppError } from "./state.js";

const name = z.string().trim().min(1).max(100);
const roomIdPattern = /^\/api\/rooms\/([^/]+)(?:\/(.*))?$/;
const proposalPattern = /^\/api\/proposals\/([^/]+)\/(public|me|consent|execute)$/;

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

export function createApi(options: { geminiApiKey?: string; geminiModel?: string; geminiFetch?: Fetch } = {}) {
  let state = new AccordState();
  const model = new Gemini({ apiKey: options.geminiApiKey ?? process.env.GEMINI_API_KEY, model: options.geminiModel ?? process.env.GEMINI_MODEL, fetch: options.geminiFetch });
  const aiConfigured = Boolean((options.geminiApiKey ?? process.env.GEMINI_API_KEY) && (options.geminiModel ?? process.env.GEMINI_MODEL));
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (method === "GET" && path === "/api/health") {
        json(response, 200, { app: "UP", mongo: "UNCONFIGURED", ai: aiConfigured ? "DOWN" : "UNCONFIGURED", tiger: "UNCONFIGURED", solana: "UNCONFIGURED", backboard: "UNCONFIGURED", elevenlabs: "UNCONFIGURED" }); return;
      }
      if (method === "GET" && path === "/api/capabilities") {
        json(response, 200, { ai: { available: aiConfigured }, elevenLabs: { available: false }, backboard: { available: false }, tiger: { available: false } }); return;
      }
      if (method === "POST" && path === "/api/rooms") {
        const input = z.object({ name, goal: z.string().trim().min(1).max(500), displayName: z.string().trim().min(1).max(60) }).strict().parse(await readJson(request));
        const result = state.createRoom(input.name, input.goal, input.displayName);
        response.setHeader("set-cookie", sessionCookie(result.sessionToken, request));
        json(response, 201, { roomId: result.roomId, inviteToken: result.inviteToken }); return;
      }
      const invitePreview = /^\/api\/invites\/([^/]+)$/.exec(path);
      if (method === "GET" && invitePreview) { json(response, 200, state.previewInvite(roomParam(invitePreview[1]!))); return; }
      const inviteJoin = /^\/api\/invites\/([^/]+)\/join$/.exec(path);
      if (method === "POST" && inviteJoin) {
        const input = z.object({ displayName: z.string().trim().min(1).max(60) }).strict().parse(await readJson(request));
        const result = state.join(roomParam(inviteJoin[1]!), input.displayName);
        response.setHeader("set-cookie", sessionCookie(result.sessionToken, request));
        json(response, 201, { roomId: result.roomId }); return;
      }
      const roomMatch = roomIdPattern.exec(path);
      if (roomMatch) {
        const roomId = roomParam(roomMatch[1]!);
        const route = roomMatch[2] ?? "";
        const session = sessionRequired(state, request);
        const { room, member } = state.requireRoom(roomId, session);
        if (route === "" && method === "GET") { json(response, 200, state.roomDTO(room)); return; }
        if (route === "invites" && method === "POST") { json(response, 200, { inviteToken: room.inviteToken }); return; }
        if (route === "me/constraints" && method === "GET") { json(response, 200, { displayName: member.displayName, constraints: member.constraints, confirmedAt: member.confirmedAt }); return; }
        if (route === "me/constraints" && method === "POST") {
          const input = z.object({ confirmed: z.literal(true) }).extend(ConstraintsSchema.shape).strict().parse(await readJson(request));
          const { confirmed: _confirmed, ...fields } = input;
          state.confirmConstraints(room, member, ConstraintsSchema.parse(fields));
          json(response, 200, { displayName: member.displayName, constraints: member.constraints, confirmedAt: member.confirmedAt }); return;
        }
        if (route === "me/intake/extract" && method === "POST") {
          const message = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(1000) }).strict();
          const { messages } = z.object({ messages: z.array(message).min(1).max(24) }).strict().parse(await readJson(request));
          if (messages.length % 2 !== 1 || messages.some((entry, index) => entry.role !== (index % 2 === 0 ? "user" : "assistant"))) throw new AppError(422, "INVALID_CONVERSATION");
          if (!aiConfigured) throw new AppError(503, "AI_UNAVAILABLE");
          const result = await model.generate({ input: z.object({ roomGoal: z.string(), timeZone: z.string(), messages: z.array(message) }).strict(), output: ExtractionSchema },
            { roomGoal: room.goal, timeZone: "America/New_York", messages },
            "Interpret the full private conversation about a shared stay. The latest member answer may revise an earlier one. Extract only supported functional constraints. Ask one concise functional clarification when a requirement is ambiguous. Never infer a private reason or a maximum contribution. Resolve relative dates only when the supplied goal or conversation establishes the exact date; otherwise ask which date. If statements conflict, ask rather than guessing. The result is an unconfirmed draft, never permission to spend.");
          if (result.status !== "OK") throw new AppError(503, "AI_UNAVAILABLE");
          const extraction = result.value.data;
          if (extraction.unsupportedHardRequirements.length || extraction.ambiguities.length) {
            json(response, 200, { stage: "CLARIFYING", reply: extraction.ambiguities[0]?.question ?? "I can't verify one of those requirements for a stay yet. Can you describe the functional requirement another way?" }); return;
          }
          if (extraction.proposed.maxContributionCents === undefined) { json(response, 200, { stage: "CLARIFYING", reply: "What is the most you would personally contribute to this stay?" }); return; }
          const constraints = ConstraintsSchema.parse({
            maxContributionCents: extraction.proposed.maxContributionCents,
            latestCheckOutAt: extraction.proposed.latestCheckOutAt,
            requiresFullCashRefund: extraction.proposed.requiresFullCashRefund ?? false,
            requiresStepFreeAccess: extraction.proposed.requiresStepFreeAccess ?? false,
            softPreference: extraction.proposed.softPreferences?.map(item => item.kind.toLowerCase().replaceAll("_", " ")).join(", ") ?? "",
          });
          json(response, 200, { stage: "REVIEW", reply: "I have a draft for you to review. Nothing has been applied yet.", constraints, requiresConfirmation: true }); return;
        }
        if (route === "solve" && method === "POST") {
          await readJson(request);
          const result = await state.solve(room);
          if ("noSolution" in result) { json(response, 409, { code: "NO_FEASIBLE_OFFER" }); return; }
          json(response, 200, result); return;
        }
        if (route === "offers" && method === "GET") { json(response, 200, await state.offers(room)); return; }
        if (route === "events" && method === "GET") { json(response, 200, { events: room.events.slice(-100) }); return; }
        if (route === "events/stream" && method === "GET") { await state.streams.connect(request, response, roomId, "public"); return; }
        if (route === "me/events/stream" && method === "GET") { await state.streams.connect(request, response, roomId, "private"); return; }
        if (route === "receipt" && method === "GET") { json(response, 200, state.receipt(room)); return; }
        if (route === "me/memories" && method === "GET") throw new AppError(503, "BACKBOARD_UNAVAILABLE");
      }
      const proposalMatch = proposalPattern.exec(path);
      if (proposalMatch) {
        const id = roomParam(proposalMatch[1]!), route = proposalMatch[2]!;
        const session = sessionRequired(state, request);
        const { proposal, room, member } = state.requireProposal(id, session);
        if (route === "public" && method === "GET") { json(response, 200, state.publicProposal(proposal)); return; }
        if (route === "me" && method === "GET") { json(response, 200, await state.privateProposal(proposal, member)); return; }
        if (route === "consent" && method === "POST") {
          const input = z.object({ proposalHash: z.string(), version: z.number().int(), amountCents: z.number().int().nonnegative() }).strict().parse(await readJson(request));
          if (!request.headers["idempotency-key"]) throw new AppError(422, "IDEMPOTENCY_KEY_REQUIRED");
          json(response, 200, state.consent(proposal, room, member, input)); return;
        }
        if (route === "execute" && method === "POST") {
          const input = z.object({ proposalHash: z.string() }).strict().parse(await readJson(request));
          if (input.proposalHash !== proposal.hash) throw new AppError(409, "PROPOSAL_STALE");
          const key = request.headers["idempotency-key"];
          json(response, 200, await state.execute(proposal, room, member, typeof key === "string" ? key : "")); return;
        }
      }
      if (path === "/api/demo/merchant" && method === "GET") {
        const session = sessionRequired(state, request); state.requireHost(session.roomId, session);
        json(response, 200, { offers: (await state.allOffers()).map(offer => ({ offerId: offer.offerId, propertyName: offer.propertyName, offerVersion: offer.offerVersion, totalCents: offer.totalCents, cancellationLabel: offer.cancellationPolicyCode, available: offer.available })) }); return;
      }
      if (path === "/api/merchant/events" && method === "POST") {
        const session = sessionRequired(state, request); state.requireHost(session.roomId, session);
        const input = z.object({ offerId: z.string().min(1), expectedOfferVersion: z.string().min(1), mutation: MerchantMutationSchema }).strict().parse(await readJson(request));
        const offer = await state.mutate(input.offerId, input.expectedOfferVersion, input.mutation);
        json(response, 200, { offerId: offer.offerId, offerVersion: offer.offerVersion }); return;
      }
      if (path === "/api/demo/reset" && method === "POST") {
        const session = sessionRequired(state, request); state.requireHost(session.roomId, session);
        z.object({ confirmed: z.literal(true) }).strict().parse(await readJson(request));
        state.streams.close(); state = new AccordState(); await state.ready;
        response.setHeader("set-cookie", "accord_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        json(response, 200, { reset: true, sessionsInvalidated: true }); return;
      }
      if (path === "/api/demo/analytics" && method === "GET") throw new AppError(503, "TIGER_UNAVAILABLE");
      if (path === "/api/intake/transcribe" && method === "POST") throw new AppError(503, "ELEVENLABS_UNAVAILABLE");
      if (method === "GET" && !path.startsWith("/api/")) { await serveFrontend(path, response); return; }
      throw new AppError(404, "NOT_FOUND");
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof z.ZodError) { json(response, 422, { code: "VALIDATION_FAILED" }); return; }
      if (error instanceof AppError) { json(response, error.status, { code: error.code }); return; }
      json(response, 500, { code: "INTERNAL_ERROR" });
    }
  });
  return { server, get state() { return state; } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createApi();
  const port = Number(process.env.PORT ?? "3000");
  server.listen(port, "0.0.0.0", () => process.stdout.write(`Accord API listening on ${port}\n`));
}
