import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { addDays, AvailabilitySchema, ConstraintsSchema, ExtractionSchema, localDay, MerchantMutationSchema, PLANNING_HORIZON_DAYS, TRIP_STYLES, TripPlanSchema, TripSchema, TripStyleSchema, equalShares } from "@accord/domain";
import { Gemini } from "../../integrations/src/ai.js";
import type { Fetch } from "../../integrations/src/result.js";
import { AccordState, AppError } from "./state.js";
import type { AlternativesInput, AutopilotOptions } from "./coordinator.js";
import type { DestinationsInput } from "./planner.js";
import { MongoPersistence } from "./persistence.js";
import { SESSION_TTL_SECONDS } from "./persistence.js";
import { GoogleHotels, LiteApi } from "./stays.js";
import { Pulse } from "./pulse.js";
import { createTigerPool } from "../../integrations/src/tiger.js";
import { normalizeModelCheckout } from "./model-time.js";
import { respectExplicitOptionality, triageExtraction } from "./intake.js";
import { explainPrivate, explainPublic, publicOffersFingerprint } from "./explanations.js";
import { cyberSourceFromEnv, type PaymentGateway } from "./payments.js";

const name = z.string().trim().min(1).max(100);
const credentials = z.object({
  email: z.string().trim().email("Enter a valid email address").max(254, "Email is too long"),
  password: z.string().min(10, "Use at least 10 characters").max(128, "Password is too long"),
}).strict();
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
  return `accord_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}
/** Keeps only well-formed answers inside the planning window; the member reviews the draft before anything is saved. */
function planningAnswers(proposed: z.infer<typeof ExtractionSchema>["proposed"], window: { earliest: string; latest: string }) {
  const availability = (proposed.availability ?? []).flatMap(range => {
    const clipped = { from: range.from < window.earliest ? window.earliest : range.from, to: range.to > window.latest ? window.latest : range.to };
    return AvailabilitySchema.safeParse(clipped).success ? [clipped] : [];
  });
  const text = (value?: string, max = 300) => value?.trim().slice(0, max) || undefined;
  const placeIdeas = text(proposed.placeIdeas), placesToAvoid = text(proposed.placesToAvoid), leavingFrom = text(proposed.leavingFrom, 120);
  const nights = proposed.nights && proposed.nights >= 1 && proposed.nights <= 14 ? proposed.nights : undefined;
  return { ...(availability.length ? { availability } : {}), ...(proposed.tripStyles?.length ? { tripStyles: [...new Set(proposed.tripStyles)] } : {}),
    ...(placeIdeas ? { placeIdeas } : {}), ...(placesToAvoid ? { placesToAvoid } : {}), ...(nights ? { nights } : {}), ...(leavingFrom ? { leavingFrom } : {}) };
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
  liteApiKey?: string; serpApiKey?: string; staysFetch?: Fetch; payment?: PaymentGateway; allowAnonymousAccounts?: boolean;
  autopilot?: AutopilotOptions; tigerUrl?: string; pulse?: Pulse } = {}) {
  const persistence = options.persistence;
  const model = new Gemini({ apiKey: options.geminiApiKey ?? process.env.GEMINI_API_KEY, model: options.geminiModel ?? process.env.GEMINI_MODEL, fetch: options.geminiFetch });
  const aiConfigured = Boolean((options.geminiApiKey ?? process.env.GEMINI_API_KEY) && (options.geminiModel ?? process.env.GEMINI_MODEL));
  const liteApiKey = options.liteApiKey ?? process.env.LITEAPI_KEY, serpApiKey = options.serpApiKey ?? process.env.SERPAPI_KEY;
  const publicAppUrl = String(process.env.PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  const inviteUrl = (inviteToken: string) => publicAppUrl && /^https?:\/\//.test(publicAppUrl) ? `${publicAppUrl}/join/${encodeURIComponent(inviteToken)}` : undefined;
  const payment = options.payment ?? cyberSourceFromEnv(process.env);
  const allowAnonymousAccounts = options.allowAnonymousAccounts ?? process.env.ACCORD_TEST_ALLOW_ANONYMOUS === "1";
  const tigerUrl = options.tigerUrl ?? process.env.TIGER_DATABASE_URL;
  const pulse = options.pulse ?? (tigerUrl ? new Pulse(createTigerPool(tigerUrl)) : undefined);
  const observe = pulse ? pulse.observe.bind(pulse) : undefined;
  const providers = {
    ...(liteApiKey ? { liteApi: new LiteApi(liteApiKey, options.staysFetch, observe) } : {}),
    ...(serpApiKey ? { google: new GoogleHotels(serpApiKey, options.staysFetch, observe) } : {}),
    ...(payment ? { payment } : {}),
    ...(pulse ? { pulse } : {}),
    ...(aiConfigured ? { summarize: async (facts: unknown) => {
      const result = await model.generate({ input: z.unknown(), output: z.object({ summary: z.string().max(400) }).strict() }, facts,
        "Write one or two plain sentences (max 45 words) telling a group of friends what this stay is like, using only the supplied public listing facts. No names of group members, no budgets, no invented facts, no marketing language.");
      return result.status === "OK" ? result.value.data.summary : undefined;
    },
    suggestAlternatives: async (input: AlternativesInput) => {
      const result = await model.generate({
        input: z.object({ destination: z.string(), countryCode: z.string(), checkIn: z.string(), checkOut: z.string(), guests: z.number(),
          staysChecked: z.number(), staysAvailable: z.number(), staysFailing: z.record(z.string(), z.number()) }).strict(),
        output: z.object({ destinations: z.array(z.string().min(2).max(120)).max(2) }).strict() }, input,
        "A group could not find a shared stay that satisfies everyone's private requirements in the original destination. Suggest up to two nearby alternative destinations in the same country, reachable for the same trip dates, where suitable stays are more likely (for example cheaper nearby cities when many stays failed on budget). Use only the supplied trip facts and anonymous totals. Format each as 'City, ST'. Return an empty list if nothing nearby makes sense.");
      return result.status === "OK" ? result.value.data.destinations : undefined;
    },
    suggestDestinations: async (input: DestinationsInput) => {
      const window = z.object({ checkIn: z.string(), checkOut: z.string() }).strict();
      const result = await model.generate({
        input: z.object({ from: z.array(z.string()), countryCode: z.string(), nights: z.number(), guests: z.number(),
          windows: z.array(window), styleCounts: z.record(z.string(), z.number()), ideas: z.array(z.string()), avoid: z.array(z.string()) }).strict(),
        output: z.object({ destinations: z.array(z.object({ name: z.string().min(2).max(120), timeZone: z.string().max(64),
          styles: z.array(TripStyleSchema).max(TRIP_STYLES.length), why: z.string().max(160) }).strict()).max(5) }).strict() }, input,
        "A group of friends has not picked a destination yet. Suggest three to five destinations in the given country that best fit the group as a whole, for the given dates and trip length. styleCounts says how many people picked each trip style; favor what most people want but include something for a sizeable minority. ideas are places members would love and avoid are places members ruled out: never suggest anywhere that matches an avoid entry. from lists where members are leaving from, when they said; favor places that are a reasonable trip for most of them, and never suggest a place someone is leaving from, since that is home for them. Prefer places that work in that season (no ski trips without snow, no beach trips in winter cold). Format each name as 'City, ST'. Give its IANA time zone, the trip styles it offers, and one short sentence (max 20 words) about why it suits this group, using only the anonymous totals. No budgets, no names.");
      return result.status === "OK" ? result.value.data.destinations : undefined;
    } } : {}),
  };
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const autopilot: AutopilotOptions = { enabled: process.env.ACCORD_AUTOPILOT !== "off", ...options.autopilot };
  let state = new AccordState(persistence, providers, autopilot);
  const server = createServer(async (request, response) => {
    // Nothing is acknowledged to a client until the changes it caused are durable.
    const send = async (status: number, body: unknown) => { await state.flush(); json(response, status, body); };
    try {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (method === "GET" && path === "/api/health") {
        await send(200, { app: "UP", mongo: persistence ? (await persistence.ping() ? "UP" : "DOWN") : "UNCONFIGURED", ai: aiConfigured ? "CONFIGURED" : "UNCONFIGURED", liteapi: liteApiKey ? "CONFIGURED" : "UNCONFIGURED", googleHotels: serpApiKey ? "CONFIGURED" : "UNCONFIGURED", cybersource: payment ? "SANDBOX_CONFIGURED" : "UNCONFIGURED", tiger: pulse ? (await pulse.ping() ? "UP" : "DOWN") : "UNCONFIGURED", solana: "UNCONFIGURED", backboard: "UNCONFIGURED", elevenlabs: "UNCONFIGURED" }); return;
      }
      if (method === "GET" && path === "/api/capabilities") {
        await send(200, { ai: { available: aiConfigured }, elevenLabs: { available: false }, backboard: { available: false }, tiger: { available: !!pulse }, autopilot: { available: autopilot.enabled !== false }, liveSearch: { available: Boolean(liteApiKey || serpApiKey) } }); return;
      }
      if (method === "POST" && path === "/api/auth/register") {
        const input = credentials.extend({ displayName: z.string().trim().min(1).max(60) }).parse(await readJson(request));
        const result = await state.register(input.email, input.password, input.displayName, state.sessionFromCookie(request.headers.cookie));
        state.revokeSession(request.headers.cookie);
        response.setHeader("set-cookie", sessionCookie(result.sessionToken, request));
        await send(201, result.account); return;
      }
      if (method === "POST" && path === "/api/auth/login") {
        const input = credentials.parse(await readJson(request));
        const attemptKey = `${request.socket.remoteAddress ?? "unknown"}:${input.email.trim().toLowerCase()}`;
        const current = loginAttempts.get(attemptKey);
        if (current && current.resetAt > Date.now() && current.count >= 8) throw new AppError(429, "LOGIN_RATE_LIMITED");
        if (current && current.resetAt <= Date.now()) loginAttempts.delete(attemptKey);
        let result;
        try { result = await state.login(input.email, input.password); loginAttempts.delete(attemptKey); }
        catch (error) {
          if (error instanceof AppError && error.code === "INVALID_CREDENTIALS") {
            const attempt = loginAttempts.get(attemptKey);
            loginAttempts.set(attemptKey, { count: (attempt?.count ?? 0) + 1, resetAt: attempt?.resetAt ?? Date.now() + 15 * 60_000 });
          }
          throw error;
        }
        state.revokeSession(request.headers.cookie);
        response.setHeader("set-cookie", sessionCookie(result.sessionToken, request));
        await send(200, result.account); return;
      }
      if (method === "GET" && path === "/api/me") { await send(200, state.accountDTO(sessionRequired(state, request))); return; }
      if (method === "POST" && path === "/api/me/profile") {
        const input = z.object({ displayName: z.string().trim().min(1).max(60) }).strict().parse(await readJson(request));
        await send(200, state.updateProfile(sessionRequired(state, request), input.displayName)); return;
      }
      if (method === "POST" && path === "/api/logout") {
        state.revokeSession(request.headers.cookie);
        response.setHeader("set-cookie", "accord_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        await send(200, { signedOut: true }); return;
      }
      if (method === "POST" && path === "/api/rooms") {
        const body = await readJson(request);
        const session = state.sessionFromCookie(request.headers.cookie);
        const account = session ? state.users.get(session.userId) : undefined;
        if (!allowAnonymousAccounts && !account?.email) throw new AppError(401, "ACCOUNT_REQUIRED");
        const roomFields = { name, goal: z.string().trim().max(500).optional(), trip: TripSchema.optional(), plan: TripPlanSchema.optional(), rehearsal: z.boolean().optional() };
        const input = (allowAnonymousAccounts
          ? z.object({ ...roomFields, displayName: z.string().trim().min(1).max(60) }).strict()
          : z.object(roomFields).strict()).parse(body);
        if (input.trip && input.plan) throw new AppError(422, "VALIDATION_FAILED");
        if (input.trip && Date.parse(input.trip.checkIn) < Date.now() - 86_400_000) throw new AppError(422, "TRIP_IN_PAST");
        const goal = input.goal || (input.trip ? `A shared stay in ${input.trip.destination} for ${input.trip.guests}, ${input.trip.checkIn} to ${input.trip.checkOut}.`
          : input.plan ? "A group trip. Accord works out where and when from everyone’s private answers." : "");
        if (!goal) throw new AppError(422, "VALIDATION_FAILED");
        const displayName = account?.displayName ?? ("displayName" in input && typeof input.displayName === "string" ? input.displayName : undefined);
        if (!displayName) throw new AppError(401, "ACCOUNT_REQUIRED");
        const result = state.createRoom(input.name, goal, displayName, input.trip, session,
          input.plan ? { plan: input.plan, rehearsal: input.rehearsal === true || !(liteApiKey || serpApiKey) } : undefined);
        response.setHeader("set-cookie", sessionCookie(result.sessionToken, request));
        await send(201, { roomId: result.roomId, inviteToken: result.inviteToken, ...(inviteUrl(result.inviteToken) ? { inviteUrl: inviteUrl(result.inviteToken) } : {}) }); return;
      }
      const invitePreview = /^\/api\/invites\/([^/]+)$/.exec(path);
      if (method === "GET" && invitePreview) { await send(200, state.previewInvite(roomParam(invitePreview[1]!))); return; }
      const inviteJoin = /^\/api\/invites\/([^/]+)\/join$/.exec(path);
      if (method === "POST" && inviteJoin) {
        const body = await readJson(request);
        const session = state.sessionFromCookie(request.headers.cookie);
        const account = session ? state.users.get(session.userId) : undefined;
        if (!allowAnonymousAccounts && !account?.email) throw new AppError(401, "ACCOUNT_REQUIRED");
        const input = (allowAnonymousAccounts ? z.object({ displayName: z.string().trim().min(1).max(60) }).strict() : z.object({}).strict()).parse(body);
        const displayName = account?.displayName ?? ("displayName" in input && typeof input.displayName === "string" ? input.displayName : undefined);
        if (!displayName) throw new AppError(401, "ACCOUNT_REQUIRED");
        const result = state.join(roomParam(inviteJoin[1]!), displayName, session);
        if (result.sessionToken) response.setHeader("set-cookie", sessionCookie(result.sessionToken, request));
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
        if (route === "invites" && method === "POST") { await send(200, { inviteToken: room.inviteToken, ...(inviteUrl(room.inviteToken) ? { inviteUrl: inviteUrl(room.inviteToken) } : {}) }); return; }
        if (route === "me/leave" && method === "POST") {
          state.leave(room, member);
          await send(200, { left: true }); return;
        }
        if (route === "me/constraints" && method === "GET") { await send(200, { displayName: member.displayName, constraints: member.constraints, confirmedAt: member.confirmedAt }); return; }
        if (route === "me/constraints" && method === "POST") {
          const input = z.object({ confirmed: z.literal(true) }).extend(ConstraintsSchema.shape).strict().parse(await readJson(request));
          const { confirmed: _confirmed, ...fields } = input;
          state.confirmConstraints(room, member, ConstraintsSchema.parse(fields));
          await send(200, { displayName: member.displayName, constraints: member.constraints, confirmedAt: member.confirmedAt });
          state.beginSolveWhenReady(room); return;
        }
        if (route === "me/intake/extract" && method === "POST") {
          const message = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(1000) }).strict();
          const { messages } = z.object({ messages: z.array(message).min(1).max(24) }).strict().parse(await readJson(request));
          if (messages.length % 2 !== 1 || messages.some((entry, index) => entry.role !== (index % 2 === 0 ? "user" : "assistant"))) throw new AppError(422, "INVALID_CONVERSATION");
          if (!aiConfigured) throw new AppError(503, "AI_UNAVAILABLE");
          const today = localDay(new Date().toISOString());
          const planning = room.plan && !room.trip ? { earliest: addDays(today, 1), latest: addDays(today, PLANNING_HORIZON_DAYS) } : undefined;
          const planningInstruction = planning
            ? ` This group has not picked a destination, dates or trip length yet; Accord works them out from everyone's private answers. Today is ${today}. Also extract, only when the member says them: availability as day ranges they can travel (from = earliest day they could leave home, to = latest day they could be back) between ${planning.earliest} and ${planning.latest}, converted from phrases like 'any weekend in March' or 'not the week of the 10th' into explicit ranges; nights as how many nights they'd like the trip to be; leavingFrom as where they'd be leaving from; tripStyles from BEACH, MOUNTAINS, SKI, CITY, NATURE, THEME_PARKS, LAKE; placeIdeas as a short phrase of places they'd love; placesToAvoid as a short phrase of places they ruled out. Dates, trip length, departure, trip styles and places are never unsupported requirements. Never invent any of them.`
            : "";
          const result = await model.generate({ input: z.object({ roomGoal: z.string(), timeZone: z.string(), planning: z.object({ earliest: z.string(), latest: z.string() }).strict().optional(), messages: z.array(message) }).strict(), output: ExtractionSchema },
            { roomGoal: room.goal, timeZone: "America/New_York", ...(planning ? { planning } : {}), messages },
            "Read the full private stay conversation. Extract an EXPLICIT personal spending maximum into maxContributionCents: $350 means 35000 cents; never omit an explicit maximum and never invent a missing one. All fields except the spending maximum are optional. Never ask about an optional field the member did not mention. If the member says they do not care, have no preference, or any date/time works, omit that field and do not ask again. Date-only availability belongs in earliestCheckInDate, latestCheckInDate, and latestCheckOutDate as YYYY-MM-DD. Never invent a clock time for a date-only statement. Only use earliestCheckInAt, latestCheckInAt, or latestCheckOutAt when the member explicitly states a clock time. A walkable/quiet/near-activities/low-price wish is a soft preference, not an unsupported hard requirement. Only list a hard requirement as unsupported when none of the supported fields can represent it. Ask one concise clarification only when a requirement the member explicitly chose cannot be represented safely without it. Resolve relative dates only from supplied dates; otherwise ask for the calendar date. Express every explicit date/time as the requested WALL CLOCK in America/New_York with a numeric offset, for example 2027-03-14T12:00:00-04:00. NEVER return a Z/UTC timestamp. The latest member answer may revise earlier statements. Phrase money questions in dollars, never cents. Never infer a private reason. This is an unconfirmed draft, never permission to spend." + planningInstruction);
          if (result.status !== "OK") throw new AppError(503, "AI_UNAVAILABLE");
          const extraction = respectExplicitOptionality(result.value.data, messages.at(-1)!.content);
          const triage = triageExtraction(extraction);
          if (triage.blocking) { await send(200, { stage: "CLARIFYING", reply: triage.blocking }); return; }
          if (extraction.proposed.maxContributionCents === undefined) { await send(200, { stage: "CLARIFYING", reply: "What is the most you would personally contribute to this stay?" }); return; }
          const tripAnswers = planning && planningAnswers(extraction.proposed, planning);
          if (tripAnswers && !tripAnswers.availability) { await send(200, { stage: "CLARIFYING", reply: "When could you travel? A rough stretch of dates is fine, like “any time Nov 7–16”." }); return; }
          let earliestCheckInAt: string | undefined, latestCheckInAt: string | undefined, latestCheckOutAt: string | undefined;
          try {
            earliestCheckInAt = extraction.proposed.earliestCheckInAt
              ? normalizeModelCheckout(extraction.proposed.earliestCheckInAt) : undefined;
            latestCheckInAt = extraction.proposed.latestCheckInAt
              ? normalizeModelCheckout(extraction.proposed.latestCheckInAt) : undefined;
            latestCheckOutAt = extraction.proposed.latestCheckOutAt
              ? normalizeModelCheckout(extraction.proposed.latestCheckOutAt) : undefined;
          } catch {
            await send(200, { stage: "CLARIFYING", reply: "Please confirm the exact check-in or checkout date and time in Eastern Time." }); return;
          }
          if (earliestCheckInAt && latestCheckInAt && Date.parse(earliestCheckInAt) > Date.parse(latestCheckInAt)) {
            await send(200, { stage: "CLARIFYING", reply: "Your earliest check-in is after your latest check-in. What exact check-in window should Accord use?" }); return;
          }
          const constraints = ConstraintsSchema.parse({
            maxContributionCents: extraction.proposed.maxContributionCents,
            earliestCheckInDate: extraction.proposed.earliestCheckInDate,
            latestCheckInDate: extraction.proposed.latestCheckInDate,
            latestCheckOutDate: extraction.proposed.latestCheckOutDate,
            earliestCheckInAt,
            latestCheckInAt,
            latestCheckOutAt,
            requiresFullCashRefund: extraction.proposed.requiresFullCashRefund ?? false,
            requiresStepFreeAccess: extraction.proposed.requiresStepFreeAccess ?? false,
            softPreference: extraction.proposed.softPreferences?.map(item => item.kind.toLowerCase().replaceAll("_", " ")).join(", ") ?? "",
            ...tripAnswers,
          });
          const reply = triage.notChecked.length
            ? "I have a draft for you to review. Some of what you mentioned isn't something Accord can check for a stay, so it isn't part of the draft. Nothing has been applied yet."
            : "I have a draft for you to review. Nothing has been applied yet.";
          await send(200, { stage: "REVIEW", reply, constraints, requiresConfirmation: true, followUps: triage.followUps, notChecked: triage.notChecked }); return;
        }
        if (route === "me/inbox" && method === "GET") { await send(200, state.inbox(member)); return; }
        const respondMatch = /^me\/inbox\/([^/]+)\/respond$/.exec(route);
        if (respondMatch && method === "POST") {
          const input = z.object({ action: z.enum(["ACCEPT", "KEEP"]) }).strict().parse(await readJson(request));
          state.autopilot.respond(room, member.id, roomParam(respondMatch[1]!), input.action);
          await send(200, state.inbox(member)); return;
        }
        if (route === "plan/vote" && method === "POST") {
          const input = z.object({ optionId: z.string().min(1).max(200) }).strict().parse(await readJson(request));
          await state.autopilot.vote(room, member.id, input.optionId);
          await send(200, state.roomDTO(room, member.id)); return;
        }
        if (route === "plan/reopen" && method === "POST") {
          z.object({ confirmed: z.literal(true) }).strict().parse(await readJson(request));
          if (member.id !== room.hostId) throw new AppError(403, "ADMIN_ACCESS_DENIED");
          state.autopilot.planner.reopen(room);
          state.autopilot.kick(room, "READY");
          await send(200, state.roomDTO(room, member.id)); return;
        }
        if (route === "solve" && method === "POST" && state.autopilot.planner.needsPlanning(room)) {
          await readJson(request);
          await state.autopilot.planNow(room);
          await send(200, state.roomDTO(room, member.id)); return;
        }
        if (route === "solve" && method === "POST") {
          await readJson(request);
          const result = await state.autopilot.solveNow(room);
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
        if (route === "demo/merchant" && method === "GET") {
          state.requireHost(roomId, session);
          await send(200, { offers: (await state.allOffers(state.offerIdsFor(room))).map(offer => ({ offerId: offer.offerId, propertyName: offer.propertyName, offerVersion: offer.offerVersion, totalCents: offer.totalCents, cancellationLabel: offer.cancellationPolicyCode, available: offer.available })) }); return;
        }
        if (route === "merchant/events" && method === "POST") {
          state.requireHost(roomId, session);
          const input = z.object({ offerId: z.string().min(1), expectedOfferVersion: z.string().min(1), mutation: MerchantMutationSchema }).strict().parse(await readJson(request));
          if (!state.offerIdsFor(room).includes(input.offerId)) throw new AppError(403, "OFFER_NOT_IN_ROOM");
          const offer = await state.mutate(input.offerId, input.expectedOfferVersion, input.mutation);
          await send(200, { offerId: offer.offerId, offerVersion: offer.offerVersion }); return;
        }
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
          const key = request.headers["idempotency-key"];
          await send(200, await state.consent(proposal, room, member, input, typeof key === "string" ? key : "")); return;
        }
        if (route === "execute" && method === "POST") {
          const input = z.object({ proposalHash: z.string() }).strict().parse(await readJson(request));
          if (input.proposalHash !== proposal.hash) throw new AppError(409, "PROPOSAL_STALE");
          const key = request.headers["idempotency-key"];
          await send(200, await state.execute(proposal, room, member, typeof key === "string" ? key : "")); return;
        }
      }
      if (path === "/api/demo/merchant" && method === "GET") {
        const session = sessionRequired(state, request); if (!session.roomId) throw new AppError(403, "ROOM_ACCESS_DENIED"); const { room } = state.requireHost(session.roomId, session);
        await send(200, { offers: (await state.allOffers(state.offerIdsFor(room))).map(offer => ({ offerId: offer.offerId, propertyName: offer.propertyName, offerVersion: offer.offerVersion, totalCents: offer.totalCents, cancellationLabel: offer.cancellationPolicyCode, available: offer.available })) }); return;
      }
      if (path === "/api/merchant/events" && method === "POST") {
        const session = sessionRequired(state, request); if (!session.roomId) throw new AppError(403, "ROOM_ACCESS_DENIED"); state.requireHost(session.roomId, session);
        const input = z.object({ offerId: z.string().min(1), expectedOfferVersion: z.string().min(1), mutation: MerchantMutationSchema }).strict().parse(await readJson(request));
        const offer = await state.mutate(input.offerId, input.expectedOfferVersion, input.mutation);
        await send(200, { offerId: offer.offerId, offerVersion: offer.offerVersion }); return;
      }
      if (path === "/api/demo/reset" && method === "POST") {
        const session = sessionRequired(state, request); if (!session.roomId) throw new AppError(403, "ROOM_ACCESS_DENIED"); state.requireHost(session.roomId, session);
        z.object({ confirmed: z.literal(true) }).strict().parse(await readJson(request));
        state.autopilot.dispose(); state.streams.close(); await persistence?.clear(); state = new AccordState(persistence, providers, autopilot); await state.ready;
        response.setHeader("set-cookie", "accord_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        await send(200, { reset: true, sessionsInvalidated: true }); return;
      }
      // Public, anonymous market + consensus dashboard served from Tiger Data.
      if (path === "/api/pulse" && method === "GET") {
        if (!pulse) throw new AppError(503, "TIGER_UNAVAILABLE");
        try { await send(200, await pulse.dashboard()); } catch { throw new AppError(503, "TIGER_UNAVAILABLE"); }
        return;
      }
      if (path === "/api/demo/analytics" && method === "GET") {
        const session = sessionRequired(state, request);
        if (!session.roomId) throw new AppError(403, "ADMIN_ACCESS_DENIED");
        const { room } = state.requireHost(session.roomId, session);
        const proposal = room.activeProposalId ? state.proposals.get(room.activeProposalId) : undefined;
        if (!pulse || !room.trip || !proposal) throw new AppError(503, "TIGER_UNAVAILABLE");
        let history;
        try { history = await pulse.offerHistory(room.trip, proposal.snapshot.offer.offerId); } catch { throw new AppError(503, "TIGER_UNAVAILABLE"); }
        await send(200, { source: "TIGER", points: history.map(point => ({ at: point.at, totalCents: point.totalCents, label: proposal.snapshot.offer.propertyName })) }); return;
      }
      if (path === "/api/intake/transcribe" && method === "POST") throw new AppError(503, "ELEVENLABS_UNAVAILABLE");
      if (method === "GET" && !path.startsWith("/api/")) { await serveFrontend(path, response); return; }
      throw new AppError(404, "NOT_FOUND");
    } catch (error) {
      // A rejected request may still have changed state (e.g. marked a proposal stale); persist that before replying.
      try { await state.flush(); } catch { /* reported by the original error or the next request */ }
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof z.ZodError) {
        json(response, 422, { code: "VALIDATION_FAILED", issues: error.issues.slice(0, 5).map(issue => ({ path: issue.path.map(String), message: issue.message })) }); return;
      }
      if (error instanceof AppError) { json(response, error.status, { code: error.code }); return; }
      json(response, 500, { code: "INTERNAL_ERROR" });
    }
  });
  server.on("close", () => state.autopilot.dispose());
  return { server, get state() { return state; } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.INTEGRATION_MODE === "required") {
    const required = ["MONGODB_URI", "ACCORD_ENCRYPTION_KEY", "LITEAPI_KEY", "GEMINI_API_KEY", "GEMINI_MODEL",
      "CYBERSOURCE_MERCHANT_ID", "CYBERSOURCE_KEY_ID", "CYBERSOURCE_SECRET_KEY", "CYBERSOURCE_TEST_CARD_NUMBER",
      "CYBERSOURCE_TEST_CARD_EXPIRY_MONTH", "CYBERSOURCE_TEST_CARD_EXPIRY_YEAR"] as const;
    const missing = required.filter(key => !process.env[key]);
    if (missing.length) throw new Error(`INTEGRATION_MODE=required but these variables are empty: ${missing.join(", ")}`);
  }
  let persistence: MongoPersistence | undefined;
  if (process.env.MONGODB_URI) {
    if (/\[|\]|\(|\)|mailto:/i.test(process.env.MONGODB_URI)) throw new Error("MONGODB_URI contains Markdown link syntax. Paste the raw mongodb+srv:// connection string only.");
    if (!process.env.MONGODB_URI.startsWith("mongodb://") && !process.env.MONGODB_URI.startsWith("mongodb+srv://")) throw new Error("MONGODB_URI must start with mongodb:// or mongodb+srv://");
    if (!process.env.ACCORD_ENCRYPTION_KEY) throw new Error("ACCORD_ENCRYPTION_KEY is required when MONGODB_URI is set");
    try { persistence = await MongoPersistence.connect(process.env.MONGODB_URI, process.env.MONGODB_DB ?? "accord", process.env.ACCORD_ENCRYPTION_KEY); }
    catch (error) {
      const mongo = error as Error & { code?: number; codeName?: string };
      const detail = String(mongo.message || "Unknown MongoDB error").replace(process.env.MONGODB_URI, "<redacted MongoDB URI>").slice(0, 800);
      process.stderr.write(`\nCould not initialize MongoDB (${mongo.codeName ?? mongo.name}${mongo.code ? `, code ${mongo.code}` : ""}).\n${detail}\n` +
        "Check the Atlas database user, URI encoding, Network Access, and collection/index permissions.\n" +
        "To run without Mongo (state in memory only), start with MONGODB_URI set to an empty value.\n\n");
      process.exit(1);
    }
  }
  const { server, state } = createApi({ persistence });
  await state.ready;
  const port = Number(process.env.PORT ?? "3000");
  server.listen(port, "0.0.0.0", () => process.stdout.write(`Accord API listening on ${port} (state: ${persistence ? "MongoDB" : "memory only"})\n`));
}
