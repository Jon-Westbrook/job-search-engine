import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Migrations are plain SQL files named NNN_name.sql. They run in order, once each,
// inside a transaction. Every schema change goes in a new file (brief section 15).
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(file);
      if (!match) throw new Error(`Bad migration name: ${file}`);
      return { version: Number(match[1]), name: match[2] ?? file, sql: readFileSync(join(dir, file), 'utf8') };
    });
}

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

export function migrate(db: Db, migrations: Migration[] = loadMigrations()): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  );
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      ran.push(`${String(m.version).padStart(3, '0')}_${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`);
    }
  }
  return ran;
}

export function nowIso(): string {
  return new Date().toISOString();
}
