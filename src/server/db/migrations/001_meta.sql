-- Key/value settings that are not part of the job model (for example, the active
-- weight profile pointer or the last completed refresh time).
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
