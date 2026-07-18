import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createCatalogClient } from './client.js';
import type { CliExecError, CliExecResult, ExecFileLike } from './client.js';
import { CatalogError } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_FIXTURE = readFileSync(path.join(HERE, 'fixtures', 'search-response.json'), 'utf8');
const GET_FIXTURE = readFileSync(path.join(HERE, 'fixtures', 'get-response.json'), 'utf8');

// ── Test doubles ─────────────────────────────────────────────────────────────

/** A fake `execFile` that records every invocation and returns/rejects canned results. No real spawn ever happens. */
function fakeExecFile(handler: (file: string, args: readonly string[]) => Promise<CliExecResult>) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const execFile: ExecFileLike = async (file, args) => {
    calls.push({ file, args });
    return handler(file, args);
  };
  return { execFile, calls };
}

function ok(stdout: string): Promise<CliExecResult> {
  return Promise.resolve({ stdout, stderr: '' });
}

function execError(opts: Partial<CliExecError> & { message: string }): Promise<never> {
  const err = new Error(opts.message) as CliExecError;
  Object.assign(err, opts);
  return Promise.reject(err);
}

// ── searchCourses ────────────────────────────────────────────────────────────

test('searchCourses parses real SLO-shaped results, incl. id from _links.self.href', async () => {
  const { execFile, calls } = fakeExecFile(() => ok(SEARCH_FIXTURE));
  const client = createCatalogClient({ execFile });

  const results = await client.searchCourses('accounting');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, 'laccd-courses-pp-cli');
  assert.deepEqual(calls[0]!.args, [
    'search', 'accounting', '--type', 'courses', '--limit', '25', '--agent', '--data-source', 'local',
  ]);

  assert.equal(results.length, 2);
  // Both fixture rows are the same course code at different colleges — id comes
  // from the numeric suffix of `_links.self.href` ("/public/courses/40830").
  assert.equal(results[0]!.id, 40830);
  assert.equal(results[0]!.code, 'ACCTG001');
  assert.equal(results[0]!.title, 'Introductory Accounting I');
  assert.equal(results[0]!.college, 'wlac.elumenapp.com');
});

test('searchCourses passes the raw query through argv, never through a shell string', async () => {
  const { execFile, calls } = fakeExecFile(() => ok('{"meta":{"source":"live"},"results":[]}'));
  const client = createCatalogClient({ execFile });

  await client.searchCourses('accounting; rm -rf /');

  assert.deepEqual(calls[0]!.args, [
    'search', 'accounting; rm -rf /', '--type', 'courses', '--limit', '25', '--agent', '--data-source', 'local',
  ]);
});

test('searchCourses skips a row with no parseable id rather than surfacing junk', async () => {
  const { execFile } = fakeExecFile(() =>
    ok(
      JSON.stringify({
        meta: { source: 'live' },
        results: [
          { code: 'X001', name: 'No id here', _links: {} },
          { id: 5, code: 'Y002', name: 'Has an id' },
        ],
      }),
    ),
  );
  const client = createCatalogClient({ execFile });

  const results = await client.searchCourses('x');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.code, 'Y002');
});

test('searchCourses returns [] when the envelope has no results array', async () => {
  const { execFile } = fakeExecFile(() => ok('{"meta":{"source":"live"}}'));
  const client = createCatalogClient({ execFile });
  assert.deepEqual(await client.searchCourses('nothing'), []);
});

// ── getCourse ────────────────────────────────────────────────────────────────

test('getCourse parses nested fullCourseInfo: real SLOs, objectives (ordered), units, description', async () => {
  const { execFile, calls } = fakeExecFile(() => ok(GET_FIXTURE));
  const client = createCatalogClient({ execFile });

  const course = await client.getCourse(40830);

  assert.deepEqual(calls[0]!.args, ['courses', 'get', '40830', '--agent', '--data-source', 'auto']);
  assert.equal(course.id, 40830);
  assert.equal(course.code, 'ACCTG001');
  assert.equal(course.title, 'Introductory Accounting I');
  assert.equal(course.college, 'wlac.elumenapp.com');
  assert.equal(course.units, 5);
  assert.match(course.description!, /study of accounting as an information system/);
  assert.equal(course.source, 'live');

  // SLOs are ONLY the outcomeLevel === "CSLO" rows.
  assert.equal(course.slos.length, 2);
  assert.match(course.slos[0]!, /complete an accounting cycle/);
  assert.match(course.slos[1]!, /prepare basic financial statements/);

  // Objectives are in authored sequence order (0, 1, 2, ...), not insertion order.
  assert.ok(course.objectives.length >= 3);
  assert.match(course.objectives[0]!, /^1 - Explain the nature/);
  assert.match(course.objectives[1]!, /^2 - Explain and apply/);
});

