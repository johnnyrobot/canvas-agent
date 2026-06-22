import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppApi, TurnChunk } from '../contracts/index.js';
import { createStubApi } from './stub-api.js';

test('createStubApi returns an object with the core AppApi methods', () => {
  const api: AppApi = createStubApi();
  assert.equal(typeof api.runTurn, 'function');
  assert.equal(typeof api.importCanvas, 'function');
  assert.equal(typeof api.health, 'function');
  assert.equal(typeof api.convertDocument, 'function');
  assert.equal(typeof api.captureScreenshot, 'function');
});

test('runTurn returns a sane TurnView referencing the prompt', async () => {
  const api = createStubApi();
  const view = await api.runTurn({ user: 'design a welcome page' });

  assert.ok(view.text.length > 0, 'expected non-empty assistant text');
  assert.ok(view.text.includes('design a welcome page'), 'text should reference the prompt');
  assert.ok(Array.isArray(view.toolsUsed) && view.toolsUsed.length > 0);
  assert.ok(view.iterations >= 1);
});

test('runTurn emits one passing fragment and one badge-withheld fragment', async () => {
  const api = createStubApi();
  const view = await api.runTurn({ user: 'hi' });

  assert.ok(view.fragments.length >= 2, 'need at least a passing and a withheld fragment');

  const passing = view.fragments.find((f) => !f.gate.badgeWithheld);
  const withheld = view.fragments.find((f) => f.gate.badgeWithheld);
  assert.ok(passing, 'expected a passing fragment');
  assert.ok(withheld, 'expected a badge-withheld fragment');

  // Passing fragment is internally consistent.
  assert.equal(passing.gate.conformance.passedChecks, true);
  assert.equal(passing.gate.conformance.blockers.length, 0);
  assert.ok(passing.gate.html.length > 0);

  // Withheld fragment has at least one blocker and withholds the badge.
  assert.equal(withheld.gate.conformance.passedChecks, false);
  assert.ok(withheld.gate.conformance.blockers.length >= 1);
});

test('each fragment.html matches its gate.html (the gated, safe-to-render HTML)', async () => {
  const api = createStubApi();
  const view = await api.runTurn({ user: 'hi' });
  for (const f of view.fragments) {
    assert.equal(f.html, f.gate.html);
  }
});

test('importCanvas echoes the courseId and returns numeric counts', async () => {
  const api = createStubApi();
  const result = await api.importCanvas('https://x.instructure.com', '4567');

  assert.equal(result.courseId, '4567');
  assert.ok(result.name.length > 0);
  assert.ok(!Number.isNaN(Date.parse(result.importedAt)), 'importedAt should be an ISO date');
  assert.equal(typeof result.pages, 'number');
  assert.equal(typeof result.assignments, 'number');
  assert.equal(typeof result.files, 'number');
  assert.ok(Array.isArray(result.warnings));
});

test('health reports both sidecars up', async () => {
  const api = createStubApi();
  const health = await api.health();
  assert.equal(health.llm, true);
  assert.equal(health.ingest, true);
  assert.equal(health.model?.available, true);
});

test('screenshot stub returns a local screenshot attachment', async () => {
  const api = createStubApi();
  assert.equal(await api.screenshotPermissionStatus(), 'granted');
  const sources = await api.listScreenshotSources();
  assert.ok(sources.length > 0);
  const shot = await api.captureScreenshot(sources[0]!.id);
  assert.equal(shot.kind, 'screenshot');
  assert.equal(shot.mime, 'image/png');
  assert.match(shot.dataUrl, /^data:image\/png;base64,/);
});

test('document stub returns converted HTML for remediation', async () => {
  const api = createStubApi();
  const result = await api.convertDocument({
    filename: 'syllabus.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 12,
    dataUrl: 'data:application/octet-stream;base64,QUJD',
  });
  assert.equal(result.filename, 'syllabus.docx');
  assert.equal(result.status, 'success');
  assert.match(result.html ?? '', /<h2>syllabus\.docx<\/h2>/);
});

// ── Streaming ────────────────────────────────────────────────────────────────

test('runTurn streams a couple of text chunks then a fragment chunk when given a callback', async () => {
  const api = createStubApi();
  const chunks: TurnChunk[] = [];
  const view = await api.runTurn({ user: 'stream me' }, (c) => chunks.push(c));

  assert.ok(chunks.length >= 3, 'expected multiple streamed chunks');
  assert.ok(
    chunks.filter((c) => c.type === 'text').length >= 2,
    'expected a couple of text chunks',
  );
  assert.ok(chunks.some((c) => c.type === 'fragment'), 'expected a trailing fragment chunk');

  // The streamed text references the prompt the user typed.
  const streamedText = chunks.flatMap((c) => (c.type === 'text' ? [c.delta] : [])).join('');
  assert.ok(streamedText.includes('stream me'));

  // Streaming does not change the final view — same fragments come back in the reply.
  assert.equal(view.fragments.length, 2);
});

