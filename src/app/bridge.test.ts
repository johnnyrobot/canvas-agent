import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppApi,
  BrandKit,
  CanvasConfig,
  CanvasPage,
  CatalogCourse,
  CatalogCourseSummary,
  ScreenshotAttachment,
  ScreenshotSource,
  Session,
  SessionState,
  ThemeResult,
  TurnChunk,
  TurnRequest,
  TurnView,
  UploadedDocument,
} from '../contracts/index.js';
import { createBridge, type Invoke, type Subscribe } from './bridge.js';
import type { IpcResult } from './ipc.js';
import {
  RUN_TURN,
  SAVE_CANVAS_AUTH,
  IMPORT_CANVAS,
  HEALTH,
  CREATE_SESSION,
  LIST_SESSIONS,
  LOAD_SESSION,
  DELETE_SESSION,
  RESOLVE_BRAND_THEME,
  LIST_BRAND_KITS,
  SAVE_BRAND_KIT,
  DELETE_BRAND_KIT,
  FETCH_CANVAS_PAGE,
  LIST_CANVAS_PAGES,
  CONVERT_DOCUMENT,
  SCREENSHOT_PERMISSION_STATUS,
  LIST_SCREENSHOT_SOURCES,
  CAPTURE_SCREENSHOT,
  CATALOG_AVAILABLE,
  CATALOG_SEARCH,
  CATALOG_GET,
  CHUNK,
} from './channels.js';

/** Record invoke() calls; reply with whatever the test queues per channel. */
function fakeInvoke(replies: Record<string, IpcResult<unknown>>) {
  const calls: { channel: string; args: unknown[] }[] = [];
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    calls.push({ channel, args });
    const reply = replies[channel];
    if (!reply) throw new Error(`no reply queued for ${channel}`);
    return reply;
  };
  return { invoke, calls };
}

/** A subscribe that does nothing — for the request/response methods. */
const noSub: Subscribe = () => () => {};

const TURN_VIEW: TurnView = { text: 'hi', fragments: [], toolsUsed: [], iterations: 1 };

