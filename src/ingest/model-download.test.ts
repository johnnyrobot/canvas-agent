import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import {
  downloadModels,
  resolveDownloadTooling,
  normalizeIngestProgress,
  IngestDownloadError,
  type DownloadSpawnLike,
} from './model-download.js';

/** Build a fake child whose stdout streams `lines` (NDJSON) then exits `code`. */
function fakeChild(lines: string[], code = 0, stderr = ''): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as unknown as { stdout: Readable }).stdout = Readable.from(lines);
  (child as unknown as { stderr: Readable }).stderr = Readable.from(stderr ? [stderr] : []);
  // Emit exit after the stream has been consumed.
  setImmediate(() => setImmediate(() => (child as unknown as EventEmitter).emit('exit', code)));
  return child;
}

const TOOLING = (n: string) => `/Resources/sidecars/${n}/${n}`; // pretend-packaged abs path

test('resolveDownloadTooling derives python + driver from the bundled launcher', () => {
  const t = resolveDownloadTooling(TOOLING);
  assert.deepEqual(t, {
    python: '/Resources/sidecars/docling-serve/python/bin/python3',
    driver: '/Resources/sidecars/docling-serve/download-models.py',
  });
});

test('resolveDownloadTooling returns undefined in dev (no bundled abs path)', () => {
  assert.equal(resolveDownloadTooling((n) => n), undefined);
});

test('normalizeIngestProgress derives percent from completed/total', () => {
  assert.deepEqual(normalizeIngestProgress({ status: 'downloading', model: 'layout', completed: 3, total: 6 }), {
    status: 'downloading',
    model: 'layout',
    completed: 3,
    total: 6,
    percent: 50,
  });
  assert.equal(normalizeIngestProgress({ status: 'success' }).percent, undefined);
});

test('downloadModels streams normalized per-model progress to completion', async () => {
  const lines = [
    '{"status":"downloading","model":"layout","completed":0,"total":2}\n',
    '{"status":"model_done","model":"layout","completed":1,"total":2}\n',
    '{"status":"downloading","model":"granite_docling","completed":1,"total":2}\n',
    '{"status":"success","completed":2,"total":2}\n',
  ];
  const captured: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: DownloadSpawnLike = (command, args) => {
    captured.push({ command, args });
    return fakeChild(lines, 0);
  };
  const seen = [];
  for await (const p of downloadModels({ modelsDir: '/data/models', spawnImpl: spawn, resolveCommand: TOOLING })) {
    seen.push(p);
  }
  assert.equal(captured[0]!.command, '/Resources/sidecars/docling-serve/python/bin/python3');
  assert.deepEqual(captured[0]!.args, ['/Resources/sidecars/docling-serve/download-models.py', '/data/models']);
  assert.deepEqual(
    seen.map((p) => p.status),
    ['downloading', 'model_done', 'downloading', 'success'],
  );
  assert.equal(seen[1]!.percent, 50);
  assert.equal(seen[3]!.percent, 100);
});

test('downloadModels throws on an {"error"} line from the driver', async () => {
  const spawn: DownloadSpawnLike = () => fakeChild(['{"error":"failed downloading layout: boom"}\n'], 1);
  await assert.rejects(async () => {
    for await (const _ of downloadModels({ modelsDir: '/d', spawnImpl: spawn, resolveCommand: TOOLING })) {
      // drain
    }
  }, /failed downloading layout/);
});

test('downloadModels throws on a non-zero exit even without an error line', async () => {
  const spawn: DownloadSpawnLike = () => fakeChild([], 3, 'segfault');
  await assert.rejects(async () => {
    for await (const _ of downloadModels({ modelsDir: '/d', spawnImpl: spawn, resolveCommand: TOOLING })) {
      // drain
    }
  }, /exited 3|segfault/);
});

test('downloadModels refuses to run in dev (no bundled Python)', async () => {
  await assert.rejects(async () => {
    for await (const _ of downloadModels({ modelsDir: '/d', resolveCommand: (n) => n })) {
      // drain
    }
  }, IngestDownloadError);
});

test('downloadModels really kills its child on abort — verified against a REAL process (#24)', async () => {
  // Everything the sidecar-level tests assert rests on one claim: Node's real
  // `child_process.spawn({ signal })` actually terminates the child when the
  // signal aborts. Manually confirmed once against `sleep` (real Node emits
  // 'error' with an AbortError, THEN 'exit' with code=null, signal='SIGTERM')
  // — this test proves the SAME thing through `downloadModels`'s own code, with
  // a real OS process, not a fake standing in for one. `spawnImpl` here ignores
  // the fake python/driver path `resolveDownloadTooling` derives and spawns a
  // real, harmless, long-running Node subprocess instead — but forwards
  // `options` (which carries the real `signal` `downloadModels` set) untouched,
  // so the abort really reaches a real child.
  let spawnedPid: number | undefined;
  const spawnRealButHarmless: DownloadSpawnLike = (_command, _args, options) => {
    const real = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    spawnedPid = real.pid;
    return real;
  };

  const controller = new AbortController();
  const run = (async () => {
    for await (const _ of downloadModels({
      modelsDir: '/d',
      spawnImpl: spawnRealButHarmless,
      resolveCommand: TOOLING,
      signal: controller.signal,
    })) {
      // drain
    }
  })();

  // Give the real child a moment to actually start before killing it.
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(spawnedPid, 'precondition: a real child process was spawned');

  controller.abort();
  await assert.rejects(run, /abort/i, 'downloadModels must surface the kill as a rejection, not hang or succeed');

  // The rejection alone already proves the child is gone (the code path
  // requires stdout to have closed, which only happens once the OS process
  // exits) — confirmed independently rather than trusted on inference.
  assert.throws(
    () => process.kill(spawnedPid!, 0),
    /ESRCH/,
    'the real OS process must no longer exist after the abort',
  );
});
