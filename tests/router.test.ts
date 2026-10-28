import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Router, HttpError, sendJson } from '../src/server/http/router.ts';

function serve(router: Router, prefix = ''): Promise<{ server: Server; base: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handled = await router.handle(req, res, url, prefix);
    if (!handled) sendJson(res, 404, { error: 'not_found' });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` });
    }),
  );
}

function makeRouter(): Router {
  const router = new Router();
  router.post('/api/v1/items/:id/verdict', async (ctx) => {
    const body = await ctx.json<{ verdict: string }>();
    sendJson(ctx.res, 200, { id: ctx.params.id, verdict: body.verdict });
  });
  router.get('/api/v1/fail', () => {
    throw new HttpError(409, 'nope', 'conflict');
  });
  return router;
}

test('path params are decoded and bodies are parsed for JSON writes', async () => {
  const { server, base } = await serve(makeRouter());
  try {
    const res = await fetch(`${base}/api/v1/items/a%20b/verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'good' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: 'a b', verdict: 'good' });
  } finally {
    server.close();
  }
});

test('a write without a JSON content type is refused with 403', async () => {
  const { server, base } = await serve(makeRouter());
  try {
    const res = await fetch(`${base}/api/v1/items/1/verdict`, { method: 'POST', body: 'verdict=good', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('a cross-site write is refused with 403 even when it claims JSON', async () => {
  const { server, base } = await serve(makeRouter());
  try {
    const res = await fetch(`${base}/api/v1/items/1/verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ verdict: 'bad' }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('a wrong method on a known path is 405, and HttpError becomes its status', async () => {
  const { server, base } = await serve(makeRouter());
  try {
    assert.equal((await fetch(`${base}/api/v1/items/1/verdict`)).status, 405);
    const fail = await fetch(`${base}/api/v1/fail`);
    assert.equal(fail.status, 409);
    assert.equal(((await fail.json()) as { error: string }).error, 'conflict');
  } finally {
    server.close();
  }
});

test('a body that is not JSON returns 400', async () => {
  const { server, base } = await serve(makeRouter());
  try {
    const res = await fetch(`${base}/api/v1/items/1/verdict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
