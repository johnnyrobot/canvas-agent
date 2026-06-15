import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasGet, parseLinkNext, sameOrigin } from './http.js';
import { fakeCanvas } from './fake-canvas.js';

// ── The read-only GET client ─────────────────────────────────────────────────

test('createCanvasGet sends Bearer auth + Accept json and uses GET', async () => {
  const { fetch, calls } = fakeCanvas(() => ({ body: { ok: true } }));
  const get = createCanvasGet({ token: 'sekret', fetch });

  const res = await get('https://school.instructure.com/api/v1/courses/1');

  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.authorization, 'Bearer sekret');
  assert.equal(calls[0]?.accept, 'application/json');
});

test('createCanvasGet attaches a per-request timeout signal so a hung Canvas cannot hang the import (L4)', async () => {
  const { fetch, calls } = fakeCanvas(() => ({ body: { ok: true } }));
  const get = createCanvasGet({ token: 't', fetch });
  await get('https://school.instructure.com/api/v1/courses/1');
  assert.equal(calls[0]?.signal, true, 'expected an AbortSignal (timeout) on the request');
});

test('createCanvasGet refuses any non-GET method and never touches the network', async () => {
  const { fetch, calls } = fakeCanvas(() => ({ body: {} }));
  const get = createCanvasGet({ token: 't', fetch });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    await assert.rejects(() => get('https://x/api', method), /non-GET|read-only/i);
  }
  // The read-only guarantee: a refused method must NOT reach fetch.
  assert.equal(calls.length, 0);
});

// ── Same-origin token-exfiltration backstop ─────────────────────────────────

test('sameOrigin compares scheme+host+port and is false for unparseable input', () => {
  assert.equal(sameOrigin('https://x.test/a', 'https://x.test/b?q=1'), true);
  assert.equal(sameOrigin('https://x.test', 'http://x.test'), false); // scheme
  assert.equal(sameOrigin('https://x.test', 'https://evil.test'), false); // host
  assert.equal(sameOrigin('https://x.test:8443', 'https://x.test'), false); // port
  assert.equal(sameOrigin('not a url', 'https://x.test'), false);
});

test('a baseUrl-bound client refuses a cross-origin URL: no token attached, no request made', async () => {
  const { fetch, calls } = fakeCanvas(() => ({ body: { ok: true } }));
  const get = createCanvasGet({ token: 'sekret', fetch, baseUrl: 'https://school.instructure.com' });

  await assert.rejects(
    () => get('https://evil.test/api/v1/courses/1'),
    /cross-origin|off-origin/i,
  );
  // The token must never reach the wire on a cross-origin attempt.
  assert.equal(calls.length, 0, 'a cross-origin request must not reach fetch');
});

test('a baseUrl-bound client still allows same-origin requests (paths/queries differ)', async () => {
  const { fetch, calls } = fakeCanvas(() => ({ body: { ok: true } }));
  const get = createCanvasGet({ token: 't', fetch, baseUrl: 'https://school.instructure.com' });
  const res = await get('https://school.instructure.com/api/v1/courses/1/pages?page=2');
  assert.equal(res.ok, true);
  assert.equal(calls[0]?.authorization, 'Bearer t');
});

// ── RFC-5988 Link-header parsing ─────────────────────────────────────────────

test('parseLinkNext extracts the rel="next" target', () => {
  const header =
    '<https://x/api/v1/courses/1/pages?page=2&per_page=100>; rel="next", ' +
    '<https://x/api/v1/courses/1/pages?page=9&per_page=100>; rel="last"';
  assert.equal(parseLinkNext(header), 'https://x/api/v1/courses/1/pages?page=2&per_page=100');
});

test('parseLinkNext tolerates whitespace and unquoted rel values', () => {
  assert.equal(parseLinkNext('<https://x/p?page=3> ; rel=next'), 'https://x/p?page=3');
});

test('parseLinkNext returns null when there is no next link', () => {
  assert.equal(parseLinkNext('<https://x>; rel="last"'), null);
  assert.equal(parseLinkNext(null), null);
  assert.equal(parseLinkNext(undefined), null);
  assert.equal(parseLinkNext(''), null);
});
