import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface StaticOptions {
  root: string;
  basePath: string;
}

// Serves the built web app under the base path. index.html gets a <base> tag so the
// relative asset and API URLs resolve under the path prefix.
export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, opts: StaticOptions): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const rel = pathname.startsWith(opts.basePath) ? pathname.slice(opts.basePath.length) : null;
  if (rel === null) return false;

  if (!existsSync(join(opts.root, 'index.html'))) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('The web build is missing. Run npm run build:web.');
    return true;
  }

  if (rel === '' || rel === '/' || rel === '/index.html') {
    const html = readFileSync(join(opts.root, 'index.html'), 'utf8');
    const withBase = html.replace('<head>', `<head><base href="${opts.basePath}/">`);
    sendFile(res, 'text/html; charset=utf-8', Buffer.from(withBase, 'utf8'), 'no-store');
    return true;
  }

  const target = normalize(join(opts.root, rel));
  if (!target.startsWith(opts.root + sep) || !existsSync(target) || !statSync(target).isFile()) {
    return false;
  }
  const type = TYPES[extname(target)] ?? 'application/octet-stream';
  sendFile(res, type, readFileSync(target), 'public, max-age=3600');
  return true;
}

function sendFile(res: ServerResponse, type: string, body: Buffer, cache: string): void {
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': cache,
  });
  res.end(body);
}
