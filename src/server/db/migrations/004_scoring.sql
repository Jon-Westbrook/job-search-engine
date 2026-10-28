-- Scoring. Weight profiles are versioned. Every score run records the version it used.
-- Score runs and factors are append-only. A rescore inserts a new run.

CREATE TABLE weight_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  weights TEXT NOT NULL,
  rules TEXT NOT NULL,
  author TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

CREATE TABLE score_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  weight_profile_id INTEGER NOT NULL REFERENCES weight_profiles (id),
  mode TEXT NOT NULL CHECK (mode IN ('ai', 'rules_only')),
  prompt_version TEXT,
  extractor_model TEXT,
  reasoning_effort TEXT,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  rule_blocked INTEGER NOT NULL DEFAULT 0 CHECK (rule_blocked IN (0, 1)),
  flags TEXT NOT NULL DEFAULT '[]',
  missing TEXT NOT NULL DEFAULT '[]',
  extraction TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_score_runs_job ON score_runs (job_id, id);

CREATE TABLE score_factors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score_run_id INTEGER NOT NULL REFERENCES score_runs (id) ON DELETE CASCADE,
  factor TEXT NOT NULL,
  ai_value TEXT,
  points REAL NOT NULL,
  max REAL NOT NULL,
  evidence_excerpt TEXT,
  source_field TEXT,
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low'))
);

CREATE INDEX idx_score_factors_run ON score_factors (score_run_id);
