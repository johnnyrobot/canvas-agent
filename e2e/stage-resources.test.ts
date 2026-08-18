/**
 * `npm run stage:sidecars` must survive being run twice (#47).
 *
 * Re-staging is the COMMON case, not the edge case: you re-stage whenever one
 * sidecar's payload changes. The documented recipe in `docs/RELEASING.md` §3 is
 * a single command staging all three, and it worked exactly once — on a clean
 * tree. The second run died `EEXIST` partway through, at `ollama`, leaving a
 * half-updated tree the operator then had to reason about by hand.
 *
 * The trigger is SYMLINKS, and that detail is what makes these fixtures
 * non-vacuous. `cpSync`'s `force` overwrites an existing regular file happily,
 * so a fixture of plain files re-stages green against the BROKEN script and
 * proves nothing. It only throws when it must overwrite an existing symlink —
 * which is every real input here: the Ollama runner set is full of them, and so
 * is the bundled Python interpreter in the docling onedir app. Both are copied
 * `verbatimSymlinks`, deliberately, because `codesign --strict` rejects the
 * absolute paths Node would otherwise rewrite them to.
 *
 * These drive the real script through `node`, rather than importing a helper,
 * because the reported bug is the script's observable behaviour end to end:
 * exit code, what lands on disk, and what survives a failure. They stage into a
 * throwaway `CANVAS_AGENT_STAGE_ROOT` so a developer's real (multi-GB, slow to
 * rebuild) `resources/sidecars/` tree is never touched.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/stage-resources.mjs');

const scratch = mkdtempSync(path.join(tmpdir(), 'canvas-agent-stage-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
/** A private working dir per case, so failures leave inspectable, non-shared state. */
function workspace(): { src: string; dest: string } {
  const base = path.join(scratch, `case-${(seq += 1)}`);
  const src = path.join(base, 'src');
  const dest = path.join(base, 'dest');
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
  return { src, dest };
}

/**
 * A stand-in for the Ollama `Contents/Resources` runner set: the launcher, the
 * sibling `llama-server` the script asserts on, a dylib, and — the part that
 * matters — a RELATIVE symlink, which is what `cpSync` refuses to overwrite.
 */
function fakeOllamaResources(dir: string, marker: string): string {
  const res = path.join(dir, 'Resources');
  mkdirSync(res, { recursive: true });
  writeFileSync(path.join(res, 'ollama'), `#!/bin/sh\n# ${marker}\n`, { mode: 0o755 });
  writeFileSync(path.join(res, 'llama-server'), `#!/bin/sh\n# ${marker}\n`, { mode: 0o755 });
  writeFileSync(path.join(res, 'libggml.dylib'), marker);
  symlinkSync('libggml.dylib', path.join(res, 'libggml.1.dylib'));
  return res;
}

/** A stand-in for the docling onedir app: launcher at the immediate child, plus a symlink. */
function fakeDoclingDir(dir: string, marker: string, withLauncher = true): string {
  const app = path.join(dir, 'docling-app');
  mkdirSync(path.join(app, 'lib'), { recursive: true });
  if (withLauncher) writeFileSync(path.join(app, 'docling-serve'), `#!/bin/sh\n# ${marker}\n`, { mode: 0o755 });
  writeFileSync(path.join(app, 'lib/python3.13'), marker);
  symlinkSync('python3.13', path.join(app, 'lib/python3'));
  return app;
}

// Refuse to spawn at all unless the script still honours the redirect. Without
// this, a refactor that drops `CANVAS_AGENT_STAGE_ROOT` would not fail the suite
// — it would silently stage these fixtures over the developer's REAL sidecars,
// overwriting signed binaries with three-line shell scripts. That is not
// hypothetical: it is what happened when these tests were first written against
// a script that did not yet have the seam.
const SCRIPT_SOURCE = readFileSync(SCRIPT, 'utf8');
function assertRedirectSupported(): void {
  assert.ok(
    SCRIPT_SOURCE.includes('CANVAS_AGENT_STAGE_ROOT'),
    'scripts/stage-resources.mjs no longer reads CANVAS_AGENT_STAGE_ROOT — refusing to run, ' +
      'because these fixtures would stage over the real resources/sidecars/ tree.',
  );
}

function stage(env: Record<string, string>, dest: string) {
  assertRedirectSupported();
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    // A bare env: the developer's own OLLAMA_BIN / DOCLING_SERVE_DIR / CATALOG_CLI_BIN
    // would otherwise leak in and stage real multi-GB payloads into the scratch dir.
    env: { PATH: process.env.PATH ?? '', CANVAS_AGENT_STAGE_ROOT: dest, ...env },
  });
}

