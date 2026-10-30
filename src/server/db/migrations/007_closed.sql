-- Jobs that LinkedIn has closed. "Closed" is separate from a block: a closed job keeps its
-- history and reopens automatically if a newer alert shows it again.
ALTER TABLE jobs ADD COLUMN closed_at TEXT;
ALTER TABLE jobs ADD COLUMN closed_reason TEXT;

-- job_events has a fixed list of types. SQLite cannot change a CHECK in place, so the table is
-- rebuilt with the two new types, its rows copied, and its append-only triggers recreated.
DROP TRIGGER job_events_no_update;
DROP TRIGGER job_events_no_delete;
DROP INDEX idx_job_events_job;
ALTER TABLE job_events RENAME TO job_events_old;

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  type TEXT NOT NULL CHECK (type IN (
    'created', 'merged', 'split', 'grouped', 'listing_opened', 'description_added',
    'blocked', 'block_undone', 'override', 'rule_blocked', 'rule_cleared', 'closed', 'reopened'
  )),
  payload TEXT NOT NULL DEFAULT '{}',
  score_version INTEGER,
  created_at TEXT NOT NULL
);

INSERT INTO job_events (id, job_id, type, payload, score_version, created_at)
  SELECT id, job_id, type, payload, score_version, created_at FROM job_events_old;

DROP TABLE job_events_old;

CREATE INDEX idx_job_events_job ON job_events (job_id);

CREATE TRIGGER job_events_no_update BEFORE UPDATE ON job_events
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;

CREATE TRIGGER job_events_no_delete BEFORE DELETE ON job_events
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
