// Usage: npm run snapshot:log -- <path-to-job-search-log> <output-file>
// Reads the log (never writes to it) and writes a structured snapshot for the server.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSnapshot } from './log-snapshot.ts';

const [logDir, outPath] = process.argv.slice(2);
if (!logDir || !outPath) {
  process.stderr.write('Usage: npm run snapshot:log -- <log-dir> <output-file>\n');
  process.exit(2);
}
const snapshot = buildSnapshot(logDir, new Date().toISOString());
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(`Wrote ${snapshot.entry_count} entries to ${outPath}\n`);
