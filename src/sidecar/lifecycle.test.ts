/**
 * Contract tests for the lifecycle shared by both sidecars (ADR-0004).
 *
 * The per-sidecar specifics — Ollama's warm load, Docling's offline env and
 * `modelsPresent` — stay in `src/llm/process.test.ts` and
 * `src/ingest/process.test.ts`. What is tested here is only what the two share:
 * attach-if-running / spawn-if-not / stop-with-TERM-then-KILL, the memoized
 * start, and the respawn supervisor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SidecarLifecycle, type SpawnLike, type SpawnSpec } from './lifecycle.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
  kill(sig?: string): boolean;
  kills: Array<string | undefined>;
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, env: (options.env ?? {}) as NodeJS.ProcessEnv });
    const ee = new EventEmitter() as FakeChild;
    ee.stderr = new EventEmitter();
    ee.kills = [];
    ee.kill = (sig?: string) => {
      ee.kills.push(sig);
      return true;
    };
    children.push(ee);
    return ee as unknown as ChildProcess;
  };
  return { spawn, children, calls };
}

/** A minimal adapter: test-controlled health, a fixed spawn spec. */
class FakeSidecar extends SidecarLifecycle {
  public healthy = false;
  public specCalls = 0;

  override async isHealthy(): Promise<boolean> {
    return this.healthy;
  }

  protected spawnSpec(): SpawnSpec {
    this.specCalls += 1;
    return { command: '/bundled/fake', args: ['serve'], env: { FAKE: '1' } };
  }
}

function makeSidecar(overrides: Partial<ConstructorParameters<typeof SidecarLifecycle>[0]> = {}) {
  const { spawn, children, calls } = fakeSpawn();
  const sidecar = new FakeSidecar({
    displayName: 'Fake',
    commandLabel: 'fake serve',
    logTag: 'fake',
    unmanagedMessage: 'No Fake and management is disabled.',
    manageProcess: true,
    spawnImpl: spawn,
    readyIntervalMs: 1,
    ...overrides,
  });
  return { sidecar, children, calls };
}

// ── attach / spawn ────────────────────────────────────────────────────────────

test('ensureRunning ATTACHES to an already-healthy sidecar and never spawns', async () => {
  const { sidecar, children } = makeSidecar();
  sidecar.healthy = true;

  await sidecar.ensureRunning();

  assert.equal(children.length, 0, 'a running sidecar is attached to, not replaced');
  assert.equal(sidecar.isOwned, false, 'an attached sidecar is not owned — stop() must not kill it');
});

test('ensureRunning spawns and takes ownership when nothing is listening', async () => {
  const { sidecar, children, calls } = makeSidecar();

  const running = sidecar.ensureRunning();
  sidecar.healthy = true;
  await running;

  assert.equal(children.length, 1);
  assert.equal(calls[0]!.command, '/bundled/fake', 'spawns the adapter-supplied command');
  assert.deepEqual([...calls[0]!.args], ['serve']);
  assert.equal(calls[0]!.env.FAKE, '1', 'passes the adapter-supplied env');
  assert.equal(sidecar.isOwned, true);
});

test('ensureRunning rejects with the adapter message when management is disabled', async () => {
  const { sidecar, children } = makeSidecar({ manageProcess: false });

  await assert.rejects(() => sidecar.ensureRunning(), /No Fake and management is disabled\./);
  assert.equal(children.length, 0, 'never spawns what it is not allowed to manage');
});

test('ensureRunning rejects (does not crash) when the binary cannot be spawned', async () => {
  const enoent: SpawnLike = () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn fake ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const { sidecar } = makeSidecar({ spawnImpl: enoent });

  await assert.rejects(() => sidecar.ensureRunning(), /ENOENT/);
});

// ── the memoized start (moved DOWN from sidecar.ts — ADR-0004) ────────────────

test('ensureRunning is memoized: concurrent callers spawn the sidecar exactly once', async () => {
  const { sidecar, children } = makeSidecar();

  const all = Promise.all([sidecar.ensureRunning(), sidecar.ensureRunning(), sidecar.ensureRunning()]);
  sidecar.healthy = true;
  await all;

  assert.equal(children.length, 1, 'three concurrent starts, one spawn');
});

test('ensureRunning is memoized across sequential calls too (no re-probe once started)', async () => {
  const { sidecar, children } = makeSidecar();

  const running = sidecar.ensureRunning();
  sidecar.healthy = true;
  await running;
  await sidecar.ensureRunning();
  await sidecar.ensureRunning();

  assert.equal(children.length, 1, 'a settled successful start is not redone');
});

