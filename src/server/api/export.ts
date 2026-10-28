import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';
import type { Logger } from '../log.ts';
import { HttpError, type Router, sendJson } from '../http/router.ts';
import { ExportError, prepareExport } from '../export/export.ts';

export interface ExportApiDeps {
  db: Db;
  exportDir: string;
  logger: Logger;
  now: () => Date;
}

// The JSON feed and the manual file export. Both run the same validation and secret scan.
export function registerExportRoutes(router: Router, deps: ExportApiDeps): void {
  router.get('/export', ({ res }) => {
    try {
      const out = prepareExport(deps.db, deps.now());
      res.setHeader('Content-Disposition', 'inline; filename="autojob-export.json"');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(out.text), 'Cache-Control': 'no-store', 'X-Export-Checksum': out.checksum });
      res.end(out.text);
    } catch (err) {
      if (err instanceof ExportError) throw new HttpError(500, err.message, 'export_blocked');
      throw err;
    }
  });

  router.post('/export/file', ({ res }) => {
    try {
      const now = deps.now();
      const out = prepareExport(deps.db, now);
      mkdirSync(deps.exportDir, { recursive: true, mode: 0o700 });
      const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const name = `autojob-export-${stamp}.json`;
      writeFileSync(join(deps.exportDir, name), out.text, { mode: 0o600 });
      deps.logger.info('export file written', { file: name, jobs: out.jobs, checksum: out.checksum });
      sendJson(res, 200, { file: name, checksum: out.checksum, bytes: Buffer.byteLength(out.text), jobs: out.jobs, generated_at: now.toISOString() });
    } catch (err) {
      if (err instanceof ExportError) throw new HttpError(500, err.message, 'export_blocked');
      throw err;
    }
  });
}
