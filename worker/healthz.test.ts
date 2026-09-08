import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import worker from './index';

for (const suffix of ['', '?probe=monitor']) {
  test(`GET /healthz${suffix} is public, uncached JSON even for navigation requests`, async () => {
    const response = await worker.fetch(new Request(`https://app.example/healthz${suffix}`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'openlattice3d' });
  });
}

test('HEAD /healthz has the GET headers and no body', async () => {
  const get = await worker.fetch(new Request('https://app.example/healthz'));
  const head = await worker.fetch(new Request('https://app.example/healthz', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.deepEqual([...head.headers], [...get.headers]);
  assert.equal(await head.text(), '');
});

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
  test(`${method} /healthz is rejected without touching application services`, async () => {
    const response = await worker.fetch(new Request('https://app.example/healthz', { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '');
  });
}

for (const configPath of ["../wrangler.jsonc"]) {
  test(`${configPath} routes /healthz to the Worker before static assets`, () => {
    const config = readFileSync(new URL(configPath, import.meta.url), 'utf8');
    const match = config.match(/"run_worker_first":\s*\[([^\]]*)\]/);
    assert.ok(match, 'explicit Worker route allowlist is required');
    const routes = JSON.parse(`[${match[1]}]`);
    assert.ok(routes.includes('/healthz'));
    assert.ok(!routes.includes('/*'), 'ordinary assets must keep their existing routing');
  });
}
