import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImporter } from './importer.js';
import { fakeCanvas } from './fake-canvas.js';
import type { CanvasConfig } from '../contracts/index.js';

const CONFIG: CanvasConfig = { baseUrl: 'https://school.instructure.com', token: 'tok-123' };
const FIXED_NOW = '2026-01-01T00:00:00.000Z';

// ── Happy path ───────────────────────────────────────────────────────────────

test('happy path: counts pages/assignments/files and returns the course name', async () => {
  const { fetch } = fakeCanvas((url) => {
    switch (url.pathname) {
      case '/api/v1/courses/42':
        return { body: { id: 42, name: 'Intro to Testing' } };
      case '/api/v1/courses/42/pages':
        return { body: [{}, {}] }; // 2
      case '/api/v1/courses/42/assignments':
        return { body: [{}, {}, {}] }; // 3
      case '/api/v1/courses/42/files':
        return { body: [{}] }; // 1
      default:
        return { status: 404, body: { error: 'not found' } };
    }
  });
  const importCourse = createImporter({ fetch, now: () => FIXED_NOW });

  const result = await importCourse(CONFIG, '42');

  assert.deepEqual(result, {
    courseId: '42',
    name: 'Intro to Testing',
    importedAt: FIXED_NOW,
    pages: 2,
    assignments: 3,
    files: 1,
    warnings: [],
  });
});

// ── Read-only guarantee (PRD §17) ────────────────────────────────────────────

test('every recorded request method is GET and carries the Bearer token', async () => {
  const { fetch, calls } = fakeCanvas((url) =>
    url.pathname === '/api/v1/courses/42' ? { body: { name: 'C' } } : { body: [{}] },
  );
  const importCourse = createImporter({ fetch, now: () => FIXED_NOW });

  await importCourse(CONFIG, '42');

  assert.ok(calls.length >= 4, `expected ≥4 calls, saw ${calls.length}`);
  for (const call of calls) {
    assert.equal(call.method, 'GET', `non-GET method reached fetch: ${call.method} ${call.url}`);
    assert.equal(call.authorization, 'Bearer tok-123');
    assert.equal(call.accept, 'application/json');
  }
});

// ── Partial import: a forbidden sub-resource degrades to a warning ───────────

test('a 403 on /files yields files:0 + a warning, import still succeeds', async () => {
  const { fetch, calls } = fakeCanvas((url) => {
    switch (url.pathname) {
      case '/api/v1/courses/7':
        return { body: { name: 'Locked Files Course' } };
      case '/api/v1/courses/7/pages':
        return { body: [{}] };
      case '/api/v1/courses/7/assignments':
        return { body: [{}, {}] };
      case '/api/v1/courses/7/files':
        return { status: 403, body: { status: 'unauthorized' } };
      default:
        return { status: 404, body: {} };
    }
  });
  const importCourse = createImporter({ fetch, now: () => FIXED_NOW });

  const result = await importCourse(CONFIG, '7');

  assert.equal(result.files, 0);
  assert.equal(result.pages, 1);
  assert.equal(result.assignments, 2);
  assert.equal(result.name, 'Locked Files Course');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /files/i);
  assert.match(result.warnings[0] ?? '', /403/);
  // Still read-only even on the error path.
  for (const call of calls) assert.equal(call.method, 'GET');
});

// ── Pagination via the Link header ───────────────────────────────────────────

test('pagination: a rel="next" Link is followed and counts accumulate', async () => {
  const { fetch, calls } = fakeCanvas((url) => {
    if (url.pathname === '/api/v1/courses/9') return { body: { name: 'Big Course' } };
    if (url.pathname === '/api/v1/courses/9/pages') {
      if (url.searchParams.get('page') === '2') return { body: [{}, {}, {}] }; // +3
      return {
        body: [{}, {}], // 2 on page 1
        link: '<https://school.instructure.com/api/v1/courses/9/pages?page=2&per_page=100>; rel="next"',
      };
    }
    if (url.pathname === '/api/v1/courses/9/assignments') return { body: [] };
    if (url.pathname === '/api/v1/courses/9/files') return { body: [] };
    return { status: 404, body: {} };
  });
  const importCourse = createImporter({ fetch, now: () => FIXED_NOW });

  const result = await importCourse(CONFIG, '9');

  assert.equal(result.pages, 5); // 2 + 3 across two pages
  assert.deepEqual(result.warnings, []);
  // The second page was actually requested (and via GET).
  const pageTwo = calls.find((c) => c.url.includes('/pages') && c.url.includes('page=2'));
  assert.ok(pageTwo, 'expected a follow-up request for page 2');
  assert.equal(pageTwo?.method, 'GET');
});

// ── Robustness ───────────────────────────────────────────────────────────────

test('a non-readable course (404) rejects rather than returning a bogus summary', async () => {
  const { fetch } = fakeCanvas(() => ({ status: 404, body: { error: 'not found' } }));
  const importCourse = createImporter({ fetch, now: () => FIXED_NOW });

  await assert.rejects(() => importCourse(CONFIG, 'missing'), /course|404/i);
});

test('a baseUrl with a trailing slash is normalized (no double slash)', async () => {
  const { fetch, calls } = fakeCanvas((url) =>
    url.pathname === '/api/v1/courses/1' ? { body: { name: 'X' } } : { body: [] },
  );
  const importCourse = createImporter({ fetch, now: () => FIXED_NOW });

  const result = await importCourse({ baseUrl: 'https://school.instructure.com/', token: 't' }, '1');

  assert.equal(result.name, 'X');
  for (const call of calls) assert.ok(!call.url.includes('//api/v1'), `double slash in ${call.url}`);
});