test('runTurn emits no chunks when no callback is supplied (and still returns a view)', async () => {
  const api = createStubApi();
  // No callback: nothing to stream; must not throw and must still resolve a view.
  const view = await api.runTurn({ user: 'no stream' });
  assert.ok(view.text.length > 0);
  assert.equal(view.fragments.length, 2);
});

// ── Sessions ─────────────────────────────────────────────────────────────────

test('createSession echoes title/mode with a generated id and timestamps', async () => {
  const api = createStubApi();
  const s = await api.createSession({ title: 'My session', mode: 'remediate' });

  assert.equal(s.title, 'My session');
  assert.equal(s.mode, 'remediate');
  assert.ok(s.id.length > 0, 'expected a generated id');
  assert.ok(!Number.isNaN(Date.parse(s.createdAt)), 'createdAt should be an ISO date');
  assert.ok(!Number.isNaN(Date.parse(s.updatedAt)), 'updatedAt should be an ISO date');
});

test('listSessions returns a non-empty canned list of sessions', async () => {
  const api = createStubApi();
  const sessions = await api.listSessions();

  assert.ok(Array.isArray(sessions) && sessions.length > 0);
  for (const s of sessions) {
    assert.ok(s.id.length > 0 && s.title.length > 0);
    assert.ok(['guidance', 'build', 'remediate'].includes(s.mode));
  }
});

test('loadSession returns a canned, resumable session state', async () => {
  const api = createStubApi();
  const state = await api.loadSession('sess-welcome');

  assert.ok(state, 'expected a non-null session state');
  assert.equal(state.session.id, 'sess-welcome');
  assert.ok(Array.isArray(state.messages) && state.messages.length > 0);
});

test('deleteSession resolves without throwing', async () => {
  const api = createStubApi();
  await assert.doesNotReject(() => api.deleteSession('sess-1'));
});

// ── Brand kits ───────────────────────────────────────────────────────────────

test('resolveBrandTheme returns a plausible ThemeResult', async () => {
  const api = createStubApi();
  const theme = await api.resolveBrandTheme('#0b5394', '#38761d');

  assert.ok(theme.colors.length > 0, 'expected resolved colors');
  assert.ok(Array.isArray(theme.warnings));
  for (const c of theme.colors) {
    assert.ok(c.role.length > 0);
    assert.equal(typeof c.contrast.ratio, 'number');
    assert.ok(['AAA', 'AA', 'fail'].includes(c.contrast.level));
    assert.equal(typeof c.contrast.passesAA, 'boolean');
  }
});

test('listBrandKits returns a non-empty canned list', async () => {
  const api = createStubApi();
  const kits = await api.listBrandKits();

  assert.ok(kits.length > 0);
  for (const k of kits) {
    assert.ok(k.id.length > 0 && k.name.length > 0);
    assert.ok(k.palette.primary.length > 0 && k.palette.secondary.length > 0);
    assert.ok(!Number.isNaN(Date.parse(k.createdAt)));
  }
});

test('saveBrandKit echoes the kit with a generated id and createdAt', async () => {
  const api = createStubApi();
  const saved = await api.saveBrandKit({
    name: 'Forest',
    palette: { primary: '#14532d', secondary: '#365314' },
  });

  assert.equal(saved.name, 'Forest');
  assert.deepEqual(saved.palette, { primary: '#14532d', secondary: '#365314' });
  assert.ok(saved.id.length > 0, 'expected a generated id');
  assert.ok(!Number.isNaN(Date.parse(saved.createdAt)), 'createdAt should be an ISO date');
});

test('deleteBrandKit resolves without throwing', async () => {
  const api = createStubApi();
  await assert.doesNotReject(() => api.deleteBrandKit('kit-1'));
});

// ── Read-only Canvas page access ─────────────────────────────────────────────

test('fetchCanvasPage returns sample HTML referencing the pageId', async () => {
  const api = createStubApi();
  const html = await api.fetchCanvasPage('https://x', '123', 'syllabus');

  assert.equal(typeof html, 'string');
  assert.ok(html.includes('syllabus'), 'sample HTML should reference the requested page');
  assert.ok(html.includes('<'), 'expected HTML markup');
});

test('listCanvasPages returns a non-empty canned list of pages', async () => {
  const api = createStubApi();
  const pages = await api.listCanvasPages('https://x', '123');

  assert.ok(pages.length > 0);
  for (const p of pages) {
    assert.ok(p.id.length > 0 && p.title.length > 0);
  }
});
