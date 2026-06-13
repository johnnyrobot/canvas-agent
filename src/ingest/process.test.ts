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