describe('stage:sidecars is idempotent (#47)', () => {
  test('re-staging over an already-staged tree succeeds', () => {
    const { src, dest } = workspace();
    const res = fakeOllamaResources(src, 'v1');
    const env = { OLLAMA_BIN: path.join(res, 'ollama'), OLLAMA_RESOURCES_DIR: res };

    const first = stage(env, dest);
    assert.equal(first.status, 0, `first stage should succeed:\n${first.stderr}`);

    const second = stage(env, dest);
    assert.equal(
      second.status,
      0,
      `re-staging must succeed, but the script failed:\n${second.stderr}`,
    );
    assert.ok(
      !/EEXIST/.test(second.stderr),
      `re-staging must not die EEXIST:\n${second.stderr}`,
    );
  });

  test('re-staging replaces the payload with the newer source', () => {
    const { src, dest } = workspace();
    const res = fakeOllamaResources(src, 'v1');
    const env = { OLLAMA_BIN: path.join(res, 'ollama'), OLLAMA_RESOURCES_DIR: res };
    assert.equal(stage(env, dest).status, 0);

    // Same paths, new contents — the reason anyone re-stages in the first place.
    writeFileSync(path.join(res, 'libggml.dylib'), 'v2');
    assert.equal(stage(env, dest).status, 0);

    const staged = path.join(dest, 'sidecars/ollama/libggml.dylib');
    assert.equal(readFileSync(staged, 'utf8'), 'v2', 'the staged tree must hold the NEW payload');
  });

  test('re-staging preserves the tracked .gitkeep marker', () => {
    // `resources/sidecars/<name>/.gitkeep` is tracked — it is what keeps the
    // directory in git. The documented `rm -rf` workaround deletes it, so the
    // operator has to notice and restore it or commit a spurious deletion.
    // Whatever replaces the copy must not inherit that trap.
    const { src, dest } = workspace();
    const res = fakeOllamaResources(src, 'v1');
    const env = { OLLAMA_BIN: path.join(res, 'ollama'), OLLAMA_RESOURCES_DIR: res };
    const gitkeep = path.join(dest, 'sidecars/ollama/.gitkeep');
    mkdirSync(path.dirname(gitkeep), { recursive: true });
    writeFileSync(gitkeep, '');

    assert.equal(stage(env, dest).status, 0);
    assert.ok(existsSync(gitkeep), '.gitkeep must survive a first stage');

    assert.equal(stage(env, dest).status, 0);
    assert.ok(existsSync(gitkeep), '.gitkeep must survive a RE-stage');
  });

  test('a rejected source leaves the previously staged payload intact', () => {
    // Staging must be atomic per sidecar. The docling launcher assertion fires
    // AFTER the copy, so a bad source used to overwrite a good staged tree and
    // THEN fail — leaving a tree that reads as staged but cannot spawn.
    const { src, dest } = workspace();
    const good = fakeDoclingDir(path.join(src, 'good'), 'good');
    assert.equal(stage({ DOCLING_SERVE_DIR: good }, dest).status, 0);

    const launcher = path.join(dest, 'sidecars/docling-serve/docling-serve');
    assert.ok(existsSync(launcher), 'precondition: the good source stages a launcher');

    const bad = fakeDoclingDir(path.join(src, 'bad'), 'bad', false);
    const rejected = stage({ DOCLING_SERVE_DIR: bad }, dest);
    assert.equal(rejected.status, 1, 'a launcher-less source must be rejected');
    // Distinguish a REJECTION from a CRASH. Against the unfixed script this case
    // "passed" for the wrong reason: the copy died EEXIST on an existing symlink
    // before it could clobber anything, so the good launcher survived by accident
    // rather than by design. Naming the real complaint is what makes it a test.
    assert.match(
      rejected.stderr,
      /no launcher at/,
      `must fail by NAMING the missing launcher, not by crashing:\n${rejected.stderr}`,
    );
    assert.ok(!/EEXIST/.test(rejected.stderr), `must not crash EEXIST:\n${rejected.stderr}`);
    assert.ok(
      existsSync(launcher),
      'the previously staged payload must survive a rejected re-stage, not be half-overwritten',
    );
    assert.match(readFileSync(launcher, 'utf8'), /good/, 'the surviving payload must be the GOOD one');
  });
});
