import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createDoclingSidecar } from './sidecar.js';
import type { ConvertedDocument, IngestPullProgress } from './types.js';
import type { DownloadSpawnLike } from './model-download.js';

const ok: ConvertedDocument = { status: 'success', processingTimeMs: 0 };

function fakes(modelsPresent = true) {
  const calls: string[] = [];
  let started = 0;
  const process = {
    ensureRunning: async () => {
      started++;
      calls.push('ensureRunning');
    },
    ensureAlive: async () => {
      calls.push('ensureAlive');
    },
    stop: async () => {},
    isHealthy: async () => true,
    modelsPresent: () => modelsPresent,
  };
  const client = {
    convertFile: async () => {
      calls.push('convertFile');
      return ok;
    },
    convertUrl: async () => {
      calls.push('convertUrl');
      return ok;
    },
  };
  return { calls, process, client, started: () => started };
}

test('convert ensures the docling-serve sidecar is running BEFORE converting (C4)', async () => {
  const f = fakes();
  const sidecar = createDoclingSidecar({ process: f.process, client: f.client });
  await sidecar.convert({ base64: 'QUJD', filename: 'syllabus.pdf' });
  assert.deepEqual(f.calls, ['ensureRunning', 'ensureAlive', 'convertFile']);
});

test('every conversion re-checks liveness, so a mid-session crash self-heals', async () => {
  // The respawn supervisor built for Ollama never reached Docling, because
  // `DoclingProcess` had no `ensureAlive` — a mid-session crash stayed dead
  // until the app restarted. Sharing one lifecycle (ADR-0004) makes the
  // supervisor available; these are the call sites that use it.
  const f = fakes();
  const sidecar = createDoclingSidecar({ process: f.process, client: f.client });

  await sidecar.convert({ base64: 'QUJD', filename: 'a.pdf' });
  await sidecar.convertPath('/dev/null');
  await sidecar.convertUrl('https://example.edu/syllabus.pdf');

  assert.equal(
    f.calls.filter((c) => c === 'ensureAlive').length,
    3,
    'every conversion path checks liveness, not just the first',
  );
  for (const [i, call] of f.calls.entries()) {
    if (call === 'ensureAlive') {
      assert.equal(f.calls[i - 1], 'ensureRunning', 'liveness is checked after the start, before the convert');
    }
  }
});

test('every conversion defers the start decision to the process lifecycle (C4)', async () => {
  const f = fakes();
  const sidecar = createDoclingSidecar({ process: f.process, client: f.client });
  await sidecar.convert({ base64: 'QUJD', filename: 'a.pdf' });
  await sidecar.convert({ base64: 'QUJD', filename: 'b.pdf' });
  // At-most-once used to be enforced HERE, by a memo on `DoclingSidecar`.
  // ADR-0004 moved that memo down into `SidecarLifecycle.ensureRunning` — i.e.
  // below this injected fake — so the facade now asks per conversion and the
  // lifecycle dedupes. The at-most-one-SPAWN guarantee is tested against a real
  // spawn fake in `src/sidecar/lifecycle.test.ts`; what is left to assert here
  // is that the facade never converts without asking first.
  assert.deepEqual(f.calls, [
    'ensureRunning',
    'ensureAlive',
    'convertFile',
    'ensureRunning',
    'ensureAlive',
    'convertFile',
  ]);
  assert.equal(f.started(), 2, 'asks every time; the lifecycle below decides');
});

test('modelStatus reflects whether the models are present on disk', async () => {
  const present = createDoclingSidecar({ process: fakes(true).process, client: fakes().client });
  assert.deepEqual(await present.modelStatus(), { available: true });
  const missing = createDoclingSidecar({ process: fakes(false).process, client: fakes().client });
  assert.deepEqual(await missing.modelStatus(), { available: false });
});

test('pullModel is a no-op (emits success) when models already present', async () => {
  const f = fakes(true);
  const sidecar = createDoclingSidecar({ process: f.process, client: f.client });
  const seen: IngestPullProgress[] = [];
  await sidecar.pullModel((p) => seen.push(p));
  assert.deepEqual(
    seen.map((p) => p.status),
    ['success'],
  );
});

test('pullModel drives the download driver and streams progress when models are missing', async () => {
  const f = fakes(false);
  const lines = [
    '{"status":"downloading","model":"layout","completed":0,"total":1}\n',
    '{"status":"success","completed":1,"total":1}\n',
  ];
  const downloadSpawn: DownloadSpawnLike = () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { stdout: Readable }).stdout = Readable.from(lines);
    (child as unknown as { stderr: Readable }).stderr = Readable.from([]);
    setImmediate(() => setImmediate(() => (child as unknown as EventEmitter).emit('exit', 0)));
    return child;
  };
  const sidecar = createDoclingSidecar({
    env: { DOCLING_MODELS_DIR: '/data/models' },
    process: f.process,
    client: f.client,
    downloadSpawn,
    downloadResolveCommand: (n) => `/Resources/sidecars/${n}/${n}`,
  });
  const seen: IngestPullProgress[] = [];
  await sidecar.pullModel((p) => seen.push(p));
  assert.deepEqual(
    seen.map((p) => p.status),
    ['downloading', 'success'],
  );
  assert.equal(seen[1]!.percent, 100);
});
