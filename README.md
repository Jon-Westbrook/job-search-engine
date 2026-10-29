# AUTOJOB (job-search-engine)

Local-first triage for LinkedIn job alerts. The app reads alert emails through a read-only Gmail wrapper, groups duplicate listings, scores each job with explainable rules, and shows a ranked Inbox. You record a verdict, open the listing, block a job, or progress it to a saved application. AUTOJOB is a placeholder name. It lives in one constant (`src/shared/app.ts`).

Status: Phase 1A, in build. Single user. No accounts, no login screen. Served only on a private network.

## What it does not do

- It never requests `linkedin.com`. "Open listing" opens the stored URL in a new tab only when you click it.
- It never applies, fills forms, or sends email.
- It never modifies Gmail. It never labels, archives, trashes, or marks messages read.
- It never refreshes on launch or on a timer. Refresh is manual.
- Verdicts never change scores or weights. Weights are edited by hand and each edit creates a new version.

## Architecture

- **Server:** Node 24 (22.13 or later), TypeScript, `node:http`, SQLite through the built-in `node:sqlite`. No native dependencies.
- **Web:** React and Vite. The design tokens live in `src/web/styles/tokens.css`.
- **Gmail:** the installed Gog CLI through an allowlisted wrapper (`src/server/gog/`). Read-only subcommands only.
- **Scoring:** AI extracts factor values with evidence through the installed Codex CLI, with a strict JSON schema. Deterministic rules compute the score. A rules-only mode runs without AI.
- **Process:** a systemd user service. The server binds to `127.0.0.1` only. The private HTTPS proxy in front of it provides the tailnet URL. There is no public port.

### Deviations from the build brief

These are recorded here and in the local deviations log.

1. Node 24 instead of Node 22. The host runs Node 24 for every app on it. Node 22.13 or later still works.
2. Gog flags. `--readonly` and `--gmail-no-send` are not valid for `gog gmail search`, `gog gmail get`, or `gog gmail labels list` in Gog 0.11.x. Read-only is enforced by a subcommand allowlist in the wrapper, plus `--no-input` on every call.
3. Schema addition. `job_events` is an append-only log for job actions (block, undo, override, listing opened, merge, split). The brief lists the other tables.

## Run it locally

```sh
npm install
cp .env.example .env          # optional; set values as needed
npm run build
npm start                     # http://127.0.0.1:3460/
npm run dev:web               # Vite dev server with /api proxied to the server
```

Run tests with `npm test`. Run the secret scan before every push with `npm run scan:secrets`.

## Configuration

- `config/sources.json`: Gmail queries for job-alert senders, versioned.
- `config/company_aliases.json`: committed aliases. Put personal aliases in `config/company_aliases.local.json` (gitignored).
- `config/profile.json`: personal profile (status, targets, resume summary). Gitignored. Start from `config/profile.example.json`.
- `.env`: environment values. Gitignored. Start from `.env.example`.

Secrets such as the Gog keyring password are read from the environment only. They are never logged, stored in SQLite, or written to exports.

## Security

- Loopback bind is enforced in code. Any non-loopback `HOST` fails at startup.
- Writes must be JSON and must not come from a cross-site origin.
- Logs redact secret-named fields, emails, phone numbers, bearer tokens, and OAuth redirect URLs.
- Untrusted text (alert bodies, pasted descriptions) is treated as data. It is delimited in prompts and validated against a strict schema. It cannot change a score.
- The export never includes tokens, cookies, raw email bodies, or the database file.

## Tracker import (optional)

The Tracker can import applications from a private job-search log. The app never writes to the log.

1. On the machine that holds the log, make a snapshot. The snapshot keeps structured fields only and no narrative text or contact names:

   ```sh
   npm run snapshot:log -- <path-to-log> data/job-log-snapshot.json
   ```

2. Copy the snapshot to the server and set `LOG_SNAPSHOT_PATH` to its location.
3. Open the Tracker, review the plan, then confirm the import. Uncertain records (approximate or missing dates, unclear statuses, generic titles) are flagged and never guessed. Re-running the import adds nothing new.

## Development notes

- Migrations live in `src/server/db/migrations/`. Every schema change gets a new file.
- Event tables (`job_events`, `feedback`, `application_events`) are append-only, enforced by triggers.
- Stable IDs are integers and are exported as-is.
- Timestamps are stored in UTC and displayed in America/New_York.

## License

MIT. See LICENSE.
