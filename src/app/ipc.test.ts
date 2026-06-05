import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppApi,
  CanvasConfig,
  CanvasImportResult,
  RuntimeHealth,
  TurnRequest,
  TurnView,
} from '../contracts/index.js';
import { registerIpc, type IpcMainLike, type IpcResult } from './ipc.js';
import { RUN_TURN, IMPORT_CANVAS, HEALTH, CHANNELS } from './channels.js';

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
    // Product-layer methods are not exercised by these IPC tests; throwing
    // stubs keep the fake assignable to the expanded AppApi.
    async createSession() {
      throw new Error('not used in ipc tests');
    },
    async listSessions() {
      throw new Error('not used in ipc tests');
    },
    async loadSession() {
      throw new Error('not used in ipc tests');
    },
    async deleteSession() {
      throw new Error('not used in ipc tests');
    },
    async resolveBrandTheme() {
      throw new Error('not used in ipc tests');
    },
    async listBrandKits() {
      throw new Error('not used in ipc tests');
    },
    async saveBrandKit() {
      throw new Error('not used in ipc tests');
    },
    async deleteBrandKit() {
      throw new Error('not used in ipc tests');
    },
    async fetchCanvasPage() {
      throw new Error('not used in ipc tests');
    },
    async listCanvasPages() {
      throw new Error('not used in ipc tests');
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
  assert.equal(ipc.handlers.size, 3);
});

test('runTurn channel delegates to api.runTurn and wraps the value', async () => {
  const ipc = fakeIpcMain();
  const { api, calls } = fakeApi();
  registerIpc(ipc, api);

  const req: TurnRequest = { user: 'design a syllabus' };
  const res = (await ipc.invoke(RUN_TURN, req)) as IpcResult<TurnView>;

  assert.deepEqual(calls, [{ method: 'runTurn', args: [req] }]);
  assert.equal(res.ok, true);
  assert.ok(res.ok && res.value === TURN_VIEW);
});

test('importCanvas channel forwards (config, courseId) and wraps the value', async () => {
  const ipc = fakeIpcMain();
  const { api, calls } = fakeApi();
  registerIpc(ipc, api);

  const config: CanvasConfig = { baseUrl: 'https://x.instructure.com', token: 't' };
  const res = (await ipc.invoke(IMPORT_CANVAS, config, '123')) as IpcResult<CanvasImportResult>;

  assert.deepEqual(calls, [{ method: 'importCanvas', args: [config, '123'] }]);
  assert.ok(res.ok && res.value === IMPORT_RESULT);
});

test('health channel delegates to api.health and wraps the value', async () => {
  const ipc = fakeIpcMain();
  const { api } = fakeApi();
  registerIpc(ipc, api);

  const res = (await ipc.invoke(HEALTH)) as IpcResult<RuntimeHealth>;
  assert.ok(res.ok && res.value.llm === true && res.value.ingest === true);
});

test('a thrown error becomes an {ok:false,error} envelope instead of rejecting', async () => {
  const ipc = fakeIpcMain();
  const { api } = fakeApi({
    async runTurn() {
      throw new TypeError('model offline');
    },
  });
  registerIpc(ipc, api);

  const res = (await ipc.invoke(RUN_TURN, { user: 'x' })) as IpcResult<TurnView>;
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.error.message === 'model offline');
  assert.ok(!res.ok && res.error.name === 'TypeError');
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
