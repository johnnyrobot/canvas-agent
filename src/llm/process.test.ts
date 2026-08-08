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
  const config = { ...loadLLMConfig({ MODEL_TEXT: 'test-text:1b' }), nativeUrl: 'http://127.0.0.1:1', manageProcess: true };
  const proc = new OllamaProcess(config, undefined, enoentSpawn);
  await assert.rejects(() => proc.ensureRunning(), /ENOENT|spawn|ollama/i);
});

/** OllamaProcess whose health is test-controlled (no real fetch to a daemon). */
class ControlledHealthProcess extends OllamaProcess {
  public healthy = false;
  override async isHealthy(): Promise<boolean> {
    return this.healthy;
  }
}

test('the spawn spec uses the resolved (bundled) command, not a bare PATH name (packaging)', async () => {
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, env: (options.env ?? {}) as NodeJS.ProcessEnv });
    const ee = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => boolean };
    ee.stderr = new EventEmitter();
    ee.kill = () => true;
    return ee as unknown as ChildProcess;
  };
  // Stand in for resolveSidecarCommand returning a bundled abs path (packaged .app).
  const resolveCommand = (name: string) => `/Resources/sidecars/${name}/${name}`;
  const config = { ...loadLLMConfig({ MODEL_TEXT: 'test-text:1b' }), manageProcess: true };
  const proc = new ControlledHealthProcess(config, undefined, spawn, resolveCommand);

  const running = proc.ensureRunning();
  proc.healthy = true;
  await running;

  assert.equal(calls.length, 1, 'spawned exactly once');
  assert.equal(calls[0]!.command, '/Resources/sidecars/ollama/ollama', 'spawns the resolved bundled binary');
  assert.deepEqual([...calls[0]!.args], ['serve']);
});

test('the spawn spec carries the Ollama tuning env', async () => {
  const calls: NodeJS.ProcessEnv[] = [];
  const spawn: SpawnLike = (_command, _args, options) => {
    calls.push((options.env ?? {}) as NodeJS.ProcessEnv);
    const ee = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => boolean };
    ee.stderr = new EventEmitter();
    ee.kill = () => true;
    return ee as unknown as ChildProcess;
  };
  const config = { ...loadLLMConfig({ MODEL_TEXT: 'test-text:1b' }), manageProcess: true };
  const proc = new ControlledHealthProcess(config, undefined, spawn, (n) => n);

  const running = proc.ensureRunning();
  proc.healthy = true;
  await running;

  assert.equal(calls[0]!.OLLAMA_HOST, config.ollamaHost);
  assert.equal(calls[0]!.OLLAMA_NUM_PARALLEL, String(config.numParallel));
  assert.equal(calls[0]!.OLLAMA_KEEP_ALIVE, config.keepAlive);
});

// The generic crash/respawn behaviour that used to be characterized here —
// exit nulling the child, `ensureAlive` no-ops, the restart budget, the
// replaced-child race — moved to `src/sidecar/lifecycle.test.ts` along with the
// lifecycle itself (ADR-0004). It is shared with docling-serve now, so testing
// it through the Ollama adapter would only re-test the base class twice. What
// stays here is what is genuinely Ollama-specific: the spawn spec above, and
// the ENOENT path, which exercises the adapter's own `resolveCommand`.
