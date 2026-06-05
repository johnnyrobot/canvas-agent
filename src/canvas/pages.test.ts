import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageReader } from './pages.js';
import { createCanvasGet } from './http.js';
import { fakeCanvas } from './fake-canvas.js';
import type { CanvasConfig } from '../contracts/index.js';

const CONFIG: CanvasConfig = { baseUrl: 'https://school.instructure.com', token: 'tok-123' };

// ── fetchPageBody: a single page's body HTML ─────────────────────────────────

test('fetchPageBody returns the page body HTML', async () => {
  const { fetch, calls } = fakeCanvas((url) =>
    url.pathname === '/api/v1/courses/42/pages/intro'
      ? { body: { page_id: 1, url: 'intro', title: 'Intro', body: '<p>hello</p>' } }
      : { status: 404, body: {} },
  );
  const { fetchPageBody } = createPageReader({ fetch });

  const html = await fetchPageBody(CONFIG, '42', 'intro');

  assert.equal(html, '<p>hello</p>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.authorization, 'Bearer tok-123');
  assert.equal(calls[0]?.accept, 'application/json');
});

test('fetchPageBody returns "" when the page has no body field', async () => {
  const { fetch } = fakeCanvas(() => ({ body: { page_id: 2, title: 'Empty' } }));
  const { fetchPageBody } = createPageReader({ fetch });

  assert.equal(await fetchPageBody(CONFIG, '42', 'empty'), '');
});

test('fetchPageBody returns "" when body is present but not a string', async () => {
  const { fetch } = fakeCanvas(() => ({ body: { page_id: 3, title: 'Weird', body: null } }));
  const { fetchPageBody } = createPageReader({ fetch });

  assert.equal(await fetchPageBody(CONFIG, '42', 'weird'), '');
});

test('fetchPageBody throws a clear error on a 404 page', async () => {
  const { fetch } = fakeCanvas(() => ({ status: 404, body: { error: 'not found' } }));
  const { fetchPageBody } = createPageReader({ fetch });

  await assert.rejects(() => fetchPageBody(CONFIG, '42', 'missing'), /404|could not be read/i);
});

test('fetchPageBody URL-encodes the course and page identifiers', async () => {
  const { fetch, calls } = fakeCanvas(() => ({ body: { body: 'x' } }));
  const { fetchPageBody } = createPageReader({ fetch });

  await fetchPageBody(CONFIG, 'a b', 'a/b');

  assert.equal(
    calls[0]?.url,
    'https://school.instructure.com/api/v1/courses/a%20b/pages/a%2Fb',
  );
});

// ── listPages: paginated CanvasPage mapping ──────────────────────────────────

test('listPages maps Canvas page fields onto CanvasPage', async () => {
  const { fetch } = fakeCanvas(() => ({
    body: [
      {
        page_id: 101,
        url: 'syllabus',
        title: 'Syllabus',
        html_url: 'https://school.instructure.com/courses/42/pages/syllabus',
        updated_at: '2026-01-02T03:04:05Z',
      },
    ],
  }));
  const { listPages } = createPageReader({ fetch });

  const pages = await listPages(CONFIG, '42');

  assert.deepEqual(pages, [
    {
      id: '101',
      title: 'Syllabus',
      url: 'https://school.instructure.com/courses/42/pages/syllabus',
      updatedAt: '2026-01-02T03:04:05Z',
    },
  ]);
});

test('listPages falls back to the url slug for url, and omits absent optionals', async () => {
  const { fetch } = fakeCanvas(() => ({
    body: [{ page_id: 7, url: 'just-a-slug', title: 'Slug Page' }],
  }));
  const { listPages } = createPageReader({ fetch });

  const pages = await listPages(CONFIG, '42');

  assert.deepEqual(pages, [{ id: '7', title: 'Slug Page', url: 'just-a-slug' }]);
  // exactOptionalPropertyTypes: missing fields are absent, not `undefined`.
  assert.equal('updatedAt' in (pages[0] ?? {}), false);
});

test('listPages requests per_page=100 and follows a rel="next" Link across pages', async () => {
  const { fetch, calls } = fakeCanvas((url) => {
    if (url.pathname !== '/api/v1/courses/9/pages') return { status: 404, body: {} };
    if (url.searchParams.get('page') === '2') {
      return { body: [{ page_id: 3, title: 'Three' }] };
    }
    return {
      body: [
        { page_id: 1, title: 'One' },
        { page_id: 2, title: 'Two' },
      ],
      link: '<https://school.instructure.com/api/v1/courses/9/pages?page=2&per_page=100>; rel="next"',
    };
  });
  const { listPages } = createPageReader({ fetch });

  const pages = await listPages(CONFIG, '9');

  assert.deepEqual(
    pages.map((p) => p.id),
    ['1', '2', '3'],
  );
  // First request asked for the max page size.
  assert.ok(calls[0]?.url.includes('per_page=100'), `missing per_page: ${calls[0]?.url}`);
  // Page two was actually fetched, via GET.
  const pageTwo = calls.find((c) => c.url.includes('page=2'));
  assert.ok(pageTwo, 'expected a follow-up request for page 2');
  assert.equal(pageTwo?.method, 'GET');
});

test('listPages degrades to [] on a forbidden list (no throw)', async () => {
  const { fetch } = fakeCanvas(() => ({ status: 403, body: { status: 'unauthorized' } }));
  const { listPages } = createPageReader({ fetch });

  assert.deepEqual(await listPages(CONFIG, '42'), []);
});

test('listPages keeps the partial result when a later page errors', async () => {
  const { fetch } = fakeCanvas((url) => {
    if (url.searchParams.get('page') === '2') return { status: 500, body: {} };
    return {
      body: [{ page_id: 1, title: 'One' }],
      link: '<https://school.instructure.com/api/v1/courses/42/pages?page=2&per_page=100>; rel="next"',
    };
  });
  const { listPages } = createPageReader({ fetch });

  const pages = await listPages(CONFIG, '42');

  assert.deepEqual(
    pages.map((p) => p.id),
    ['1'],
  );
});

test('listPages skips non-object / id-less entries instead of emitting junk rows', async () => {
  const { fetch } = fakeCanvas(() => ({
    body: [null, 'nope', { title: 'no id here' }, { page_id: 5, title: 'Keep' }],
  }));
  const { listPages } = createPageReader({ fetch });

  const pages = await listPages(CONFIG, '42');

  assert.deepEqual(pages, [{ id: '5', title: 'Keep' }]);
});

// ── Read-only guarantee: every request is GET; non-GET is refused ────────────

test('every recorded page request uses GET and carries the Bearer token', async () => {
  const { fetch, calls } = fakeCanvas((url) =>
    url.pathname.endsWith('/pages') ? { body: [{ page_id: 1, title: 'P' }] } : { body: { body: '<p/>' } },
  );
  const reader = createPageReader({ fetch });

  await reader.listPages(CONFIG, '42');
  await reader.fetchPageBody(CONFIG, '42', 'p');

  assert.ok(calls.length >= 2, `expected ≥2 calls, saw ${calls.length}`);
  for (const call of calls) {
    assert.equal(call.method, 'GET', `non-GET method reached fetch: ${call.method} ${call.url}`);
    assert.equal(call.authorization, 'Bearer tok-123');
    assert.equal(call.accept, 'application/json');
  }
});

test('the read-only transport refuses any non-GET method without touching fetch', async () => {
  // The page readers can only ever reach Canvas through this same choke point.
  const { fetch, calls } = fakeCanvas(() => ({ body: {} }));
  const get = createCanvasGet({ token: 't', fetch });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(() => get('https://x/api/v1/courses/1/pages', method), /non-GET|read-only/i);
  }
  assert.equal(calls.length, 0);
});