test('a FAILED start clears the memo so a later call can retry', async () => {
  const { sidecar, children } = makeSidecar({ manageProcess: false });

  await assert.rejects(() => sidecar.ensureRunning());
  // Management is still off, so this must reject again rather than resolve from
  // a poisoned cache — the failure was not memoized.
  await assert.rejects(() => sidecar.ensureRunning());
  assert.equal(children.length, 0);
});

test('stop() clears the memo so the sidecar can be started again', async () => {
  const { sidecar, children } = makeSidecar();

  let running = sidecar.ensureRunning();
  sidecar.healthy = true;
  await running;

  const stopping = sidecar.stop();
  await flush();
  children[0]!.emit('exit', 0);
  await stopping;

  sidecar.healthy = false;
  running = sidecar.ensureRunning();
  sidecar.healthy = true;
  await running;

  assert.equal(children.length, 2, 'restart after stop spawns a fresh child');
});

// ── stop ──────────────────────────────────────────────────────────────────────

test('stop() escalates SIGTERM → SIGKILL when the child will not exit', async () => {
  const { sidecar, children } = makeSidecar({ stopGraceMs: 5 });

  const running = sidecar.ensureRunning();
  sidecar.healthy = true;
  await running;

  await sidecar.stop(); // child never emits 'exit'

  assert.deepEqual(children[0]!.kills, ['SIGTERM', 'SIGKILL']);
});

test('stop() does NOT signal a sidecar it only attached to', async () => {
  const { sidecar, children } = makeSidecar();
  sidecar.healthy = true;
  await sidecar.ensureRunning(); // attach path

  await sidecar.stop();

  assert.equal(children.length, 0, 'nothing was spawned, so nothing is signalled');
});

// ── respawn supervisor (ensureAlive) ──────────────────────────────────────────

test('ensureAlive is a no-op when the sidecar is healthy', async () => {
  const { sidecar, children } = makeSidecar();
  sidecar.healthy = true;

  await sidecar.ensureAlive();

  assert.equal(children.length, 0);
});

test('ensureAlive is a no-op when management is disabled', async () => {
  const { sidecar, children } = makeSidecar({ manageProcess: false });
  sidecar.healthy = false;

  await sidecar.ensureAlive(); // must not throw and must not spawn

  assert.equal(children.length, 0);
});

test('ensureAlive respawns a dead sidecar, then enforces the restart budget', async () => {
  const { sidecar, children } = makeSidecar({ respawnPolicy: { maxRespawns: 2, windowMs: 60_000 } });

  let running = sidecar.ensureRunning();
  sidecar.healthy = true;
  await running;

  for (const expected of [2, 3]) {
    sidecar.healthy = false;
    running = sidecar.ensureAlive();
    sidecar.healthy = true;
    await running;
    assert.equal(children.length, expected, 'respawned the dead sidecar');
    assert.equal(sidecar.isOwned, true, 'owns the respawned sidecar');
  }

  sidecar.healthy = false;
  await assert.rejects(() => sidecar.ensureAlive(), /respawn|giving up|keeps dying/i);
  assert.equal(children.length, 3, 'no respawn once the restart budget is spent');
});

test('ensureAlive: a late exit from the replaced child does not orphan the live one', async () => {
  const { sidecar, children } = makeSidecar();

  let running = sidecar.ensureRunning();
  sidecar.healthy = true;
  await running;

  sidecar.healthy = false;
  running = sidecar.ensureAlive();
  sidecar.healthy = true;
  await running;
  assert.equal(children.length, 2);

  // The ORIGINAL child finally delivers its delayed `exit` after the replacement
  // is already live. An exit handler bound to `this` rather than to the specific
  // child would null out the new child here, dropping our handle to a live one.
  children[0]!.emit('exit', 1);
  await flush();

  const stopping = sidecar.stop();
  await flush();
  children[1]!.emit('exit', 0);
  await stopping;

  assert.ok(children[0]!.kills.includes('SIGKILL'), 'the stale/hung original is reaped before respawn');
  assert.ok(children[1]!.kills.includes('SIGTERM'), 'stop() terminates the live respawned sidecar');
});

test('spawnSpec is re-read on every spawn, so config-derived env cannot go stale', async () => {
  const { sidecar } = makeSidecar();

  let running = sidecar.ensureRunning();
  sidecar.healthy = true;
  await running;
  assert.equal(sidecar.specCalls, 1);

  sidecar.healthy = false;
  running = sidecar.ensureAlive();
  sidecar.healthy = true;
  await running;

  assert.equal(sidecar.specCalls, 2, 'the respawn asks the adapter again');
});
