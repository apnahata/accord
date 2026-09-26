-- Execute on the actual Tiger service with a migration identity.
-- Event ID is a backend outbox ID. Retried delivery keeps both ID and timestamp.
CREATE TABLE IF NOT EXISTS accord_events (
  time TIMESTAMPTZ NOT NULL,
  event_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  proposal_id TEXT,
  offer_id TEXT,
  event_type TEXT NOT NULL,
  public_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  processing_latency_ms INTEGER CHECK (processing_latency_ms >= 0),
  PRIMARY KEY (time, event_id)
);
SELECT create_hypertable('accord_events', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS accord_events_room_time ON accord_events (room_id, time DESC, event_id);
CREATE INDEX IF NOT EXISTS accord_events_offer_time ON accord_events (room_id, offer_id, time DESC);