test('getCourse tolerates a malformed fullCourseInfo string: typed parse error, not a throw-through crash', async () => {
  const { execFile } = fakeExecFile(() =>
    ok(
      JSON.stringify({
        meta: { source: 'live' },
        results: {
          id: 999,
          code: 'BAD001',
          name: 'Broken',
          tenant: 'lacc.elumenapp.com',
          fullCourseInfo: '{not valid json',
        },
      }),
    ),
  );
  const client = createCatalogClient({ execFile });

  await assert.rejects(
    () => client.getCourse(999),
    (err: unknown) => {
      assert.ok(err instanceof CatalogError);
      assert.equal(err.kind, 'parse');
      return true;
    },
  );
});

test('getCourse degrades to a shell record when fullCourseInfo is absent (no error)', async () => {
  const { execFile } = fakeExecFile(() =>
    ok(JSON.stringify({ meta: { source: 'local' }, results: { id: 7, code: 'NOFCI001', name: 'Shell only' } })),
  );
  const client = createCatalogClient({ execFile });

  const course = await client.getCourse(7);
  assert.equal(course.id, 7);
  assert.equal(course.code, 'NOFCI001');
  assert.deepEqual(course.slos, []);
  assert.deepEqual(course.objectives, []);
  assert.equal(course.units, undefined);
  assert.equal(course.source, 'mirror'); // meta.source "local" maps to 'mirror'
});

test('a malformed outer JSON envelope (non-JSON stdout) is a typed parse error', async () => {
  const { execFile } = fakeExecFile(() => ok('not json at all'));
  const client = createCatalogClient({ execFile });

  await assert.rejects(
    () => client.getCourse(1),
    (err: unknown) => err instanceof CatalogError && err.kind === 'parse',
  );
});

// ── Exit-code / failure mapping ──────────────────────────────────────────────

test('a 404-shaped CLI failure maps to a notFound CatalogError', async () => {
  const { execFile } = fakeExecFile(() =>
    execError({
      message: 'Command failed',
      code: 1,
      stderr: 'Error: GET /public/courses/999999999 returned HTTP 404: {"message":"Course not found"}',
    }),
  );
  const client = createCatalogClient({ execFile });

  await assert.rejects(
    () => client.getCourse(999999999),
    (err: unknown) => err instanceof CatalogError && err.kind === 'notFound',
  );
});

test('a 429-shaped CLI failure maps to a rateLimited CatalogError', async () => {
  const { execFile } = fakeExecFile(() =>
    execError({ message: 'Command failed', code: 1, stderr: 'Error: HTTP 429: rate limit exceeded' }),
  );
  const client = createCatalogClient({ execFile });

  await assert.rejects(
    () => client.searchCourses('x'),
    (err: unknown) => err instanceof CatalogError && err.kind === 'rateLimited',
  );
});

test('a 5xx-shaped CLI failure maps to a cliError CatalogError', async () => {
  const { execFile } = fakeExecFile(() =>
    execError({ message: 'Command failed', code: 1, stderr: 'Error: HTTP 502: Internal server error' }),
  );
  const client = createCatalogClient({ execFile });

  await assert.rejects(
    () => client.getCourse(1),
    (err: unknown) => err instanceof CatalogError && err.kind === 'cliError',
  );
});

test('the documented typed exit codes (3/7/10) are honored when stderr has no HTTP status', async () => {
  const client = createCatalogClient({
    execFile: fakeExecFile(() => execError({ message: 'not found', code: 3, stderr: '' })).execFile,
  });
  await assert.rejects(
    () => client.getCourse(1),
    (err: unknown) => err instanceof CatalogError && err.kind === 'notFound',
  );

  const client2 = createCatalogClient({
    execFile: fakeExecFile(() => execError({ message: 'throttled', code: 7, stderr: '' })).execFile,
  });
  await assert.rejects(
    () => client2.searchCourses('x'),
    (err: unknown) => err instanceof CatalogError && err.kind === 'rateLimited',
  );

  const client3 = createCatalogClient({
    execFile: fakeExecFile(() => execError({ message: 'bad config', code: 10, stderr: '' })).execFile,
  });
  await assert.rejects(
    () => client3.searchCourses('x'),
    (err: unknown) => err instanceof CatalogError && err.kind === 'unavailable',
  );
});

