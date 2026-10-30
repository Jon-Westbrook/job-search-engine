-- Target companies, synced from config/targets.local.json at startup and on each refresh.
-- Matching uses the same company key as jobs, so a job at a target gets the Target tag.
CREATE TABLE targets (
  company_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_name TEXT,
  updated_at TEXT NOT NULL
);
