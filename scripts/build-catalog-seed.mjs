// scripts/build-catalog-seed.mjs — produce resources/sidecars/laccd-courses-pp-cli/seed/data.db
//
// Usage: CATALOG_CLI_BIN=/path/to/laccd-courses-pp-cli node scripts/build-catalog-seed.mjs
//
// Env:
//   CATALOG_CLI_BIN            path to the catalog CLI (default: PATH lookup)
//   CATALOG_SEED_HOME          reuse an existing --home instead of a fresh temp dir.
//                              The sync is incremental/resumable, so pointing at the
//                              home of a failed run RESUMES it instead of restarting.
//   CATALOG_SEED_SYNC_ATTEMPTS max sync passes before giving up (default 5)
//
// The district API is flaky over a full mirror (observed: http2 GOAWAY ~4,700 rows
// into a ~60min run), and the CLI's default exit policy downgrades a failed resource
// to a WARNING with exit 0. So a naive single `sync` silently yields a half catalog
// that still passes a "does search return rows?" check. This script therefore:
//   1. syncs with --strict (a failed resource is an error, not a warning),
//   2. retries — the sync is incremental, so each pass advances,
//   3. gates on the CLI's own `coverage --data-source live` (per-college synced vs
//      API-reported totals) and refuses to ship unless NOTHING is missing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = process.env.CATALOG_CLI_BIN || 'laccd-courses-pp-cli';
const MAX_ATTEMPTS = Number(process.env.CATALOG_SEED_SYNC_ATTEMPTS || 5);

const home = process.env.CATALOG_SEED_HOME
  ? path.resolve(process.env.CATALOG_SEED_HOME)
  : path.join(mkdtempSync(path.join(tmpdir(), 'catseed-')), 'home');
mkdirSync(path.join(home, 'data'), { recursive: true });
console.log(`catalog seed home: ${home}`);
console.log('(re-run with CATALOG_SEED_HOME=<that path> to resume a failed sync)');

/** Per-college synced-vs-live totals, straight from the CLI. */
function coverage() {
  const out = execFileSync(CLI, ['--home', home, 'coverage', '--data-source', 'live', '--agent'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const per = JSON.parse(out).per_college ?? [];
  if (per.length === 0) throw new Error('coverage returned no colleges — cannot verify completeness');
  if (per.some((c) => c.api_total < 0)) {
    throw new Error('coverage could not reach the live API — refusing to ship an unverified seed');
  }
  return {
    local: per.reduce((n, c) => n + c.local, 0),
    api: per.reduce((n, c) => n + c.api_total, 0),
    missing: per.reduce((n, c) => n + Math.max(c.missing, 0), 0),
    per,
  };
}

// 1) Sync into the home (colleges + courses power local search), retrying until complete.
let cov;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  console.log(`\nsync pass ${attempt}/${MAX_ATTEMPTS} (full mirror — slow)…`);
  try {
    execFileSync(CLI, ['--home', home, 'sync', '--strict', '--resources', 'colleges,courses'], { stdio: 'inherit' });
  } catch (err) {
    // Expected on a flaky pass. Coverage below decides whether we actually advanced.
    console.warn(`sync pass ${attempt} exited non-zero: ${err.message.split('\n')[0]}`);
  }
  cov = coverage();
  console.log(`coverage after pass ${attempt}: ${cov.local}/${cov.api} courses, ${cov.missing} missing`);
  if (cov.missing === 0) break;
}

// 2) COMPLETENESS GATE — a truncated mirror still searches fine, so nothing downstream
//    would catch it. This is the only check that can.
if (!cov || cov.missing > 0) {
  for (const c of cov?.per ?? []) {
    if (c.missing > 0) console.error(`  ${c.college}: ${c.local}/${c.api_total} (${c.missing} missing)`);
  }
  throw new Error(
    `seed completeness FAILED: ${cov?.missing} of ${cov?.api} courses missing after ${MAX_ATTEMPTS} passes — ` +
      `refusing to ship a partial catalog. Resume with CATALOG_SEED_HOME=${home}`,
  );
}
console.log(`\ncompleteness OK: ${cov.local}/${cov.api} courses across ${cov.per.length} colleges`);

// 3) Trim the copy in place.
execFileSync('python3', [path.join(ROOT, 'scripts/trim-catalog-seed.py'), path.join(home, 'data', 'data.db')], { stdio: 'inherit' });

// 4) SELF-VERIFY with the real CLI: a known query must return filtered, non-empty course rows.
const out = execFileSync(CLI, ['--home', home, 'search', 'accounting', '--type', 'courses', '--data-source', 'local', '--limit', '3', '--agent'], { encoding: 'utf8' });
const rows = (JSON.parse(out).results ?? []);
if (rows.length === 0 || !rows[0].code) {
  throw new Error('seed self-check FAILED: local search returned no course rows — refusing to ship a silent-empty seed');
}
console.log(`seed self-check OK: ${rows.length} rows, first=${rows[0].code}`);

// 5) Place under resources for staging.
const dst = path.join(ROOT, 'resources/sidecars/laccd-courses-pp-cli/seed');
mkdirSync(dst, { recursive: true });
copyFileSync(path.join(home, 'data', 'data.db'), path.join(dst, 'data.db'));
console.log(`seed staged: ${(statSync(path.join(dst, 'data.db')).size / 1048576).toFixed(0)} MB → ${dst}/data.db`);
