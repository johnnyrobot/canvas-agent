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
import { existsSync, mkdirSync, copyFileSync, cpSync, realpathSync, readdirSync, rmSync, chmodSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

let staged = 0;
const missing = [];

if (ollamaBin && existsSync(ollamaBin)) {
  const dst = path.join(ROOT, 'resources/sidecars/ollama');
  mkdirSync(dst, { recursive: true });
  // `ollama serve` does NOT run standalone: it spawns a SIBLING `llama-server`
  // runner and loads sibling dylibs + mlx_metal_* via @loader_path. So the WHOLE
  // Ollama.app/Contents/Resources tree must travel, not just the `ollama` binary.
  // OLLAMA_BIN is usually a symlink (/usr/local/bin/ollama → Ollama.app/.../ollama);
  // resolve it to find the real Resources dir. OLLAMA_RESOURCES_DIR overrides.
  const realOllama = realpathSync(ollamaBin);
  const srcRes = process.env.OLLAMA_RESOURCES_DIR || path.dirname(realOllama);
  // verbatimSymlinks keeps symlinks RELATIVE; without it Node rewrites them to absolute
  // paths, which `codesign --strict` rejects ("invalid destination for symbolic link").
  cpSync(srcRes, dst, { recursive: true, dereference: false, verbatimSymlinks: true });
  // Drop app-icon junk; keep every runtime binary/dylib/metallib.
  for (const name of readdirSync(dst)) {
    if (/\.(icns|png)$/i.test(name)) rmSync(path.join(dst, name), { force: true });
  }
  // Guarantee the resolver leaf name `ollama`, and that the runner is present.
  if (!existsSync(path.join(dst, 'ollama'))) copyFileSync(realOllama, path.join(dst, 'ollama'));
  if (!existsSync(path.join(dst, 'llama-server'))) {
    console.error(`✗ staged Ollama from ${srcRes}, but no \`llama-server\` runner at sidecars/ollama/llama-server.`);
    console.error('  `ollama serve` spawns llama-server as a sibling — point OLLAMA_BIN (or');
    console.error('  OLLAMA_RESOURCES_DIR) at the full Ollama.app Contents/Resources dir.');
    process.exit(1);
  }
  console.log(`✓ staged Ollama runner set from ${srcRes} → sidecars/ollama/ (ollama + llama-server + dylibs + mlx_metal_*)`);
  staged += 1;
} else {
  missing.push('OLLAMA_BIN — path to the `ollama` binary (e.g. "$(command -v ollama)")');
}

if (doclingDir && existsSync(doclingDir)) {
  const dst = path.join(ROOT, 'resources/sidecars/docling-serve');
  mkdirSync(dst, { recursive: true });
  // verbatimSymlinks: keep the PBS interpreter's symlinks RELATIVE (python3 -> python3.13
  // etc.); without it Node rewrites them absolute → codesign --strict rejects + breaks relocation.
  cpSync(doclingDir, dst, { recursive: true, verbatimSymlinks: true });
  // The runtime spawns sidecars/docling-serve/docling-serve. cpSync copies the source
  // dir's CONTENTS, so the launcher lands at the leaf ONLY when DOCLING_SERVE_DIR's
  // immediate child is the `docling-serve` executable. Assert it rather than letting a
  // mis-stage fall back to a bare-PATH lookup that ENOENTs in a Finder-launched .app.
  const launcher = path.join(dst, 'docling-serve');
  if (!existsSync(launcher)) {
    console.error(`✗ docling-serve staged from ${doclingDir}, but no launcher at sidecars/docling-serve/docling-serve.`);
    console.error('  Point DOCLING_SERVE_DIR at the onedir app dir whose immediate child is the');
    console.error('  `docling-serve` executable (e.g. ".../dist/docling-serve"), NOT the parent "dist".');
    process.exit(1);
  }
  console.log(`✓ staged docling-serve from ${doclingDir} → sidecars/docling-serve/docling-serve`);
  staged += 1;
} else {
  missing.push('DOCLING_SERVE_DIR — the docling-serve onedir app dir (immediate child = `docling-serve` launcher)');
}

if (catalogBin && existsSync(catalogBin)) {
  const dst = path.join(ROOT, 'resources/sidecars/laccd-courses-pp-cli');
  mkdirSync(dst, { recursive: true });
  const realCatalog = realpathSync(catalogBin);
  // Single self-contained binary (unlike ollama/docling): copy it to the resolver leaf
  // name. `afterPack.cjs` re-signs it with Developer ID as part of the nested-Mach-O pass,
  // so an ad-hoc/linker-signed local build is a fine input here.
  const leaf = path.join(dst, 'laccd-courses-pp-cli');
  copyFileSync(realCatalog, leaf);
  chmodSync(leaf, 0o755);
  if (!isArm64MachO(leaf)) {
    console.error(`✗ staged catalog CLI from ${realCatalog}, but it is not a thin arm64 Mach-O.`);
    console.error('  This app ships arm64-only — point CATALOG_CLI_BIN at an arm64 build.');
    process.exit(1);
  }
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
