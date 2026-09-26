-- Public market data only: listing prices Accord observed. Never budgets, requirements, names or shares.
CREATE TABLE IF NOT EXISTS accord_price_observations (
  time TIMESTAMPTZ NOT NULL,
  offer_id TEXT NOT NULL,          -- Accord's public listing/rate identity (lite-<hotel>-<rate>, gh-<property>)
  provider TEXT NOT NULL,          -- LITEAPI | GOOGLE_HOTELS
  property_name TEXT NOT NULL,
  destination TEXT NOT NULL,       -- normalized search destination
  check_in DATE NOT NULL,
  nights SMALLINT NOT NULL CHECK (nights > 0),
  guests SMALLINT NOT NULL CHECK (guests > 0),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  refundable BOOLEAN NOT NULL,
  source TEXT NOT NULL             -- search | recheck
);
-- Small chunks so compression visibly kicks in during a hackathon weekend.
SELECT create_hypertable('accord_price_observations', 'time', chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS accord_price_offer_time ON accord_price_observations (offer_id, time DESC);
CREATE INDEX IF NOT EXISTS accord_price_destination_time ON accord_price_observations (destination, time DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'accord_price_observations' AND compression_enabled) THEN
    ALTER TABLE accord_price_observations SET (timescaledb.compress, timescaledb.compress_segmentby = 'offer_id', timescaledb.compress_orderby = 'time DESC');
  END IF;
END $$;
SELECT add_compression_policy('accord_price_observations', INTERVAL '2 hours', if_not_exists => TRUE);

-- Price per listing in 5-minute buckets; real-time so the newest observations show immediately.
CREATE MATERIALIZED VIEW IF NOT EXISTS accord_price_5m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '5 minutes', time) AS bucket, offer_id, destination, check_in, nights, guests,
  min(total_cents) AS min_cents, max(total_cents) AS max_cents, last(total_cents, time) AS last_cents, count(*) AS observations
FROM accord_price_observations
GROUP BY bucket, offer_id, destination, check_in, nights, guests
WITH NO DATA;
SELECT add_continuous_aggregate_policy('accord_price_5m', start_offset => INTERVAL '2 days', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE);

-- Hourly event counts for the consensus dashboard.
CREATE MATERIALIZED VIEW IF NOT EXISTS accord_events_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 hour', time) AS bucket, event_type, count(*) AS events
FROM accord_events
GROUP BY bucket, event_type
WITH NO DATA;
SELECT add_continuous_aggregate_policy('accord_events_hourly', start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes', if_not_exists => TRUE);
