-- LinkedIn outreach: people the owner messaged about a role, and what came of it.
-- person_key is the profile address when known, else name and company. Contacts are re-created
-- from the file on every sync, so their row IDs are not stable and are not used here.
CREATE TABLE outreach (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_key TEXT NOT NULL,
  person_name TEXT NOT NULL,
  person_url TEXT,
  company TEXT NOT NULL,
  company_key TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs (id),
  job_title TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'replied', 'referred', 'dropped')),
  sent_at TEXT NOT NULL,
  last_contact_at TEXT NOT NULL,
  followups INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (person_key, job_id)
);

CREATE INDEX idx_outreach_company ON outreach (company_key);
