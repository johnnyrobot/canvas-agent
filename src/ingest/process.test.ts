import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { DoclingProcess, type SpawnLike } from './process.js';
import { loadIngestConfig } from './config.js';

/** A spawn whose child asynchronously emits ENOENT (binary not on PATH). */
const enoentSpawn: SpawnLike = () => {
  const child = new EventEmitter() as unknown as ChildProcess;
  setImmediate(() =>
    child.emit('error', Object.assign(new Error('spawn docling-serve ENOENT'), { code: 'ENOENT' })),
  );
  return child;
};

test('ensureRunning rejects (does not crash) when docling-serve cannot be spawned (C5)', async () => {
  const config = loadIngestConfig({ DOCLING_SERVE_URL: 'http://127.0.0.1:1', DOCLING_MANAGE_PROCESS: 'true' });
  const proc = new DoclingProcess(config, undefined, enoentSpawn);
  await assert.rejects(() => proc.ensureRunning(), /ENOENT|spawn|docling/i);
});

/** DoclingProcess whose health is test-controlled (no real fetch to a server). */
class ControlledHealthDocling extends DoclingProcess {
  public healthy = false;
  override async isHealthy(): Promise<boolean> {
    return this.healthy;
  }
}

test('spawn() uses the resolved (bundled) command, not a bare PATH name (packaging)', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args });
    const ee = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: (s?: string) => boolean };
    ee.stderr = new EventEmitter();
    ee.kill = () => true;
    return ee as unknown as ChildProcess;
  };
  // Stand in for resolveSidecarCommand returning a bundled abs path (packaged .app).
  const resolveCommand = (name: string) => `/Resources/sidecars/${name}/${name}`;
  const config = loadIngestConfig({ DOCLING_SERVE_URL: 'http://127.0.0.1:5001', DOCLING_MANAGE_PROCESS: 'true' });
  const proc = new ControlledHealthDocling(config, undefined, spawn, resolveCommand);
  const running = proc.ensureRunning();
  proc.healthy = true;
  await running;
  assert.equal(calls.length, 1, 'spawned exactly once');
  assert.equal(calls[0]!.command, '/Resources/sidecars/docling-serve/docling-serve', 'spawns the resolved bundled binary');
  assert.equal(calls[0]!.args[0], 'run');
});
