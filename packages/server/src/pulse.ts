import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { PulseDTO, Trip } from "@accord/domain";

/**
 * Tiger Data (TimescaleDB) market + process telemetry.
 * Stores public listing prices and anonymous event types only: never budgets, requirements, names or shares.
 * Writes are buffered and best-effort; nothing in the booking flow waits on Tiger.
 */
export type PriceObservation = {
  offerId: string; provider: "LITEAPI" | "GOOGLE_HOTELS"; propertyName: string;
  trip: Pick<Trip, "destination" | "checkIn" | "checkOut" | "guests">; totalCents: number; refundable: boolean; source: "search" | "recheck";
};
export type OfferStability = {
  observationCount: number; materialChangeCount: number; label: "STABLE" | "MIXED" | "VOLATILE";
  minCents: number; maxCents: number; history: Array<{ at: string; totalCents: number }>;
};

const normalize = (destination: string) => destination.trim().toLowerCase().replace(/\s+/g, " ");
const nights = (trip: Pick<Trip, "checkIn" | "checkOut">) => Math.max(1, Math.round((Date.parse(trip.checkOut) - Date.parse(trip.checkIn)) / 86_400_000));
const roomKey = (roomId: string) => createHash("sha256").update(`accord-room:${roomId}`).digest("hex").slice(0, 24);
const num = (value: unknown) => value === null || value === undefined ? undefined : Number(value);
const ACTIVITY: Record<string, string> = {
  MEMBER_JOINED: "joined", CONSTRAINTS_CONFIRMED: "confirmed", SEARCH_STARTED: "searches", PROPOSAL_CREATED: "proposals",
  MEMBER_APPROVED: "approvals", PROPOSAL_STALE: "stale", BOOKING_CONFIRMED: "booked", BOOKING_HANDOFF: "booked",
};

export class Pulse {
  #prices: PriceObservation[] = [];
  #priceTimes: string[] = [];
  #events: unknown[][] = [];
  #timer?: NodeJS.Timeout;
  #flushing: Promise<void> = Promise.resolve();
  lastError?: string;

  constructor(private readonly pool: Pick<Pool, "query">, private readonly flushDelayMs = 1500) {}

  async ping() { try { await this.pool.query("SELECT 1"); return true; } catch { return false; } }

