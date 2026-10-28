import { APP_NAME } from '../../shared/app.ts';
import type { Db } from '../db/index.ts';
import type { GogRunner } from '../gog/wrapper.ts';
import { finishGmailAuth, gmailHealth, startGmailAuth } from '../gog/setup.ts';
import { HttpError, type Router, sendJson } from '../http/router.ts';
import type { RefreshService } from '../refresh.ts';
import type { SourceConfig } from '../sources.ts';

export interface ApiDeps {
  db: Db;
  runner: GogRunner;
  refresh: RefreshService;
  sources: SourceConfig[];
  gmailAccount: string;
}

// Registers the API routes. Paths are relative to the API prefix.
export function registerRoutes(router: Router, deps: ApiDeps): void {
  router.get('/status', ({ res }) => {
    sendJson(res, 200, {
      app: APP_NAME,
      refresh: deps.refresh.status(),
      gmail_account_configured: Boolean(deps.gmailAccount),
    });
  });

  router.post('/refresh', ({ res }) => {
    const started = deps.refresh.start();
    if (!started) throw new HttpError(409, 'A refresh is already running', 'conflict');
    sendJson(res, 202, { started: true });
  });

  router.get('/refresh', ({ res }) => {
    sendJson(res, 200, deps.refresh.status());
  });

  router.get('/sources', ({ res }) => {
    const rows = deps.db
      .prepare(
        `SELECT s.id, s.enabled, s.overlap_days, s.initial_lookback_days, s.cursor_at, s.parser_version,
                (SELECT status FROM sync_runs r WHERE r.source_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_status,
                (SELECT counts FROM sync_runs r WHERE r.source_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_counts,
                (SELECT finished_at FROM sync_runs r WHERE r.source_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_finished_at
         FROM source_configs s ORDER BY s.id`,
      )
      .all() as Array<Record<string, unknown>>;
    sendJson(res, 200, {
      sources: rows.map((r) => ({ ...r, last_counts: r.last_counts ? JSON.parse(String(r.last_counts)) : null })),
      configured: deps.sources.length,
    });
  });

  router.get('/setup/gmail', async ({ res }) => {
    sendJson(res, 200, await gmailHealth(deps.runner));
  });

  router.post('/setup/gmail/start', async (ctx) => {
    const body = (await ctx.json<{ confirm_replace?: boolean }>().catch(() => ({}))) as { confirm_replace?: boolean };
    const result = await startGmailAuth(deps.runner, deps.gmailAccount, body.confirm_replace === true);
    sendJson(ctx.res, result.status === 'failed' ? 502 : 200, result);
  });

  // The pasted redirect URL is a secret. It is read here, used once, and never logged.
  router.post('/setup/gmail/finish', async (ctx) => {
    const body = await ctx.json<{ redirect_url?: unknown }>();
    const pasted = typeof body.redirect_url === 'string' ? body.redirect_url : '';
    const result = await finishGmailAuth(deps.runner, deps.gmailAccount, pasted);
    sendJson(ctx.res, result.status === 'failed' ? 422 : 200, result);
  });
}
