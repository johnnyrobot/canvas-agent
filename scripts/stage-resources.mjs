#!/usr/bin/env node
/**
 * Stage the on-device sidecar binaries into `resources/sidecars/` for packaging.
 * The binaries are large and machine-specific, so they are NEVER committed — this
 * copies them from your local installs, pointed at by env vars:
 *
 *   OLLAMA_BIN          path to the `ollama` executable        → resources/sidecars/ollama/
 *                       (typically a symlink into Ollama.app; the WHOLE
 *                        Contents/Resources runner set is copied, since
 *                        `ollama serve` spawns a sibling `llama-server` + dylibs)
 *   OLLAMA_RESOURCES_DIR optional explicit override for the Ollama Resources dir
 *   DOCLING_SERVE_DIR   the docling-serve onedir app dir       → resources/sidecars/docling-serve/
 *                       (its IMMEDIATE child must be the `docling-serve` launcher,
 *                        e.g. PyInstaller's `.../dist/docling-serve`, NOT the parent `dist`)
 *   CATALOG_CLI_BIN     path to the `laccd-courses-pp-cli` arm64 binary
 *                                                             → resources/sidecars/laccd-courses-pp-cli/
 *                       (single self-contained binary; its 898 MB course seed must
 *                        already be built — `node scripts/build-catalog-seed.mjs`)
 *
 * The runtime (`resolveSidecarCommand`) spawns each sidecar from the fixed leaf
 * path `<resources>/sidecars/<name>/<name>`, so staging MUST land the launcher
 * there. This script enforces that for both sidecars (ollama by canonical name,
 * docling by post-copy assertion) — a mis-stage fails here, not silently at runtime.
 *
 * Chromium for the audit engine is staged separately: `npm run stage:browsers`.
 * After staging, `npm run pre-release -- --strict` verifies everything is present.
 */
