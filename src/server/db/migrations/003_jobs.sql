-- Canonical jobs, their source postings, pasted descriptions, and append-only job events.

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  arrangement TEXT CHECK (arrangement IS NULL OR arrangement IN ('onsite', 'hybrid', 'remote')),
  company_key TEXT,
  title_key TEXT,
  location_key TEXT,
  comp_min INTEGER,
  comp_max INTEGER,
  comp_period TEXT CHECK (comp_period IS NULL OR comp_period IN ('year', 'hour')),
  comp_currency TEXT,
  comp_annualized INTEGER CHECK (comp_annualized IS NULL OR comp_annualized IN (0, 1)),
  posted_at TEXT,
  description_fingerprint TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  -- User block (brief section 12.2). Applies to this canonical job only.
  blocked_at TEXT,
  blocked_reason TEXT,
  block_scope TEXT CHECK (block_scope IS NULL OR block_scope = 'job'),
  -- Rule block (brief section 8.5). Set by the scorer, cleared only by Override and review.
  rule_blocked INTEGER NOT NULL DEFAULT 0 CHECK (rule_blocked IN (0, 1)),
  rule_block_evidence TEXT,
  rule_overridden_at TEXT,
  stage TEXT NOT NULL DEFAULT 'inbox' CHECK (stage IN ('inbox', 'analysis')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_jobs_canonical_url ON jobs (canonical_url);
CREATE INDEX idx_jobs_company_title ON jobs (company_key, title_key);

CREATE TABLE job_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  posting_id INTEGER NOT NULL REFERENCES source_postings (id),
  match_type TEXT NOT NULL CHECK (match_type IN ('origin', 'exact', 'strong', 'manual')),
  match_reason TEXT,
  created_at TEXT NOT NULL,
  split_at TEXT
);

CREATE INDEX idx_job_sources_job ON job_sources (job_id);
-- A posting belongs to at most one active job. Splits end the link with split_at.
CREATE UNIQUE INDEX idx_job_sources_active_posting ON job_sources (posting_id) WHERE split_at IS NULL;

CREATE TABLE job_descriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  text TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('pasted')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_job_descriptions_job ON job_descriptions (job_id);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  type TEXT NOT NULL CHECK (type IN (
    'created', 'merged', 'split', 'grouped', 'listing_opened', 'description_added',
    'blocked', 'block_undone', 'override', 'rule_blocked', 'rule_cleared'
  )),
  payload TEXT NOT NULL DEFAULT '{}',
  score_version INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_job_events_job ON job_events (job_id);

CREATE TRIGGER job_events_no_update BEFORE UPDATE ON job_events
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;

CREATE TRIGGER job_events_no_delete BEFORE DELETE ON job_events
BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
