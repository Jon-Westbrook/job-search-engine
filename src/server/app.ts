import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_NAME, API_VERSION } from '../shared/app.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { Logger } from './log.ts';
import { Router, sendJson } from './http/router.ts';
import { serveStatic } from './http/static.ts';
import { registerRoutes, type ApiDeps } from './api/routes.ts';
import { registerJobRoutes } from './api/jobs.ts';
import { registerExportRoutes } from './api/export.ts';

export interface AppDeps extends Omit<ApiDeps, 'db'> {
  config: Config;
  db: Db;
  logger: Logger;
  schemaVersion: number;
  rescore: (jobId: number) => Promise<void>;
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// Builds the request handler. Routes are registered here so tests can call it without
// listening on a port.
export function createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const router = new Router();
  const apiPrefix = `${deps.config.basePath}/api/${API_VERSION}`;

  registerRoutes(router, deps);
  registerExportRoutes(router, { db: deps.db, exportDir: deps.config.exportDir, logger: deps.logger, now: () => new Date() });
  registerJobRoutes(router, {
    db: deps.db,
    snapshotPath: deps.config.snapshotPath,
    rescore: deps.rescore,
    logger: deps.logger,
    aliases: deps.aliases,
    now: () => new Date(),
    lastRefreshAt: () => {
      const row = deps.db.prepare("SELECT value FROM app_meta WHERE key = 'refresh_baseline_at'").get() as { value: string } | undefined;
      return row?.value ?? null;
    },
    readerAuthor: 'owner',
    scoreVersionOf: (id) => {
      const row = deps.db.prepare('SELECT weight_profile_id FROM score_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(id) as { weight_profile_id: number } | undefined;
      return row?.weight_profile_id ?? null;
    },
  });

  router.get('/health', ({ res }) => {
    deps.db.prepare('SELECT 1').get();
    sendJson(res, 200, {
      status: 'ok',
      app: APP_NAME,
      api: API_VERSION,
      schema_version: deps.schemaVersion,
      time: new Date().toISOString(),
    });
  });

  return async (req, res) => {
    setSecurityHeaders(res);
    const host = req.headers.host ?? `${deps.config.host}:${deps.config.port}`;
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      if (deps.config.basePath && url.pathname === deps.config.basePath) {
        res.writeHead(301, { Location: `${deps.config.basePath}/` });
        res.end();
        return;
      }
      if (await router.handle(req, res, url, apiPrefix)) return;
      if (serveStatic(req, res, url.pathname, { root: deps.config.webDist, basePath: deps.config.basePath })) return;
      sendJson(res, 404, { error: 'not_found', message: 'Not found' });
    } catch (err) {
      deps.logger.error('request failed', { method: req.method, path: url.pathname, error: err });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Something went wrong. The details are in the log.' });
    }
  };
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}