import { existsSync, mkdirSync, copyFileSync, cpSync, realpathSync, readdirSync, renameSync, rmSync, chmodSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Where staged payloads land. Defaults to the packaged-resources dir; overridable
// so a run can be pointed at a throwaway tree — which is how the suite exercises
// this script without touching a developer's real (multi-GB, slow to rebuild)
// staging dir. `resolveSidecarCommand` reads the default path at runtime, so a
// real staging run must leave this unset.
const STAGE_ROOT = process.env.CANVAS_AGENT_STAGE_ROOT
  ? path.resolve(process.env.CANVAS_AGENT_STAGE_ROOT)
  : path.join(ROOT, 'resources');
const sidecarDest = (name) => path.join(STAGE_ROOT, 'sidecars', name);
const ollamaBin = process.env.OLLAMA_BIN;
const doclingDir = process.env.DOCLING_SERVE_DIR;
const catalogBin = process.env.CATALOG_CLI_BIN;

/** True when `file` is a thin arm64 Mach-O (the only arch this app ships). */
function isArm64MachO(file) {
  const head = Buffer.alloc(8);
  const fd = openSync(file, 'r');
  try {
    if (readSync(fd, head, 0, 8, 0) < 8) return false;
  } finally {
    closeSync(fd);
  }
  // 64-bit little-endian Mach-O: magic 0xfeedfacf, cputype CPU_TYPE_ARM64 (0x0100000c).
  return head.readUInt32LE(0) === 0xfeedfacf && head.readUInt32LE(4) === 0x0100000c;
}

/**
 * Replace `dst` with a freshly built tree, atomically (#47).
 *
 * `build(tmp)` populates a scratch sibling and returns an error string if the
 * result is unusable; only when it returns nothing does the new tree take the
 * destination's place. Two problems that both cost a release run:
 *
 *   1. Copying straight onto a staged tree dies `EEXIST`. `cpSync`'s `force`
 *      replaces an existing regular file but NOT an existing symlink, and both
 *      real inputs are full of symlinks (the Ollama runner set; the bundled
 *      Python interpreter). So re-staging — the common case, whenever one
 *      payload changes — failed partway and left a half-updated tree.
 *   2. Validating after copying is too late. The launcher assertion fired
 *      against a destination that had already been overwritten, so a bad source
 *      destroyed a good staged payload and THEN complained. Worse, a stale
 *      launcher left over from the previous stage could satisfy the assertion
 *      and wave the mis-stage through.
 *
 * Building in `tmp` fixes both: the destination is untouched until the payload
 * is known-good, and the check can only see what this run actually staged.
 */
function stageAtomically(dst, build) {
  const tmp = `${dst}.staging-${process.pid}`;
  const previous = `${dst}.previous-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  let error;
  try {
    error = build(tmp);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (error) {
    rmSync(tmp, { recursive: true, force: true });
    return error;
  }
  // `resources/sidecars/<name>/.gitkeep` is tracked — it is what keeps the
  // directory in git. The old `rm -rf` workaround deleted it, so the operator
  // had to spot the deletion and restore it by hand; a swap would do the same
  // silently. Re-create it as part of the new tree instead.
  writeFileSync(path.join(tmp, '.gitkeep'), '');
  // rename(2) refuses a non-empty destination, so move the old tree aside first.
  // Both renames are within one directory, hence one filesystem, hence atomic.
  const hadPrevious = existsSync(dst);
  if (hadPrevious) renameSync(dst, previous);
  renameSync(tmp, dst);
  if (hadPrevious) rmSync(previous, { recursive: true, force: true });
  return undefined;
}

let staged = 0;
const missing = [];

if (ollamaBin && existsSync(ollamaBin)) {
  const dst = sidecarDest('ollama');
  // `ollama serve` does NOT run standalone: it spawns a SIBLING `llama-server`
  // runner and loads sibling dylibs + mlx_metal_* via @loader_path. So the WHOLE
  // Ollama.app/Contents/Resources tree must travel, not just the `ollama` binary.
  // OLLAMA_BIN is usually a symlink (/usr/local/bin/ollama → Ollama.app/.../ollama);
  // resolve it to find the real Resources dir. OLLAMA_RESOURCES_DIR overrides.
  const realOllama = realpathSync(ollamaBin);
  const srcRes = process.env.OLLAMA_RESOURCES_DIR || path.dirname(realOllama);
  const failure = stageAtomically(dst, (tmp) => {
    // verbatimSymlinks keeps symlinks RELATIVE; without it Node rewrites them to absolute
    // paths, which `codesign --strict` rejects ("invalid destination for symbolic link").
    cpSync(srcRes, tmp, { recursive: true, dereference: false, verbatimSymlinks: true });
    // Drop app-icon junk; keep every runtime binary/dylib/metallib.
    for (const name of readdirSync(tmp)) {
      if (/\.(icns|png)$/i.test(name)) rmSync(path.join(tmp, name), { force: true });
    }
    // Guarantee the resolver leaf name `ollama`, and that the runner is present.
    if (!existsSync(path.join(tmp, 'ollama'))) copyFileSync(realOllama, path.join(tmp, 'ollama'));
    if (!existsSync(path.join(tmp, 'llama-server'))) return 'no `llama-server` runner';
    return undefined;
  });
  if (failure) {
    console.error(`✗ staged Ollama from ${srcRes}, but ${failure} at sidecars/ollama/llama-server.`);
    console.error('  `ollama serve` spawns llama-server as a sibling — point OLLAMA_BIN (or');
    console.error('  OLLAMA_RESOURCES_DIR) at the full Ollama.app Contents/Resources dir.');
    console.error('  (Any previously staged payload was left untouched.)');
    process.exit(1);
  }
  console.log(`✓ staged Ollama runner set from ${srcRes} → sidecars/ollama/ (ollama + llama-server + dylibs + mlx_metal_*)`);
  staged += 1;
} else {
  missing.push('OLLAMA_BIN — path to the `ollama` binary (e.g. "$(command -v ollama)")');
}

if (doclingDir && existsSync(doclingDir)) {
  const dst = sidecarDest('docling-serve');
  const failure = stageAtomically(dst, (tmp) => {
    // verbatimSymlinks: keep the PBS interpreter's symlinks RELATIVE (python3 -> python3.13
    // etc.); without it Node rewrites them absolute → codesign --strict rejects + breaks relocation.
    cpSync(doclingDir, tmp, { recursive: true, verbatimSymlinks: true });
    // The runtime spawns sidecars/docling-serve/docling-serve. cpSync copies the source
    // dir's CONTENTS, so the launcher lands at the leaf ONLY when DOCLING_SERVE_DIR's
    // immediate child is the `docling-serve` executable. Assert it rather than letting a
    // mis-stage fall back to a bare-PATH lookup that ENOENTs in a Finder-launched .app.
    // Checked inside `tmp`, so a leftover launcher from a previous stage cannot
    // vouch for a source that does not have one.
    if (!existsSync(path.join(tmp, 'docling-serve'))) return 'no launcher at';
    return undefined;
  });
  if (failure) {
    console.error(`✗ docling-serve staged from ${doclingDir}, but ${failure} sidecars/docling-serve/docling-serve.`);
    console.error('  Point DOCLING_SERVE_DIR at the onedir app dir whose immediate child is the');
    console.error('  `docling-serve` executable (e.g. ".../dist/docling-serve"), NOT the parent "dist".');
    console.error('  (Any previously staged payload was left untouched.)');
    process.exit(1);
  }
  console.log(`✓ staged docling-serve from ${doclingDir} → sidecars/docling-serve/docling-serve`);
  staged += 1;
} else {
  missing.push('DOCLING_SERVE_DIR — the docling-serve onedir app dir (immediate child = `docling-serve` launcher)');
}

if (catalogBin && existsSync(catalogBin)) {
  // Deliberately NOT staged through `stageAtomically`: unlike the other two, this
  // destination is not wholly derived from its source. The ~900 MB course seed is
  // built directly INTO `<dst>/seed/` by `build-catalog-seed.mjs` over roughly an
  // hour, so replacing the directory would delete it. Copying one file over
  // another is already idempotent, which is why this block never had the EEXIST
  // problem — `copyFileSync` overwrites a regular file, and there are no symlinks
  // here to refuse.
  const dst = sidecarDest('laccd-courses-pp-cli');
  mkdirSync(dst, { recursive: true });
  const realCatalog = realpathSync(catalogBin);
  // Validate the SOURCE before touching the staged leaf. Copying first and checking
  // after would leave the rejected binary in place: `pre-release --strict` only
  // checks that the leaf is executable, so a later `npm run package` would happily
  // ship the x86_64/universal/non-Mach-O binary this run just rejected.
  if (!isArm64MachO(realCatalog)) {
    console.error(`✗ CATALOG_CLI_BIN is not a thin arm64 Mach-O: ${realCatalog}`);
    console.error('  This app ships arm64-only — point CATALOG_CLI_BIN at an arm64 build.');
    console.error('  (The previously staged binary, if any, was left untouched.)');
    process.exit(1);
  }
  // Single self-contained binary (unlike ollama/docling): copy it to the resolver leaf
  // name. `afterPack.cjs` re-signs it with Developer ID as part of the nested-Mach-O pass,
  // so an ad-hoc/linker-signed local build is a fine input here.
  const leaf = path.join(dst, 'laccd-courses-pp-cli');
  copyFileSync(realCatalog, leaf);
  chmodSync(leaf, 0o755);
  // The binary without its seed is a silent failure: the app starts, catalog search
  // resolves, and every offline query returns zero rows. Build it first:
  //   CATALOG_CLI_BIN=… node scripts/build-catalog-seed.mjs
  const seed = path.join(dst, 'seed/data.db');
  if (!existsSync(seed)) {
    console.error('✗ staged the catalog CLI, but there is no seed at sidecars/laccd-courses-pp-cli/seed/data.db.');
    console.error('  Without it the packaged app ships an EMPTY catalog — offline search returns nothing.');
    console.error('  Build it first: CATALOG_CLI_BIN=… node scripts/build-catalog-seed.mjs');
    process.exit(1);
  }
  const seedMb = (statSync(seed).size / 1048576).toFixed(0);
  console.log(`✓ staged catalog CLI from ${realCatalog} → sidecars/laccd-courses-pp-cli/ (binary + ${seedMb} MB seed)`);
  staged += 1;
} else {
  missing.push('CATALOG_CLI_BIN — path to the `laccd-courses-pp-cli` arm64 binary (e.g. "$(command -v laccd-courses-pp-cli)")');
}

if (missing.length > 0) {
  console.error('\nstage:sidecars — point these env vars at your local installs, then re-run:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Chromium is staged separately: npm run stage:browsers');
  process.exit(staged > 0 ? 0 : 1);
}
console.log(`\nstage:sidecars: ${staged} sidecar(s) staged into resources/sidecars/.`);
