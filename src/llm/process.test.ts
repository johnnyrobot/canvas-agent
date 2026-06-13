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
