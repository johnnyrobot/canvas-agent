import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasPublisher, PublishError } from './publish.js';
import type { ExecLike, PublishExecResult } from './publish.js';

// ── Test doubles ─────────────────────────────────────────────────────────────

interface Call {
  file: string;
  args: readonly string[];
  stdinData: string | undefined;
}

/** A fake exec that records every invocation. No real process is ever spawned. */
function fakeExec(handler: (file: string, args: readonly string[]) => Promise<PublishExecResult>) {
  const calls: Call[] = [];
  const exec: ExecLike = async (file, args, options) => {
    calls.push({ file, args, stdinData: options.stdinData });
    return handler(file, args);
  };
  return { exec, calls };
}

function ok(stdout: string): Promise<PublishExecResult> {
  return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
}

const DOCTOR_JSON = JSON.stringify({ base_url: 'https://canvas.example.edu', auth: 'configured' });
const UPDATE_JSON = JSON.stringify({ action: 'put', resource: 'pages', status: 200 });

const PAGE = {
  baseUrl: 'https://canvas.example.edu',
  courseId: '204',
  pageId: 'welcome-week-1',
  html: '<h2>Welcome</h2>',
};

// ── publishPage happy path ───────────────────────────────────────────────────

test('publishPage: doctor preflight then pages update with the body over STDIN, never argv', async () => {
  const { exec, calls } = fakeExec((_file, args) => (args[0] === 'doctor' ? ok(DOCTOR_JSON) : ok(UPDATE_JSON)));
  const publisher = createCanvasPublisher({ exec });

  const result = await publisher.publishPage(PAGE);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.args, ['doctor', '--agent']);
  assert.deepEqual(calls[1]!.args, ['pages', 'update', '204', 'welcome-week-1', '--stdin', '--agent']);
  // The HTML travels only via stdin, as the CLI's request-body JSON.
  assert.equal(calls[1]!.stdinData, JSON.stringify({ wiki_page: { body: PAGE.html, notify_of_update: false } }));
  assert.ok(!calls[1]!.args.some((a) => a.includes('<h2>')), 'page HTML must never appear in argv');
  assert.equal(result.canvasUrl, 'https://canvas.example.edu/courses/204/pages/welcome-week-1');
});

// ── Guardrails ───────────────────────────────────────────────────────────────

test('publishPage refuses when the CLI is configured for a DIFFERENT Canvas host', async () => {
  const { exec, calls } = fakeExec((_file, args) =>
    args[0] === 'doctor' ? ok(JSON.stringify({ base_url: 'https://other.instructure.com' })) : ok(UPDATE_JSON),
  );
  const publisher = createCanvasPublisher({ exec });

  await assert.rejects(publisher.publishPage(PAGE), (err: PublishError) => err.kind === 'hostMismatch');
  // The preflight must short-circuit: no `pages update` was ever attempted.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, ['doctor', '--agent']);
});

test('publishPage validates course/page ids before anything reaches argv', async () => {
  const { exec, calls } = fakeExec(() => ok(DOCTOR_JSON));
  const publisher = createCanvasPublisher({ exec });

  for (const bad of ['--yes', 'a b', 'x/../y', '', '-lead']) {
    await assert.rejects(
      publisher.publishPage({ ...PAGE, pageId: bad }),
      (err: PublishError) => err.kind === 'invalidId',
    );
  }
  assert.equal(calls.length, 0, 'no CLI call may happen on an invalid id');
});

test('publishPage maps a missing binary to unavailable', async () => {
  const exec: ExecLike = () => {
    const err = new Error('spawn canvas-pp-cli ENOENT') as Error & { code: string };
    err.code = 'ENOENT';
    return Promise.reject(err);
  };
  const publisher = createCanvasPublisher({ exec });
  await assert.rejects(publisher.publishPage(PAGE), (err: PublishError) => err.kind === 'unavailable');
});

test('publishPage maps a timeout kill to timeout', async () => {
  const exec: ExecLike = () => {
    const err = new Error('timed out') as Error & { killed: boolean };
    err.killed = true;
    return Promise.reject(err);
  };
  const publisher = createCanvasPublisher({ exec, timeoutMs: 5 });
  await assert.rejects(publisher.publishPage(PAGE), (err: PublishError) => err.kind === 'timeout');
});

test('publishPage surfaces a non-zero exit as cliError with stderr detail', async () => {
  const { exec } = fakeExec((_file, args) =>
    args[0] === 'doctor'
      ? ok(DOCTOR_JSON)
      : Promise.resolve({ stdout: '', stderr: 'returned HTTP 401: bad token', exitCode: 1 }),
  );
  const publisher = createCanvasPublisher({ exec });
  await assert.rejects(
    publisher.publishPage(PAGE),
    (err: PublishError) => err.kind === 'cliError' && /HTTP 401/.test(err.message),
  );
});

test('publishPage maps non-JSON stdout to parse', async () => {
  const { exec } = fakeExec((_file, args) => (args[0] === 'doctor' ? ok(DOCTOR_JSON) : ok('PUT ok (not json)')));
  const publisher = createCanvasPublisher({ exec });
  await assert.rejects(publisher.publishPage(PAGE), (err: PublishError) => err.kind === 'parse');
});

test('configuredBase rejects with parse when doctor reports no base_url', async () => {
  const { exec } = fakeExec(() => ok(JSON.stringify({ auth: 'configured' })));
  const publisher = createCanvasPublisher({ exec });
  await assert.rejects(publisher.configuredBase(), (err: PublishError) => err.kind === 'parse');
});

test('publishPage refuses a scheme/path mismatch, not just a host mismatch', async () => {
  // Same host, different scheme — the full-base preflight must still refuse.
  const { exec, calls } = fakeExec((_file, args) =>
    args[0] === 'doctor' ? ok(JSON.stringify({ base_url: 'http://canvas.example.edu' })) : ok(UPDATE_JSON),
  );
  const publisher = createCanvasPublisher({ exec });
  await assert.rejects(
    publisher.publishPage({ ...PAGE, baseUrl: 'https://canvas.example.edu' }),
    (err: PublishError) => err.kind === 'hostMismatch',
  );
  assert.equal(calls.length, 1, 'preflight short-circuits before any pages update');
});

// ── available() ──────────────────────────────────────────────────────────────

test('available probes agent-context and never throws', async () => {
  const good = createCanvasPublisher({ exec: fakeExec(() => ok('{}')).exec });
  assert.equal(await good.available(), true);

  const bad = createCanvasPublisher({
    exec: () => {
      const err = new Error('ENOENT') as Error & { code: string };
      err.code = 'ENOENT';
      return Promise.reject(err);
    },
  });
  assert.equal(await bad.available(), false);
});

test('available returns false when the probe RESOLVES with a non-zero exit code', async () => {
  // A present-but-broken binary: exec resolves (no throw) but exits non-zero.
  const publisher = createCanvasPublisher({
    exec: () => Promise.resolve({ stdout: '', stderr: 'bad config', exitCode: 1 }),
  });
  assert.equal(await publisher.available(), false);
});
