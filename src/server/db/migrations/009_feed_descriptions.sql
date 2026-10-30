-- Full descriptions can now come from a public company feed as well as pasted text.
-- SQLite cannot change a CHECK in place, so the table is rebuilt with the new source value.
CREATE TABLE job_descriptions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  text TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('pasted', 'feed')),
  created_at TEXT NOT NULL
);

INSERT INTO job_descriptions_new (id, job_id, text, fingerprint, source, created_at)
  SELECT id, job_id, text, fingerprint, source, created_at FROM job_descriptions;

DROP TABLE job_descriptions;

ALTER TABLE job_descriptions_new RENAME TO job_descriptions;

CREATE INDEX idx_job_descriptions_job ON job_descriptions (job_id);
