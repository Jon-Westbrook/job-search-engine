import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  // Reads a JSON body. Throws HttpError(400) if the body is missing or malformed.
  json<T = unknown>(): Promise<T>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_BODY_BYTES = 256 * 1024;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface Route {
  method: string;
  parts: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method, parts: splitPath(path), handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler);
  }

  // Returns the matching route, or 'method-not-allowed' when only the method differs.
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | 'method-not-allowed' | null {
    const parts = splitPath(pathname);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchParts(route.parts, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? 'method-not-allowed' : null;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, prefix: string): Promise<boolean> {
    const method = req.method ?? 'GET';
    const apiPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : null;
    if (apiPath === null) return false;
    const result = this.match(method, apiPath);
    if (result === null) return false;
    if (result === 'method-not-allowed') {
      sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
      return true;
    }
    if (MUTATING.has(method) && !isSameSiteJsonRequest(req)) {
      sendJson(res, 403, { error: 'forbidden', message: 'Cross-site or non-JSON write refused' });
      return true;
    }
    const ctx: RequestContext = {
      req,
      res,
      url,
      params: result.params,
      json: () => readJson(req),
    };
    try {
      await result.route.handler(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function matchParts(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] ?? '';
    const a = actual[i] ?? '';
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}

// Writes from a browser must be same-site and JSON. Cross-site form posts and
// no-cors requests cannot send application/json, so they are refused here.
export function isSameSiteJsonRequest(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return false;
  const type = String(req.headers['content-type'] ?? '');
  return type.toLowerCase().startsWith('application/json');
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large', 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) throw new HttpError(400, 'A JSON body is required', 'bad_request');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'The JSON body could not be parsed', 'bad_request');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}
