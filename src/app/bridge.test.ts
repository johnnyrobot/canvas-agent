import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasConfig, TurnRequest, TurnView } from '../contracts/index.js';
import { createBridge } from './bridge.js';
import type { IpcResult } from './ipc.js';
import { RUN_TURN, IMPORT_CANVAS, HEALTH } from './channels.js';

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

const TURN_VIEW: TurnView = { text: 'hi', fragments: [], toolsUsed: [], iterations: 1 };

test('createBridge exposes exactly the AppApi methods', () => {
  const { invoke } = fakeInvoke({});
  const bridge = createBridge(invoke);
  assert.deepEqual(Object.keys(bridge).sort(), ['health', 'importCanvas', 'runTurn']);
});

test('runTurn invokes the RUN_TURN channel and returns the unwrapped value', async () => {
  const { invoke, calls } = fakeInvoke({ [RUN_TURN]: { ok: true, value: TURN_VIEW } });
  const bridge = createBridge(invoke);

  const req: TurnRequest = { user: 'draft a module overview' };
  const view = await bridge.runTurn(req);

  assert.deepEqual(calls, [{ channel: RUN_TURN, args: [req] }]);
  assert.equal(view, TURN_VIEW);
});

test('importCanvas forwards (config, courseId) over the IMPORT_CANVAS channel', async () => {
  const importResult = {
    courseId: '7',
    name: 'Bio',
    importedAt: 'now',
    pages: 0,
    assignments: 0,
    files: 0,
    warnings: [],
  };
  const { invoke, calls } = fakeInvoke({ [IMPORT_CANVAS]: { ok: true, value: importResult } });
  const bridge = createBridge(invoke);

  const config: CanvasConfig = { baseUrl: 'https://x', token: 't' };
  const out = await bridge.importCanvas(config, '7');

  assert.deepEqual(calls, [{ channel: IMPORT_CANVAS, args: [config, '7'] }]);
  assert.equal(out, importResult);
});

test('health invokes the HEALTH channel with no args', async () => {
  const { invoke, calls } = fakeInvoke({ [HEALTH]: { ok: true, value: { llm: true, ingest: false } } });
  const bridge = createBridge(invoke);

  const health = await bridge.health();

  assert.deepEqual(calls, [{ channel: HEALTH, args: [] }]);
  assert.deepEqual(health, { llm: true, ingest: false });
});

test('an {ok:false} envelope rejects with an Error carrying message + name', async () => {
  const { invoke } = fakeInvoke({
    [HEALTH]: { ok: false, error: { name: 'TypeError', message: 'sidecar down' } },
  });
  const bridge = createBridge(invoke);

  await assert.rejects(() => bridge.health(), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'sidecar down');
    assert.equal(err.name, 'TypeError');
    return true;
  });
});
