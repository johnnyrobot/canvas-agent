#!/usr/bin/env node
/**
 * Stage the on-device sidecar binaries into `resources/sidecars/` for packaging.
 * The binaries are large and machine-specific, so they are NEVER committed — this
 * copies them from your local installs, pointed at by env vars:
 *
 *   OLLAMA_BIN          path to the `ollama` executable        → resources/sidecars/ollama/ollama
 *   DOCLING_SERVE_DIR   the docling-serve onedir app dir       → resources/sidecars/docling-serve/
 *                       (its IMMEDIATE child must be the `docling-serve` launcher,
 *                        e.g. PyInstaller's `.../dist/docling-serve`, NOT the parent `dist`)
 *
 * The runtime (`resolveSidecarCommand`) spawns each sidecar from the fixed leaf
 * path `<resources>/sidecars/<name>/<name>`, so staging MUST land the launcher
 * there. This script enforces that for both sidecars (ollama by canonical name,
 * docling by post-copy assertion) — a mis-stage fails here, not silently at runtime.
 *
 * Chromium for the audit engine is staged separately: `npm run stage:browsers`.
 * After staging, `npm run pre-release -- --strict` verifies everything is present.
 */
import { existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ollamaBin = process.env.OLLAMA_BIN;
const doclingDir = process.env.DOCLING_SERVE_DIR;

let staged = 0;
const missing = [];

if (ollamaBin && existsSync(ollamaBin)) {
  const dst = path.join(ROOT, 'resources/sidecars/ollama');
  mkdirSync(dst, { recursive: true });
  // Force the canonical leaf name `ollama` regardless of the source filename, so the
  // runtime resolver (sidecars/ollama/ollama) always finds it even if OLLAMA_BIN is a
  // renamed/versioned/symlinked binary.
  copyFileSync(ollamaBin, path.join(dst, 'ollama'));
  console.log(`✓ staged ollama from ${ollamaBin} → sidecars/ollama/ollama`);
  staged += 1;
} else {
  missing.push('OLLAMA_BIN — path to the `ollama` binary (e.g. "$(command -v ollama)")');
}

if (doclingDir && existsSync(doclingDir)) {
  const dst = path.join(ROOT, 'resources/sidecars/docling-serve');
  mkdirSync(dst, { recursive: true });
  cpSync(doclingDir, dst, { recursive: true });
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

if (missing.length > 0) {
  console.error('\nstage:sidecars — point these env vars at your local installs, then re-run:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Chromium is staged separately: npm run stage:browsers');
  process.exit(staged > 0 ? 0 : 1);
}
console.log(`\nstage:sidecars: ${staged} sidecar(s) staged into resources/sidecars/.`);
