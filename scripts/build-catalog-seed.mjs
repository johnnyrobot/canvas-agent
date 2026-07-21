// scripts/build-catalog-seed.mjs — produce resources/sidecars/laccd-courses-pp-cli/seed/data.db
// Usage: CATALOG_CLI_BIN=/path/to/laccd-courses-pp-cli node scripts/build-catalog-seed.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = process.env.CATALOG_CLI_BIN || 'laccd-courses-pp-cli';
const work = mkdtempSync(path.join(tmpdir(), 'catseed-'));
const home = path.join(work, 'home');
mkdirSync(path.join(home, 'data'), { recursive: true });

// 1) Full sync into an isolated home (colleges + courses power local search).
console.log('syncing catalog (this is slow — full mirror)…');
execFileSync(CLI, ['--home', home, 'sync', '--resources', 'colleges,courses'], { stdio: 'inherit' });

// 2) Trim the copy in place.
execFileSync('python3', [path.join(ROOT, 'scripts/trim-catalog-seed.py'), path.join(home, 'data', 'data.db')], { stdio: 'inherit' });

// 3) SELF-VERIFY with the real CLI: a known query must return filtered, non-empty course rows.
const out = execFileSync(CLI, ['--home', home, 'search', 'accounting', '--type', 'courses', '--data-source', 'local', '--limit', '3', '--agent'], { encoding: 'utf8' });
const rows = (JSON.parse(out).results ?? []);
if (rows.length === 0 || !rows[0].code) {
  throw new Error('seed self-check FAILED: local search returned no course rows — refusing to ship a silent-empty seed');
}
console.log(`seed self-check OK: ${rows.length} rows, first=${rows[0].code}`);

// 4) Place under resources for staging.
const dst = path.join(ROOT, 'resources/sidecars/laccd-courses-pp-cli/seed');
mkdirSync(dst, { recursive: true });
copyFileSync(path.join(home, 'data', 'data.db'), path.join(dst, 'data.db'));
console.log(`seed staged: ${(statSync(path.join(dst, 'data.db')).size / 1048576).toFixed(0)} MB → ${dst}/data.db`);
