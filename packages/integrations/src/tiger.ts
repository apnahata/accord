import { Pool } from "pg";
import type { PoolConfig } from "pg";
import { z } from "zod";
import { attempt } from "./result.js";

// Deliberately narrow storage projection. No arbitrary text, member IDs or private fields.
const metadata = z.strictObject({
  offerVersion: z.string().max(80).optional(),
  totalCents: z.number().int().nonnegative().optional(),
  cancellationCode: z.enum(["FULL_CASH_REFUND", "TRAVEL_CREDIT", "NON_REFUNDABLE"]).optional(),
  available: z.boolean().optional(),
  proposalVersion: z.number().int().positive().optional(),
  foundCount: z.number().int().nonnegative().optional(),
  availableCount: z.number().int().nonnegative().optional(),
  publicPassCount: z.number().int().nonnegative().optional(),
  feasibleCount: z.number().int().nonnegative().optional(),
  recommendedCount: z.number().int().nonnegative().optional(),
  readyCount: z.number().int().nonnegative().optional(),
  memberCount: z.number().int().nonnegative().optional(),
  authorizedCount: z.number().int().nonnegative().optional(),
  // These flags MUST come from the backend material-diff function.
  materialChanged: z.boolean().optional(), priceChanged: z.boolean().optional(), termsChanged: z.boolean().optional(),
});
const event = z.strictObject({
  eventId: z.string().min(1).max(128), time: z.iso.datetime({ offset: true }),
  roomId: z.string().min(1).max(128), proposalId: z.string().max(128).optional(), offerId: z.string().max(128).optional(),
  eventType: z.enum(["MEMBER_JOINED", "CONSTRAINTS_CONFIRMED", "SOLVE_STARTED", "SOLVE_COMPLETED", "OFFER_OBSERVED", "PROPOSAL_CREATED", "MEMBER_APPROVED", "PAYMENT_AUTHORIZED", "MERCHANT_OFFER_MUTATED", "PROPOSAL_STALE", "REPLAN_STARTED", "REPLAN_COMPLETED", "BOOKING_CONFIRMED"]),
  publicMetadata: metadata, processingLatencyMs: z.number().int().nonnegative().optional(),
});
export type TigerEvent = z.infer<typeof event>;

export function createTigerPool(connectionString: string, ssl?: PoolConfig["ssl"]) {
  return new Pool({ connectionString, ssl, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000, statement_timeout: 5000 });
}

export class Tiger {
  constructor(private readonly pool?: Pick<Pool, "query">) {}
  write(input: TigerEvent) {
    return attempt("tiger", Boolean(this.pool), async () => {
      const value = event.parse(input);
      await this.pool!.query(`INSERT INTO accord_events
        (time,event_id,room_id,proposal_id,offer_id,event_type,public_metadata,processing_latency_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (time,event_id) DO NOTHING`,
      [value.time, value.eventId, value.roomId, value.proposalId ?? null, value.offerId ?? null, value.eventType, JSON.stringify(value.publicMetadata), value.processingLatencyMs ?? null]);
      return { eventId: value.eventId };
    });
  }

  /** Room ID comes from backend authorization. Explicit since excludes prior reset sessions. */
  timeline(roomId: string, since: string, limit = 200) {
    return attempt("tiger", Boolean(this.pool), async () => {
      z.iso.datetime({ offset: true }).parse(since);
      const result = await this.pool!.query(`SELECT time,event_id,proposal_id,offer_id,event_type,public_metadata,processing_latency_ms
        FROM accord_events WHERE room_id=$1 AND time >= $2 ORDER BY time DESC,event_id DESC LIMIT $3`,
      [roomId, since, Math.max(1, Math.min(500, Math.trunc(limit)))]);
      return { source: "TIGER" as const, events: result.rows.reverse() };
    });
  }

  stability(roomId: string, since: string) {
    return attempt("tiger", Boolean(this.pool), async () => {
      z.iso.datetime({ offset: true }).parse(since);
      const result = await this.pool!.query(`SELECT offer_id,
        COUNT(*)::int AS observation_count,
        COUNT(*) FILTER (WHERE event_type='MERCHANT_OFFER_MUTATED' AND public_metadata->>'materialChanged'='true')::int AS material_change_count,
        COUNT(*) FILTER (WHERE event_type='MERCHANT_OFFER_MUTATED' AND public_metadata->>'priceChanged'='true')::int AS price_change_count,
        COUNT(*) FILTER (WHERE event_type='MERCHANT_OFFER_MUTATED' AND public_metadata->>'termsChanged'='true')::int AS terms_change_count
        FROM accord_events WHERE room_id=$1 AND time >= $2 AND offer_id IS NOT NULL
          AND event_type IN ('OFFER_OBSERVED','MERCHANT_OFFER_MUTATED') GROUP BY offer_id`, [roomId, since]);
      return result.rows.map(row => ({
        offerId: String(row.offer_id), observationCount: Number(row.observation_count),
        materialChangeCount: Number(row.material_change_count), priceChangeCount: Number(row.price_change_count), termsChangeCount: Number(row.terms_change_count),
        label: Number(row.material_change_count) === 0 ? "STABLE" as const : Number(row.material_change_count) === 1 ? "MIXED" as const : "VOLATILE" as const,
        scope: "Observed stability during this planning session" as const,
      }));
    });
  }

  priceHistory(roomId: string, offerId: string, since: string) {
    return attempt("tiger", Boolean(this.pool), async () => {
      z.iso.datetime({ offset: true }).parse(since);
      return (await this.pool!.query(`SELECT time,event_id,event_type,proposal_id,
        (public_metadata->>'totalCents')::bigint AS total_cents,
        public_metadata->>'offerVersion' AS offer_version
        FROM accord_events WHERE room_id=$1 AND offer_id=$2 AND time >= $3
          AND public_metadata ? 'totalCents' ORDER BY time,event_id LIMIT 1000`, [roomId, offerId, since])).rows;
    });
  }

  latencies(roomId: string, since: string) {
    return attempt("tiger", Boolean(this.pool), async () => {
      z.iso.datetime({ offset: true }).parse(since);
      return (await this.pool!.query(`SELECT time,event_type,proposal_id,processing_latency_ms FROM accord_events
        WHERE room_id=$1 AND time >= $2 AND processing_latency_ms IS NOT NULL
        ORDER BY time,event_id LIMIT 1000`, [roomId, since])).rows;
    });
  }
}