  observe(rows: PriceObservation[]) {
    const at = new Date().toISOString();
    // Several provider rates can map to one Accord listing; keep the cheapest per listing per observation.
    const cheapest = new Map<string, PriceObservation>();
    for (const row of rows) { const seen = cheapest.get(row.offerId); if (!seen || row.totalCents < seen.totalCents) cheapest.set(row.offerId, row); }
    for (const row of cheapest.values()) { this.#prices.push(row); this.#priceTimes.push(at); }
    this.#schedule();
  }

  event(input: { type: string; roomId: string; proposalId?: string; offerId?: string; latencyMs?: number; metadata?: Record<string, number | boolean | string> }) {
    this.#events.push([new Date().toISOString(), randomUUID(), roomKey(input.roomId), input.proposalId ?? null, input.offerId ?? null,
      input.type.slice(0, 64), JSON.stringify(input.metadata ?? {}), input.latencyMs === undefined ? null : Math.max(0, Math.round(input.latencyMs))]);
    this.#schedule();
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.flush(); }, this.flushDelayMs);
    this.#timer.unref?.();
  }

  flush() {
    const prices = this.#prices.splice(0), times = this.#priceTimes.splice(0), events = this.#events.splice(0);
    this.#flushing = this.#flushing.then(async () => {
      try {
        if (prices.length) await this.pool.query(`INSERT INTO accord_price_observations
          (time, offer_id, provider, property_name, destination, check_in, nights, guests, total_cents, refundable, source)
          SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::date[], $7::smallint[], $8::smallint[], $9::bigint[], $10::bool[], $11::text[])`, [
          times, prices.map(p => p.offerId), prices.map(p => p.provider), prices.map(p => p.propertyName.slice(0, 160)),
          prices.map(p => normalize(p.trip.destination)), prices.map(p => p.trip.checkIn), prices.map(p => nights(p.trip)), prices.map(p => p.trip.guests),
          prices.map(p => p.totalCents), prices.map(p => p.refundable), prices.map(p => p.source)]);
        for (const row of events) await this.pool.query(`INSERT INTO accord_events
          (time, event_id, room_id, proposal_id, offer_id, event_type, public_metadata, processing_latency_ms)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (time, event_id) DO NOTHING`, row);
        this.lastError = undefined;
      } catch (error) { this.lastError = String((error as Error).message).slice(0, 200); }
    });
    return this.#flushing;
  }

  /** Observed price stability per listing for this exact trip (dates + guests), over the last 24 hours. */
  async stability(trip: Trip, offerIds: string[]): Promise<Map<string, OfferStability>> {
    const result = new Map<string, OfferStability>();
    if (!offerIds.length) return result;
    const scope = [offerIds, trip.checkIn, nights(trip), trip.guests];
    const [summary, history] = await Promise.all([
      this.pool.query(`WITH obs AS (
          SELECT offer_id, total_cents, lag(total_cents) OVER (PARTITION BY offer_id ORDER BY time) AS prev
          FROM accord_price_observations
          WHERE offer_id = ANY($1) AND check_in = $2 AND nights = $3 AND guests = $4 AND time > now() - INTERVAL '24 hours')
        SELECT offer_id, count(*)::int AS observations, count(*) FILTER (WHERE prev IS NOT NULL AND prev <> total_cents)::int AS changes,
          min(total_cents)::bigint AS min_cents, max(total_cents)::bigint AS max_cents
        FROM obs GROUP BY offer_id`, scope),
      this.pool.query(`SELECT offer_id, bucket, last_cents FROM accord_price_5m
        WHERE offer_id = ANY($1) AND check_in = $2 AND nights = $3 AND guests = $4 AND bucket > now() - INTERVAL '12 hours'
        ORDER BY offer_id, bucket`, scope),
    ]);
    const points = new Map<string, Array<{ at: string; totalCents: number }>>();
    for (const row of history.rows) {
      const list = points.get(row.offer_id) ?? []; list.push({ at: new Date(row.bucket).toISOString(), totalCents: Number(row.last_cents) }); points.set(row.offer_id, list);
    }
    for (const row of summary.rows) {
      const changes = Number(row.changes);
      result.set(row.offer_id, { observationCount: Number(row.observations), materialChangeCount: changes,
        label: changes === 0 ? "STABLE" : changes <= 2 ? "MIXED" : "VOLATILE",
        minCents: Number(row.min_cents), maxCents: Number(row.max_cents), history: points.get(row.offer_id) ?? [] });
    }
    return result;
  }

  /** How many live prices Accord has checked for this room's exact trip (destination/dates/guests), across every listing considered. Room-scoped, still anonymous. */
  async roomActivity(trip: Trip): Promise<{ observations: number; listings: number }> {
    const row = (await this.pool.query(`SELECT count(*)::bigint AS observations, count(DISTINCT offer_id)::int AS listings
      FROM accord_price_observations WHERE destination = $1 AND check_in = $2 AND nights = $3 AND guests = $4`,
      [normalize(trip.destination), trip.checkIn, nights(trip), trip.guests])).rows[0] ?? {};
    return { observations: Number(row.observations ?? 0), listings: Number(row.listings ?? 0) };
  }

  async offerHistory(trip: Trip, offerId: string) {
    const rows = (await this.pool.query(`SELECT bucket, last_cents FROM accord_price_5m
      WHERE offer_id = $1 AND check_in = $2 AND nights = $3 AND guests = $4 AND bucket > now() - INTERVAL '24 hours' ORDER BY bucket`,
      [offerId, trip.checkIn, nights(trip), trip.guests])).rows;
    return rows.map(row => ({ at: new Date(row.bucket).toISOString(), totalCents: Number(row.last_cents) }));
  }

  /** Public, anonymous dashboard: market prices, storage/compression, and how groups reach consensus. */
  async dashboard(): Promise<PulseDTO> {
    const started = performance.now();
    const q = (sql: string) => this.pool.query(sql).then(result => result.rows);
    const [totals, providers, storage, size, markets, movers, consensus, replan, activity] = await Promise.all([
      q(`SELECT count(*)::bigint AS observations, count(DISTINCT offer_id)::int AS listings, count(DISTINCT destination)::int AS destinations, min(time) AS first FROM accord_price_observations`),
      q(`SELECT provider, count(*)::bigint AS n FROM accord_price_observations GROUP BY provider`),
      q(`SELECT * FROM hypertable_compression_stats('accord_price_observations')`),
      q(`SELECT hypertable_size('accord_price_observations')::bigint AS bytes`),
      q(`WITH top AS (SELECT destination FROM accord_price_5m WHERE bucket > now() - INTERVAL '24 hours' GROUP BY destination ORDER BY sum(observations) DESC LIMIT 4)
         SELECT destination, time_bucket(INTERVAL '30 minutes', bucket) AS at, avg(last_cents::float8 / nights)::bigint AS nightly
         FROM accord_price_5m WHERE bucket > now() - INTERVAL '24 hours' AND destination IN (SELECT destination FROM top)
         GROUP BY destination, at ORDER BY destination, at`),
      q(`WITH obs AS (SELECT offer_id, property_name, destination, check_in, nights, guests, time, total_cents,
           lag(total_cents) OVER (PARTITION BY offer_id, check_in, nights, guests ORDER BY time) AS prev
           FROM accord_price_observations WHERE time > now() - INTERVAL '24 hours')
         SELECT offer_id, max(property_name) AS property_name, max(destination) AS destination,
           count(*) FILTER (WHERE prev IS NOT NULL AND prev <> total_cents)::int AS changes,
           min(total_cents)::bigint AS min_cents, max(total_cents)::bigint AS max_cents, last(total_cents, time)::bigint AS latest
         FROM obs GROUP BY offer_id, check_in, nights, guests HAVING count(*) FILTER (WHERE prev IS NOT NULL AND prev <> total_cents) > 0
         ORDER BY changes DESC, max(total_cents) - min(total_cents) DESC LIMIT 6`),
      q(`WITH p AS (SELECT proposal_id,
           min(time) FILTER (WHERE event_type = 'PROPOSAL_CREATED') AS created,
           min(time) FILTER (WHERE event_type = 'PROPOSAL_READY') AS ready,
           bool_or(event_type = 'PROPOSAL_STALE') AS stale,
           bool_or(event_type IN ('BOOKING_CONFIRMED','BOOKING_HANDOFF')) AS booked
         FROM accord_events WHERE proposal_id IS NOT NULL AND time > now() - INTERVAL '7 days' GROUP BY proposal_id)
         SELECT count(*) FILTER (WHERE created IS NOT NULL)::int AS proposals, count(ready)::int AS ready,
           count(*) FILTER (WHERE stale)::int AS stale, count(*) FILTER (WHERE booked)::int AS booked,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ready - created) / 60) FILTER (WHERE ready IS NOT NULL AND created IS NOT NULL) AS minutes_to_ready,
           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY processing_latency_ms) FROM accord_events
              WHERE event_type = 'STALE_DETECTED' AND processing_latency_ms IS NOT NULL AND time > now() - INTERVAL '7 days') AS detection_ms
         FROM p`),
      q(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM n.time - s.time)) AS seconds
         FROM accord_events s JOIN LATERAL (SELECT time FROM accord_events n WHERE n.room_id = s.room_id AND n.event_type = 'PROPOSAL_CREATED' AND n.time > s.time ORDER BY n.time LIMIT 1) n ON TRUE
         WHERE s.event_type = 'PROPOSAL_STALE' AND s.time > now() - INTERVAL '7 days'`),
      q(`SELECT bucket, event_type, events::int FROM accord_events_hourly WHERE bucket > now() - INTERVAL '24 hours' ORDER BY bucket`),
    ]);
    const stats = storage[0] ?? {};
    const before = Number(stats.before_compression_total_bytes ?? 0), after = Number(stats.after_compression_total_bytes ?? 0);
    const byMarket = new Map<string, Array<{ at: string; nightlyCents: number }>>();
    for (const row of markets) { const list = byMarket.get(row.destination) ?? []; list.push({ at: new Date(row.at).toISOString(), nightlyCents: Number(row.nightly) }); byMarket.set(row.destination, list); }
    const buckets = new Map<string, Record<string, number>>();
    for (const row of activity) {
      const key = ACTIVITY[row.event_type]; if (!key) continue;
      const at = new Date(row.bucket).toISOString(), counts = buckets.get(at) ?? {};
      counts[key] = (counts[key] ?? 0) + Number(row.events); buckets.set(at, counts);
    }
    const c = consensus[0] ?? {};
    return {
      source: "TIGER", queryMs: Math.round(performance.now() - started), generatedAt: new Date().toISOString(),
      totals: { observations: Number(totals[0]?.observations ?? 0), listings: Number(totals[0]?.listings ?? 0), destinations: Number(totals[0]?.destinations ?? 0),
        ...(totals[0]?.first ? { firstObservedAt: new Date(totals[0].first).toISOString() } : {}),
        byProvider: Object.fromEntries(providers.map(row => [row.provider, Number(row.n)])) },
      storage: { totalBytes: Number(size[0]?.bytes ?? 0), chunks: Number(stats.total_chunks ?? 0), compressedChunks: Number(stats.number_compressed_chunks ?? 0),
        beforeBytes: before, afterBytes: after, ...(before > 0 && after > 0 ? { ratio: 1 - after / before } : {}) },
      markets: [...byMarket].map(([destination, points]) => ({ destination, points })),
      movers: movers.map(row => ({ offerId: row.offer_id, propertyName: row.property_name, destination: row.destination, changes: Number(row.changes),
        minCents: Number(row.min_cents), maxCents: Number(row.max_cents), latestCents: Number(row.latest) })),
      consensus: { proposals: Number(c.proposals ?? 0), ready: Number(c.ready ?? 0), stale: Number(c.stale ?? 0), booked: Number(c.booked ?? 0),
        ...(num(c.minutes_to_ready) !== undefined ? { medianMinutesToReady: num(c.minutes_to_ready) } : {}),
        ...(num(replan[0]?.seconds) !== undefined ? { medianSecondsStaleToReplan: num(replan[0]?.seconds) } : {}),
        ...(num(c.detection_ms) !== undefined ? { medianStaleDetectionMs: num(c.detection_ms) } : {}) },
      activity: [...buckets].map(([at, counts]) => ({ at, counts })),
    };
  }
}
