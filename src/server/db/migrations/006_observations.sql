-- Every time an alert email shows a listing, that is one observation. Provenance is kept
-- for each one, so a re-alert adds a row here and never overwrites an earlier message ID.

CREATE TABLE posting_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_id INTEGER NOT NULL REFERENCES source_postings (id),
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  alert_received_at TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE (posting_id, message_id)
);

CREATE INDEX idx_posting_observations_posting ON posting_observations (posting_id);

CREATE TRIGGER posting_observations_no_update BEFORE UPDATE ON posting_observations
BEGIN SELECT RAISE(ABORT, 'posting_observations is append-only'); END;

CREATE TRIGGER posting_observations_no_delete BEFORE DELETE ON posting_observations
BEGIN SELECT RAISE(ABORT, 'posting_observations is append-only'); END;
