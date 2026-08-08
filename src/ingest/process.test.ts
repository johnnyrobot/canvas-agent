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

/** Capturing spawn fake that records command/args/options for assertions. */
function capturingSpawn(): {
  spawn: SpawnLike;
  calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, env: (options.env ?? {}) as NodeJS.ProcessEnv });
    const ee = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: (s?: string) => boolean };
    ee.stderr = new EventEmitter();
    ee.kill = () => true;
    return ee as unknown as ChildProcess;
  };
  return { spawn, calls };
}

test('spawn() uses the resolved (bundled) command, not a bare PATH name (packaging)', async () => {
  const { spawn, calls } = capturingSpawn();
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

test('spawn() serves OFFLINE against modelsDir when set (artifacts path + HF offline)', async () => {
  const { spawn, calls } = capturingSpawn();
  const config = loadIngestConfig({
    DOCLING_SERVE_URL: 'http://127.0.0.1:5001',
    DOCLING_MANAGE_PROCESS: 'true',
    DOCLING_MODELS_DIR: '/data/docling-models',
  });
  const proc = new ControlledHealthDocling(config, undefined, spawn, (n) => n);
  const running = proc.ensureRunning();
  proc.healthy = true;
  await running;
  assert.equal(calls[0]!.env.DOCLING_SERVE_ARTIFACTS_PATH, '/data/docling-models');
  assert.equal(calls[0]!.env.HF_HUB_OFFLINE, '1');
  assert.equal(calls[0]!.env.TRANSFORMERS_OFFLINE, '1');
});

test('spawn() does not force offline env when no modelsDir is configured (dev)', async () => {
  const { spawn, calls } = capturingSpawn();
  const config = loadIngestConfig({ DOCLING_SERVE_URL: 'http://127.0.0.1:5001', DOCLING_MANAGE_PROCESS: 'true' });
  const proc = new ControlledHealthDocling(config, undefined, spawn, (n) => n);
  const running = proc.ensureRunning();
  proc.healthy = true;
  await running;
  assert.equal(calls[0]!.env.DOCLING_SERVE_ARTIFACTS_PATH, undefined);
  assert.equal(calls[0]!.env.HF_HUB_OFFLINE, undefined);
});

test('modelsPresent: true when no modelsDir (dev); reflects dir contents when set', () => {
  const dev = new DoclingProcess(loadIngestConfig({}));
  assert.equal(dev.modelsPresent(), true, 'optimistic without a configured store');

  const missing = new DoclingProcess(loadIngestConfig({ DOCLING_MODELS_DIR: '/nope/does/not/exist' }));
  assert.equal(missing.modelsPresent(), false, 'configured but empty/absent → not present');
});

test('modelsPresent: a bundled build answers from knowledge, not from a dir probe', () => {
  // ADR-0008: in a bundled build the models ship inside the app. Reporting them
  // missing would offer a download that writes into a read-only, code-signed
  // bundle. The dir here is deliberately absent: presence must not depend on a
  // filesystem probe succeeding inside the .app.
  const bundled = new DoclingProcess(
    loadIngestConfig({ DOCLING_MODELS_DIR: '/nope/does/not/exist', DOCLING_MODELS_BUNDLED: '1' }),
  );
  assert.equal(bundled.modelsPresent(), true, 'bundled models are present by construction');
});

test('spawn() keeps ALL FOUR offline settings, including deferred model loading', async () => {
  // The fourth (LOAD_MODELS_AT_BOOT=0) is the one the bundle launcher never sets
  // and that a naive "stop setting modelsDir when bundled" fix would drop —
  // re-enabling boot-time loading of the heaviest payload we ship (ADR-0008).
  const { spawn, calls } = capturingSpawn();
  const config = loadIngestConfig({
    DOCLING_SERVE_URL: 'http://127.0.0.1:5001',
    DOCLING_MANAGE_PROCESS: 'true',
    DOCLING_MODELS_DIR: '/Apps/Canvas Agent.app/Contents/Resources/sidecars/docling-serve/models',
    DOCLING_MODELS_BUNDLED: '1',
  });
  const proc = new ControlledHealthDocling(config, undefined, spawn, (n) => n);
  const running = proc.ensureRunning();
  proc.healthy = true;
  await running;
  const env = calls[0]!.env;
  assert.equal(env.DOCLING_SERVE_ARTIFACTS_PATH, '/Apps/Canvas Agent.app/Contents/Resources/sidecars/docling-serve/models');
  assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(env.DOCLING_SERVE_LOAD_MODELS_AT_BOOT, '0', 'defer model loading past daemon startup');
});
