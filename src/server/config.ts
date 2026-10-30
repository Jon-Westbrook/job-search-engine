import { resolve } from 'node:path';

export interface Config {
  host: string;
  port: number;
  basePath: string;
  dataDir: string;
  dbPath: string;
  exportDir: string;
  webDist: string;
  profilePath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  gog: { bin: string; account: string };
  codex: { bin: string; model: string; reasoningEffort: string; timeoutMs: number; rulesOnly: boolean };
  sourcesPath: string;
  aliasesPath: string;
  snapshotPath: string;
  scoreMaxPerRefresh: number;
  targetsPath: string;
  contactsPath: string;
  feedsPath: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Reads configuration from the environment. Secrets such as GOG_KEYRING_PASSWORD are
// read here and passed to child processes only. They are never logged or exported.
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const host = env.HOST || '127.0.0.1';
  // Brief section 2 and section 4: the server binds to loopback only. Tailnet exposure
  // happens through the private HTTPS proxy in front of it, never through a public bind.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`HOST must be a loopback address. Refusing to bind to ${host}.`);
  }
  const dataDir = resolve(cwd, env.DATA_DIR || 'data');
  const basePath = normalizeBasePath(env.BASE_PATH || '');
  const port = Number(env.PORT || 3460);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT is not a valid port: ${env.PORT}`);
  }
  return {
    host,
    port,
    basePath,
    dataDir,
    dbPath: resolve(dataDir, 'job-search.sqlite'),
    exportDir: resolve(cwd, env.EXPORT_DIR || 'exports'),
    webDist: resolve(cwd, env.WEB_DIST || 'dist/web'),
    profilePath: resolve(cwd, env.PROFILE_PATH || 'config/profile.json'),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    gog: {
      bin: env.GOG_BIN || 'gog',
      account: env.GOG_ACCOUNT || '',
    },
    codex: {
      bin: env.CODEX_BIN || 'codex',
      model: env.CODEX_MODEL || 'gpt-6-luna',
      reasoningEffort: env.CODEX_REASONING_EFFORT || 'medium',
      timeoutMs: Number(env.CODEX_TIMEOUT_MS || 180_000),
      rulesOnly: env.SCORE_RULES_ONLY === '1',
    },
    sourcesPath: resolve(cwd, 'config/sources.json'),
    aliasesPath: resolve(cwd, 'config/company_aliases.json'),
    snapshotPath: resolve(cwd, env.LOG_SNAPSHOT_PATH || 'data/job-log-snapshot.json'),
    scoreMaxPerRefresh: parseLimit(env.SCORE_MAX_PER_REFRESH),
    targetsPath: resolve(cwd, env.TARGETS_PATH || 'config/targets.local.json'),
    contactsPath: resolve(cwd, env.CONTACTS_PATH || 'config/contacts.local.json'),
    feedsPath: resolve(cwd, env.FEEDS_PATH || 'config/feeds.json'),
  };
}

// '/job-search/' and 'job-search' both become '/job-search'. Empty means the root.
export function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

// AI scoring is capped per refresh so a daily refresh cannot make hundreds of calls.
// Newest jobs are scored first. The rest wait for later refreshes.
function parseLimit(raw: string | undefined): number {
  const n = Number(raw ?? 50);
  return Number.isInteger(n) && n >= 1 ? n : 50;
}

function parseLogLevel(raw: string | undefined): Config['logLevel'] {
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}
