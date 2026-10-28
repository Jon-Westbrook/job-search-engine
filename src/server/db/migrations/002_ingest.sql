-- Gmail ingestion: source configuration, durable cursors, sync runs, and source postings.
-- One source posting is one job listing observed in one alert email. An alert email can
-- hold several listings (digests), so postings are keyed by the provider's job ID.

CREATE TABLE source_configs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('gmail')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  query TEXT NOT NULL,
  overlap_days INTEGER NOT NULL DEFAULT 3,
  initial_lookback_days INTEGER NOT NULL DEFAULT 60,
  parser_version TEXT NOT NULL,
  -- Newest processed message time (UTC). Re-read with overlap on every run.
  cursor_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES source_configs(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  cursor_before TEXT,
  cursor_after TEXT,
  counts TEXT NOT NULL DEFAULT '{}',
  errors TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE source_postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  source_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  arrangement TEXT CHECK (arrangement IS NULL OR arrangement IN ('onsite', 'hybrid', 'remote')),
  posted_at TEXT,
  alert_received_at TEXT NOT NULL,
  pay_min INTEGER,
  pay_max INTEGER,
  pay_currency TEXT,
  pay_period TEXT CHECK (pay_period IS NULL OR pay_period IN ('year', 'hour')),
  pay_annualized INTEGER CHECK (pay_annualized IS NULL OR pay_annualized IN (0, 1)),
  applicant_count INTEGER,
  easy_apply INTEGER CHECK (easy_apply IS NULL OR easy_apply IN (1)),
  connection_hint TEXT NOT NULL DEFAULT '{}',
  raw_fields TEXT NOT NULL DEFAULT '{}',
  raw_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE (provider, source_id)
);

CREATE INDEX idx_source_postings_message ON source_postings (message_id);
