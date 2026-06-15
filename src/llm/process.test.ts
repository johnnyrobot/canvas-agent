import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { OllamaProcess, type SpawnLike } from './process.js';
import { loadLLMConfig } from './config.js';

/** A spawn whose child asynchronously emits ENOENT (binary not on PATH). */
const enoentSpawn: SpawnLike = () => {
  const child = new EventEmitter() as unknown as ChildProcess;
  setImmediate(() =>
    child.emit('error', Object.assign(new Error('spawn ollama ENOENT'), { code: 'ENOENT' })),
  );
  return child;
};

test('ensureRunning rejects (does not crash) when the ollama binary cannot be spawned (C5)', async () => {
  // Unreachable health URL → not already running → the spawn path is taken.
  const config = { ...loadLLMConfig({}), nativeUrl: 'http://127.0.0.1:1', manageProcess: true };
  const proc = new OllamaProcess(config, undefined, enoentSpawn);
  await assert.rejects(() => proc.ensureRunning(), /ENOENT|spawn|ollama/i);
});

// ── Daemon-crash characterization (deferred respawn supervisor) ───────────────

const flush = () => new Promise((r) => setTimeout(r, 0));

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
  kill(sig?: string): boolean;
  kills: Array<string | undefined>;
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const spawn: SpawnLike = () => {
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
  return { spawn, children };
}

/** OllamaProcess whose health is test-controlled (no real fetch to a daemon). */
class ControlledHealthProcess extends OllamaProcess {
  public healthy = false;
  override async isHealthy(): Promise<boolean> {
    return this.healthy;
  }
}

test('spawn() uses the resolved (bundled) command, not a bare PATH name (packaging)', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args });
    const ee = new EventEmitter() as FakeChild;
    ee.stderr = new EventEmitter();
    ee.kills = [];
    ee.kill = () => true;
    return ee as unknown as ChildProcess;
  };
  // Stand in for resolveSidecarCommand returning a bundled abs path (packaged .app).
  const resolveCommand = (name: string) => `/Resources/sidecars/${name}/${name}`;
  const proc = new ControlledHealthProcess(
    { ...loadLLMConfig({}), manageProcess: true },
    undefined,
    spawn,
    resolveCommand,
  );
  const running = proc.ensureRunning();
  proc.healthy = true;
  await running;
  assert.equal(calls.length, 1, 'spawned exactly once');
  assert.equal(calls[0]!.command, '/Resources/sidecars/ollama/ollama', 'spawns the resolved bundled binary');
  assert.deepEqual([...calls[0]!.args], ['serve']);
});

test('daemon crash: exit nulls the child, owned stays true, no auto-respawn (characterization)', async () => {
  const { spawn, children } = fakeSpawn();
  const proc = new ControlledHealthProcess({ ...loadLLMConfig({}), manageProcess: true }, undefined, spawn);

  // Not healthy at first → spawn path; flip healthy so waitUntilReady resolves fast.
  const running = proc.ensureRunning();
  proc.healthy = true;
  await running;
  assert.equal(proc.isOwned, true, 'owns the daemon after a successful spawn');
  assert.equal(children.length, 1, 'spawned exactly once');

  // The daemon crashes.
  children[0]!.emit('exit', 1);
  await flush();

  // Characterized CURRENT behavior (deferred supervisor — flip these when it lands):
  assert.equal(proc.isOwned, true, 'owned does NOT flip on exit today (no auto-recovery)');
  assert.equal(children.length, 1, 'there is no auto-respawn after a crash');
  // The child was nulled, so stop() is a clean no-op and must NOT signal a dead child.
  await proc.stop();
  assert.deepEqual(children[0]!.kills, [], 'stop() does not kill an already-exited child');
});
