import { createServer } from 'node:http';
import { APP_NAME } from '../shared/app.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { migrate, openDatabase, loadMigrations } from './db/index.ts';
import { createLogger } from './log.ts';

const config = loadConfig();
const logger = createLogger(config.logLevel, { app: APP_NAME });

const db = openDatabase(config.dbPath);
const applied = migrate(db);
const migrations = loadMigrations();
const schemaVersion = migrations.at(-1)?.version ?? 0;
if (applied.length > 0) logger.info('migrations applied', { applied });

const handler = createApp({ config, db, logger, schemaVersion });
const server = createServer((req, res) => {
  void handler(req, res);
});

server.listen(config.port, config.host, () => {
  logger.info('listening', {
    host: config.host,
    port: config.port,
    base_path: config.basePath || '/',
    schema_version: schemaVersion,
  });
});

// Graceful shutdown for systemd stop and Ctrl+C.
function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
