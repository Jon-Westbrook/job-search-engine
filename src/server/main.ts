import { createServer } from 'node:http';
import { APP_NAME } from '../shared/app.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { migrate, openDatabase, loadMigrations } from './db/index.ts';
import { createLogger } from './log.ts';
import { createGogRunner } from './gog/wrapper.ts';
import { loadProfile, effectiveGmailAccount } from './profile.ts';
import { loadSources } from './sources.ts';
import { seedSources } from './ingest/store.ts';
import { RefreshService } from './refresh.ts';
import { loadAliases } from './normalize/aliases.ts';
import { createCodexRunner } from './score/codex.ts';
import { seedWeightProfile } from './score/profile.ts';
import { loadTargetFile, syncContactsFromFile, syncTargets } from './lists.ts';
import { loadFeeds } from './ingest/feeds.ts';
import { scoreJob } from './score/service.ts';

const config = loadConfig();
const logger = createLogger(config.logLevel, { app: APP_NAME });

const db = openDatabase(config.dbPath);
const applied = migrate(db);
const migrations = loadMigrations();
const schemaVersion = migrations.at(-1)?.version ?? 0;
if (applied.length > 0) logger.info('migrations applied', { applied });

const profile = loadProfile(config.profilePath);
const gmailAccount = effectiveGmailAccount(process.env, profile);
const sources = loadSources(config.sourcesPath);
seedSources(db, sources, new Date().toISOString());
const runner = createGogRunner({
  bin: config.gog.bin,
  account: gmailAccount,
  keyringPassword: process.env.GOG_KEYRING_PASSWORD || undefined,
});
const aliases = loadAliases(config.aliasesPath, config.aliasesPath.replace(/\.json$/, '.local.json'));
seedWeightProfile(db, new Date().toISOString());
// The personal lists load at startup and again on each refresh.
const syncLists = (): void => {
  const nowIso = new Date().toISOString();
  const targets = syncTargets(db, loadTargetFile(config.targetsPath), aliases, nowIso);
  const contacts = syncContactsFromFile(db, config.contactsPath, aliases, nowIso);
  logger.info('personal lists synced', { targets, contacts });
};
syncLists();
const codex = createCodexRunner({
  bin: config.codex.bin,
  model: config.codex.model,
  reasoningEffort: config.codex.reasoningEffort,
  timeoutMs: config.codex.timeoutMs,
});
const profileForScoring = profile;
const scoring = { db, codex, logger, now: () => new Date(), aliases, profile: profileForScoring };
const refresh = new RefreshService({ db, runner, logger, aliases, scoring, rulesOnly: config.codex.rulesOnly, scoreLimit: config.scoreMaxPerRefresh, syncLists, feeds: loadFeeds(config.feedsPath), acceptedGeography: profile.targets?.accepted_geography ?? [] }, sources);

const rescore = async (jobId: number): Promise<void> => {
  const aiAvailable = !config.codex.rulesOnly && (await codex.status()).available;
  await scoreJob(scoring, jobId, aiAvailable);
};
const handler = createApp({ config, db, logger, schemaVersion, runner, refresh, sources, gmailAccount, codex, codexBin: config.codex.bin, aliases, rescore });
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
