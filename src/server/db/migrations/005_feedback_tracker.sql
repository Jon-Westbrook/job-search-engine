-- Verdicts, factor corrections, contacts, applications, and the application event log.
-- Verdicts never change scores or weights (brief section 10).

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  verdict TEXT NOT NULL CHECK (verdict IN ('good', 'maybe', 'bad')),
  reason_tags TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  factor_correction TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_feedback_job ON feedback (job_id, id);

CREATE TRIGGER feedback_no_update BEFORE UPDATE ON feedback
BEGIN SELECT RAISE(ABORT, 'feedback is append-only'); END;

CREATE TRIGGER feedback_no_delete BEFORE DELETE ON feedback
BEGIN SELECT RAISE(ABORT, 'feedback is append-only'); END;

-- Contacts are entered only by hand. The app never infers or scrapes a contact.
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  company_key TEXT NOT NULL,
  relationship TEXT,
  channel TEXT,
  provenance TEXT,
  created_at TEXT NOT NULL,
  last_interaction TEXT
);

CREATE INDEX idx_contacts_company ON contacts (company_key);

CREATE TABLE applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs (id),
  company TEXT NOT NULL,
  company_key TEXT NOT NULL,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'applied', 'interviewing', 'rejected', 'offer')),
  stage TEXT NOT NULL DEFAULT 'analysis' CHECK (stage IN ('analysis', 'submit', 'tracked')),
  applied_at TEXT,
  source_channel TEXT,
  duplicate_reason TEXT,
  notes TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'import', 'progress')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_applications_company_title ON applications (company_key, title_key);
CREATE INDEX idx_applications_job ON applications (job_id);

CREATE TABLE application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications (id),
  type TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  note TEXT,
  score_version INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_application_events_app ON application_events (application_id, id);

CREATE TRIGGER application_events_no_update BEFORE UPDATE ON application_events
BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END;

CREATE TRIGGER application_events_no_delete BEFORE DELETE ON application_events
BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END;

-- Import records from the job-search log (read-only source). Unknown dates stay null.
CREATE TABLE imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  raw_date TEXT,
  parsed_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'uncertain')),
  application_id INTEGER REFERENCES applications (id),
  created_at TEXT NOT NULL,
  UNIQUE (source_path, source_line, content_hash)
);