test('a killed (timed-out) invocation maps to a timeout CatalogError', async () => {
  const { execFile } = fakeExecFile(() => execError({ message: 'Command failed', killed: true, signal: 'SIGTERM' }));
  const client = createCatalogClient({ execFile, timeoutMs: 15_000 });

  await assert.rejects(
    () => client.searchCourses('x'),
    (err: unknown) => err instanceof CatalogError && err.kind === 'timeout' && /15000ms/.test(err.message),
  );
});

test('an ENOENT spawn failure maps to an unavailable CatalogError', async () => {
  const { execFile } = fakeExecFile(() => execError({ message: 'spawn laccd-courses-pp-cli ENOENT', code: 'ENOENT' }));
  const client = createCatalogClient({ execFile });

  await assert.rejects(
    () => client.getCourse(1),
    (err: unknown) => err instanceof CatalogError && err.kind === 'unavailable',
  );
});

// ── available() ──────────────────────────────────────────────────────────────

test('available() resolves true when the CLI probe exits 0', async () => {
  const { execFile, calls } = fakeExecFile(() => ok('{"schema_version":"4"}'));
  const client = createCatalogClient({ execFile });

  assert.equal(await client.available(), true);
  assert.deepEqual(calls[0]!.args, ['agent-context']);
});

test('available() resolves false (never throws) when the binary is missing', async () => {
  const { execFile } = fakeExecFile(() => execError({ message: 'spawn laccd-courses-pp-cli ENOENT', code: 'ENOENT' }));
  const client = createCatalogClient({ execFile });

  assert.equal(await client.available(), false);
});

test('available() resolves false when the probe exits non-zero for any other reason', async () => {
  const { execFile } = fakeExecFile(() => execError({ message: 'boom', code: 1, stderr: 'unexpected failure' }));
  const client = createCatalogClient({ execFile });

  assert.equal(await client.available(), false);
});

// ── Command resolution / no real spawn ───────────────────────────────────────

test('a configured command path is used verbatim as the spawned file', async () => {
  const { execFile, calls } = fakeExecFile(() => ok('{"meta":{"source":"live"},"results":[]}'));
  const client = createCatalogClient({ execFile, command: '/opt/homebrew/bin/laccd-courses-pp-cli' });

  await client.searchCourses('x');
  assert.equal(calls[0]!.file, '/opt/homebrew/bin/laccd-courses-pp-cli');
});

test('getCourse rejects a fullCourseInfo that parses to a non-object with a parse CatalogError', async () => {
  const { execFile } = fakeExecFile(() =>
    ok(
      JSON.stringify({
        meta: { source: 'live' },
        results: {
          code: 'X001',
          fullCourseInfo: 'null',
          _links: { self: { href: '/public/courses/5' } },
        },
      }),
    ),
  );
  const client = createCatalogClient({ execFile });

  await assert.rejects(
    () => client.getCourse(5),
    (err: unknown) => err instanceof CatalogError && err.kind === 'parse',
  );
});

test('getCourse rejects invalid ids before anything reaches the CLI argv', async () => {
  const { execFile, calls } = fakeExecFile(() => ok('{}'));
  const client = createCatalogClient({ execFile });

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3, 1.5]) {
    await assert.rejects(
      () => client.getCourse(bad),
      (err: unknown) => err instanceof CatalogError && err.kind === 'parse',
      `expected id ${String(bad)} to be rejected`,
    );
  }
  assert.equal(calls.length, 0, 'no CLI invocation for invalid ids');
});

test('a configured home prefixes --home on every invocation (search, get, probe)', async () => {
  const { execFile, calls } = fakeExecFile((_f, args) =>
    args.includes('agent-context') ? ok('{"ok":true}') : ok('{"meta":{"source":"local"},"results":[]}'),
  );
  const client = createCatalogClient({ execFile, home: '/u/catalog-home' });
  await client.available();
  await client.searchCourses('x');
  // The stub envelope has no resolvable course, so parsing rejects — we only
  // assert the argv prefix here, which the fake records before parsing.
  await client.getCourse(5).catch(() => {});
  assert.deepEqual(calls[0]!.args.slice(0, 2), ['--home', '/u/catalog-home']); // agent-context probe
  assert.deepEqual(calls[1]!.args.slice(0, 2), ['--home', '/u/catalog-home']); // search
  assert.deepEqual(calls[2]!.args.slice(0, 2), ['--home', '/u/catalog-home']); // get
});