const SESSION: Session = {
  id: 'sess-1',
  title: 'Demo',
  mode: 'build',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const SESSION_STATE: SessionState = { session: SESSION, messages: [] };
const THEME_RESULT: ThemeResult = { colors: [], warnings: [] };
const BRAND_KIT: BrandKit = {
  id: 'kit-1',
  name: 'Kit',
  palette: { primary: '#0b5394', secondary: '#38761d' },
  createdAt: '2026-01-01T00:00:00.000Z',
};
const CANVAS_PAGES: CanvasPage[] = [{ id: 'syllabus', title: 'Syllabus' }];
const CONFIG: CanvasConfig = { baseUrl: 'https://x', token: 't' };
const SCREENSHOT_SOURCE: ScreenshotSource = {
  id: 'screen:1:0',
  kind: 'screen',
  label: 'Entire Screen',
  thumbnailDataUrl: 'data:image/png;base64,',
};
const SCREENSHOT: ScreenshotAttachment = {
  id: 'shot-1',
  kind: 'screenshot',
  mime: 'image/png',
  dataUrl: 'data:image/png;base64,QUJD',
  label: 'Entire Screen',
  capturedAt: '2026-01-01T00:00:00.000Z',
};
const DOCUMENT: UploadedDocument = {
  filename: 'syllabus.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sizeBytes: 12,
  dataUrl: 'data:application/octet-stream;base64,QUJD',
};
const CATALOG_SUMMARIES: CatalogCourseSummary[] = [
  { id: 40830, code: 'ACCTG001', title: 'Introductory Accounting I', college: 'wlac.elumenapp.com' },
];
const CATALOG_COURSE: CatalogCourse = {
  id: 40830,
  code: 'ACCTG001',
  title: 'Introductory Accounting I',
  slos: ['Complete an accounting cycle.'],
  objectives: ['1 - Explain GAAP.'],
  source: 'live',
};

test('createBridge exposes exactly the AppApi methods', () => {
  const { invoke } = fakeInvoke({});
  const bridge = createBridge(invoke, noSub);
  assert.deepEqual(Object.keys(bridge).sort(), [
    'captureScreenshot',
    'catalogAvailable',
    'catalogGet',
    'catalogSearch',
    'convertDocument',
    'createSession',
    'deleteBrandKit',
    'deleteSession',
    'fetchCanvasPage',
    'health',
    'importCanvas',
    'listBrandKits',
    'listCanvasPages',
    'listScreenshotSources',
    'listSessions',
    'loadSession',
    'pullIngestModel',
    'pullModel',
    'resolveBrandTheme',
    'runTurn',
    'saveBrandKit',
    'saveCanvasAuth',
    'screenshotPermissionStatus',
  ]);
});

test('runTurn without onChunk invokes { req } and never subscribes', async () => {
  let subscribed = false;
  const subscribe: Subscribe = () => {
    subscribed = true;
    return () => {};
  };
  const { invoke, calls } = fakeInvoke({ [RUN_TURN]: { ok: true, value: TURN_VIEW } });
  const bridge = createBridge(invoke, subscribe);

  const req: TurnRequest = { user: 'draft a module overview' };
  const view = await bridge.runTurn(req);

  assert.deepEqual(calls, [{ channel: RUN_TURN, args: [{ req }] }]);
  assert.equal(view, TURN_VIEW);
  assert.equal(subscribed, false);
});

test('runTurn with onChunk subscribes, forwards matching-turnId chunks, and unsubscribes', async () => {
  let subHandler: ((payload: unknown) => void) | null = null;
  let unsubscribed = false;
  const subscribe: Subscribe = (channel, handler) => {
    assert.equal(channel, CHUNK);
    subHandler = handler;
    return () => {
      unsubscribed = true;
    };
  };

  const a: TurnChunk = { type: 'text', delta: 'a' };
  const b: TurnChunk = { type: 'tool', name: 'audit_html' };
  const received: TurnChunk[] = [];

  const invoke: Invoke = async (channel, payload) => {
    assert.equal(channel, RUN_TURN);
    const { req, turnId } = payload as { req: TurnRequest; turnId?: string };
    assert.ok(req, 'req must be forwarded');
    assert.ok(typeof turnId === 'string' && turnId.length > 0, 'a turnId must be minted');
    // Emit two chunks for THIS turn plus one for a different turn (must be filtered out).
    subHandler!({ turnId, chunk: a });
    subHandler!({ turnId: 'other-turn', chunk: { type: 'text', delta: 'IGNORED' } });
    subHandler!({ turnId, chunk: b });
    return { ok: true, value: TURN_VIEW };
  };

  const bridge = createBridge(invoke, subscribe);
  const view = await bridge.runTurn({ user: 'hi' }, (c) => received.push(c));

  assert.equal(view, TURN_VIEW);
  assert.deepEqual(received, [a, b]);
  assert.equal(unsubscribed, true, 'subscription must be torn down after the turn');
});

test('runTurn unsubscribes even when the turn reply is an error envelope', async () => {
  let unsubscribed = false;
  const subscribe: Subscribe = () => () => {
    unsubscribed = true;
  };
  const invoke: Invoke = async () => ({ ok: false, error: { name: 'Error', message: 'boom' } });
  const bridge = createBridge(invoke, subscribe);

  await assert.rejects(() => bridge.runTurn({ user: 'hi' }, () => {}), /boom/);
  assert.equal(unsubscribed, true, 'subscription must be torn down on failure too');
});

test('importCanvas forwards (baseUrl, courseId) over the IMPORT_CANVAS channel', async () => {
  const { invoke, calls } = fakeInvoke({ [IMPORT_CANVAS]: { ok: true, value: 'import' } });
  const bridge = createBridge(invoke, noSub);

  await bridge.importCanvas(CONFIG.baseUrl, '7');

  assert.deepEqual(calls, [{ channel: IMPORT_CANVAS, args: [CONFIG.baseUrl, '7'] }]);
});

test('saveCanvasAuth forwards the full config (token) over the SAVE_CANVAS_AUTH channel', async () => {
  const { invoke, calls } = fakeInvoke({ [SAVE_CANVAS_AUTH]: { ok: true, value: undefined } });
  const bridge = createBridge(invoke, noSub);

  await bridge.saveCanvasAuth(CONFIG);

  assert.deepEqual(calls, [{ channel: SAVE_CANVAS_AUTH, args: [CONFIG] }]);
});

test('health invokes the HEALTH channel with no args', async () => {
  const { invoke, calls } = fakeInvoke({ [HEALTH]: { ok: true, value: { llm: true, ingest: false } } });
  const bridge = createBridge(invoke, noSub);

  const health = await bridge.health();

  assert.deepEqual(calls, [{ channel: HEALTH, args: [] }]);
  assert.deepEqual(health, { llm: true, ingest: false });
});

test('each new method invokes its channel with the right args and unwraps the value', async () => {
  const kit = { name: 'K', palette: { primary: '#fff', secondary: '#000' } };
  const cases: {
    channel: string;
    value: unknown;
    args: unknown[];
    run: (b: AppApi) => Promise<unknown>;
  }[] = [
    { channel: CREATE_SESSION, value: SESSION, args: [{ title: 'New', mode: 'build' }], run: (b) => b.createSession({ title: 'New', mode: 'build' }) },
    { channel: LIST_SESSIONS, value: [SESSION], args: [], run: (b) => b.listSessions() },
    { channel: LOAD_SESSION, value: SESSION_STATE, args: ['sess-1'], run: (b) => b.loadSession('sess-1') },
    { channel: DELETE_SESSION, value: undefined, args: ['sess-1'], run: (b) => b.deleteSession('sess-1') },
    { channel: RESOLVE_BRAND_THEME, value: THEME_RESULT, args: ['#0b5394', '#38761d'], run: (b) => b.resolveBrandTheme('#0b5394', '#38761d') },
    { channel: LIST_BRAND_KITS, value: [BRAND_KIT], args: [], run: (b) => b.listBrandKits() },
    { channel: SAVE_BRAND_KIT, value: BRAND_KIT, args: [kit], run: (b) => b.saveBrandKit(kit) },
    { channel: DELETE_BRAND_KIT, value: undefined, args: ['kit-1'], run: (b) => b.deleteBrandKit('kit-1') },
    { channel: FETCH_CANVAS_PAGE, value: '<p>page</p>', args: [CONFIG.baseUrl, '123', 'syllabus'], run: (b) => b.fetchCanvasPage(CONFIG.baseUrl, '123', 'syllabus') },
    { channel: LIST_CANVAS_PAGES, value: CANVAS_PAGES, args: [CONFIG.baseUrl, '123'], run: (b) => b.listCanvasPages(CONFIG.baseUrl, '123') },
    { channel: CONVERT_DOCUMENT, value: { filename: 'syllabus.docx', status: 'success', processingTimeMs: 1, html: '<p>x</p>' }, args: [DOCUMENT], run: (b) => b.convertDocument(DOCUMENT) },
    { channel: SCREENSHOT_PERMISSION_STATUS, value: 'granted', args: [], run: (b) => b.screenshotPermissionStatus() },
    { channel: LIST_SCREENSHOT_SOURCES, value: [SCREENSHOT_SOURCE], args: [], run: (b) => b.listScreenshotSources() },
    { channel: CAPTURE_SCREENSHOT, value: SCREENSHOT, args: [SCREENSHOT_SOURCE.id], run: (b) => b.captureScreenshot(SCREENSHOT_SOURCE.id) },
    { channel: CATALOG_AVAILABLE, value: true, args: [], run: (b) => b.catalogAvailable() },
    { channel: CATALOG_SEARCH, value: CATALOG_SUMMARIES, args: ['accounting'], run: (b) => b.catalogSearch('accounting') },
    { channel: CATALOG_GET, value: CATALOG_COURSE, args: [40830], run: (b) => b.catalogGet(40830) },
  ];

  for (const { channel, value, args, run } of cases) {
    const { invoke, calls } = fakeInvoke({ [channel]: { ok: true, value } });
    const bridge = createBridge(invoke, noSub);

    const out = await run(bridge);

    assert.deepEqual(calls, [{ channel, args }], `${channel} args`);
    assert.equal(out, value, `${channel} unwrapped value`);
  }
});

test('an {ok:false} envelope rejects with an Error carrying message + name', async () => {
  const { invoke } = fakeInvoke({
    [HEALTH]: { ok: false, error: { name: 'TypeError', message: 'sidecar down' } },
  });
  const bridge = createBridge(invoke, noSub);

  await assert.rejects(() => bridge.health(), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'sidecar down');
    assert.equal(err.name, 'TypeError');
    return true;
  });
});
