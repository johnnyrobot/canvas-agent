import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppApi,
  BrandKit,
  CanvasConfig,
  CanvasImportResult,
  CanvasPage,
  RuntimeHealth,
  Session,
  SessionState,
  ThemeResult,
  TurnChunk,
  TurnRequest,
  TurnView,
} from '../contracts/index.js';
import { registerIpc, type IpcEventLike, type IpcMainLike, type IpcResult } from './ipc.js';
import {
  RUN_TURN,
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
  CHUNK,
  CHANNELS,
} from './channels.js';

// ── Test doubles ─────────────────────────────────────────────────────────────

/** A fake `ipcMain` that records handlers and lets a test invoke them. */
function fakeIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike & {
    handlers: typeof handlers;
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  } = {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    async invoke(channel, ...args) {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler registered for ${channel}`);
      return h({}, ...args);
    },
  };
  return ipc;
}

/** An IPC event whose `sender.send` records every one-way push (for streaming). */
function fakeEvent() {
  const sent: { channel: string; payload: unknown }[] = [];
  const event: IpcEventLike = { sender: { send: (channel, payload) => sent.push({ channel, payload }) } };
  return { event, sent };
}

const TURN_VIEW: TurnView = {
  text: 'hello',
  fragments: [],
  toolsUsed: ['render_template'],
  iterations: 1,
};

const IMPORT_RESULT: CanvasImportResult = {
  courseId: '123',
  name: 'Intro',
  importedAt: '2026-01-01T00:00:00.000Z',
  pages: 2,
  assignments: 1,
  files: 0,
  warnings: [],
};

const HEALTH_RESULT: RuntimeHealth = { llm: true, ingest: true };

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

const CONFIG: CanvasConfig = { baseUrl: 'https://x.instructure.com', token: 't' };

/** A fake `AppApi` that records its calls and returns canned values. */
function fakeApi(overrides: Partial<AppApi> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const api: AppApi = {
    async runTurn(req) {
      calls.push({ method: 'runTurn', args: [req] });
      return TURN_VIEW;
    },
    async importCanvas(config, courseId) {
      calls.push({ method: 'importCanvas', args: [config, courseId] });
      return IMPORT_RESULT;
    },
    async health() {
      calls.push({ method: 'health', args: [] });
      return HEALTH_RESULT;
    },
    async createSession(init) {
      calls.push({ method: 'createSession', args: [init] });
      return SESSION;
    },
    async listSessions() {
      calls.push({ method: 'listSessions', args: [] });
      return [SESSION];
    },
    async loadSession(sessionId) {
      calls.push({ method: 'loadSession', args: [sessionId] });
      return SESSION_STATE;
    },
    async deleteSession(sessionId) {
      calls.push({ method: 'deleteSession', args: [sessionId] });
    },
    async resolveBrandTheme(primary, secondary) {
      calls.push({ method: 'resolveBrandTheme', args: [primary, secondary] });
      return THEME_RESULT;
    },
    async listBrandKits() {
      calls.push({ method: 'listBrandKits', args: [] });
      return [BRAND_KIT];
    },
    async saveBrandKit(kit) {
      calls.push({ method: 'saveBrandKit', args: [kit] });
      return BRAND_KIT;
    },
    async deleteBrandKit(id) {
      calls.push({ method: 'deleteBrandKit', args: [id] });
    },
    async fetchCanvasPage(config, courseId, pageId) {
      calls.push({ method: 'fetchCanvasPage', args: [config, courseId, pageId] });
      return '<p>page</p>';
    },
    async listCanvasPages(config, courseId) {
      calls.push({ method: 'listCanvasPages', args: [config, courseId] });
      return CANVAS_PAGES;
    },
    ...overrides,
  };
  return { api, calls };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('registerIpc registers a handler for every channel', () => {
  const ipc = fakeIpcMain();
  const { api } = fakeApi();
  registerIpc(ipc, api);
  for (const channel of Object.values(CHANNELS)) {
    assert.ok(ipc.handlers.has(channel), `expected a handler for ${channel}`);
  }
  assert.equal(ipc.handlers.size, Object.keys(CHANNELS).length);
  // The one-way CHUNK event is a `send`, never a `handle`.
  assert.ok(!ipc.handlers.has(CHUNK), 'CHUNK must not have a request/response handler');
});

test('runTurn channel (no turnId) delegates to api.runTurn and wraps the value', async () => {
  const ipc = fakeIpcMain();
  const { api, calls } = fakeApi();
  registerIpc(ipc, api);

  const req: TurnRequest = { user: 'design a syllabus' };
  const res = (await ipc.invoke(RUN_TURN, { req })) as IpcResult<TurnView>;

  assert.deepEqual(calls, [{ method: 'runTurn', args: [req] }]);
  assert.equal(res.ok, true);
  assert.ok(res.ok && res.value === TURN_VIEW);
});

test('runTurn channel (with turnId) streams chunks back over the CHUNK event', async () => {
  const chunks: TurnChunk[] = [
    { type: 'text', delta: 'Hello ' },
    { type: 'tool', name: 'audit_html' },
    { type: 'fragment', fragment: { html: '<p>x</p>', gate: {
      html: '<p>x</p>',
      badgeWithheld: false,
      conformance: { passedChecks: true, blockers: [], warnings: [], needsHumanReview: [] },
    } } },
  ];
  const { api } = fakeApi({
    async runTurn(_req, onChunk) {
      for (const c of chunks) onChunk?.(c);
      return TURN_VIEW;
    },
  });
  const ipc = fakeIpcMain();
  registerIpc(ipc, api);

  const { event, sent } = fakeEvent();
  const handler = ipc.handlers.get(RUN_TURN)!;
  const res = (await handler(event, { req: { user: 'hi' }, turnId: 't1' })) as IpcResult<TurnView>;

  assert.ok(res.ok && res.value === TURN_VIEW);
  assert.deepEqual(
    sent,
    chunks.map((chunk) => ({ channel: CHUNK, payload: { turnId: 't1', chunk } })),
  );
});

test('runTurn channel (no turnId) never pushes a CHUNK event', async () => {
  const { api } = fakeApi({
    async runTurn(_req, onChunk) {
      // A well-behaved runtime would not invoke onChunk when none was wired,
      // but even if it tried there is no callback to forward through.
      assert.equal(onChunk, undefined);
      return TURN_VIEW;
    },
  });
  const ipc = fakeIpcMain();
  registerIpc(ipc, api);

  const { event, sent } = fakeEvent();
  const handler = ipc.handlers.get(RUN_TURN)!;
  await handler(event, { req: { user: 'hi' } });
  assert.deepEqual(sent, []);
});

test('importCanvas channel forwards (config, courseId) and wraps the value', async () => {
  const ipc = fakeIpcMain();
  const { api, calls } = fakeApi();
  registerIpc(ipc, api);

  const res = (await ipc.invoke(IMPORT_CANVAS, CONFIG, '123')) as IpcResult<CanvasImportResult>;

  assert.deepEqual(calls, [{ method: 'importCanvas', args: [CONFIG, '123'] }]);
  assert.ok(res.ok && res.value === IMPORT_RESULT);
});

test('health channel delegates to api.health and wraps the value', async () => {
  const ipc = fakeIpcMain();
  const { api } = fakeApi();
  registerIpc(ipc, api);

  const res = (await ipc.invoke(HEALTH)) as IpcResult<RuntimeHealth>;
  assert.ok(res.ok && res.value.llm === true && res.value.ingest === true);
});

test('every new product-layer channel delegates to its AppApi method and wraps the result', async () => {
  const cases: { channel: string; method: string; args: unknown[] }[] = [
    { channel: CREATE_SESSION, method: 'createSession', args: [{ title: 'New', mode: 'build' }] },
    { channel: LIST_SESSIONS, method: 'listSessions', args: [] },
    { channel: LOAD_SESSION, method: 'loadSession', args: ['sess-1'] },
    { channel: DELETE_SESSION, method: 'deleteSession', args: ['sess-1'] },
    { channel: RESOLVE_BRAND_THEME, method: 'resolveBrandTheme', args: ['#0b5394', '#38761d'] },
    { channel: LIST_BRAND_KITS, method: 'listBrandKits', args: [] },
    { channel: SAVE_BRAND_KIT, method: 'saveBrandKit', args: [{ name: 'K', palette: { primary: '#fff', secondary: '#000' } }] },
    { channel: DELETE_BRAND_KIT, method: 'deleteBrandKit', args: ['kit-1'] },
    { channel: FETCH_CANVAS_PAGE, method: 'fetchCanvasPage', args: [CONFIG, '123', 'syllabus'] },
    { channel: LIST_CANVAS_PAGES, method: 'listCanvasPages', args: [CONFIG, '123'] },
  ];

  for (const { channel, method, args } of cases) {
    const ipc = fakeIpcMain();
    const { api, calls } = fakeApi();
    registerIpc(ipc, api);

    const res = (await ipc.invoke(channel, ...args)) as IpcResult<unknown>;
    assert.deepEqual(calls, [{ method, args }], `${channel} should call api.${method}(${args.length} args)`);
    assert.equal(res.ok, true, `${channel} should wrap a success envelope`);
  }
});

test('a thrown error becomes an {ok:false,error} envelope instead of rejecting', async () => {
  const ipc = fakeIpcMain();
  const { api } = fakeApi({
    async runTurn() {
      throw new TypeError('model offline');
    },
  });
  registerIpc(ipc, api);

  const res = (await ipc.invoke(RUN_TURN, { req: { user: 'x' } })) as IpcResult<TurnView>;
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.error.message === 'model offline');
  assert.ok(!res.ok && res.error.name === 'TypeError');
});

test('a rejection in a new handler is also wrapped in an error envelope', async () => {
  const ipc = fakeIpcMain();
  const { api } = fakeApi({
    async loadSession() {
      throw new Error('db locked');
    },
  });
  registerIpc(ipc, api);

  const res = (await ipc.invoke(LOAD_SESSION, 'sess-1')) as IpcResult<SessionState | null>;
  assert.ok(!res.ok && res.error.message === 'db locked');
});

test('a non-Error throw is still wrapped with a string message', async () => {
  const ipc = fakeIpcMain();
  const { api } = fakeApi({
    async health() {
      throw 'boom';
    },
  });
  registerIpc(ipc, api);

  const res = (await ipc.invoke(HEALTH)) as IpcResult<RuntimeHealth>;
  assert.ok(!res.ok && res.error.message === 'boom');
});
