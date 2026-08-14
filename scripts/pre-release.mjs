#!/usr/bin/env node
/**
 * Pre-release gate (SHIP-READINESS blocker #2): assert the electron-builder mac
 * config is COHERENT before invoking it, so a DMG can never be cut against missing
 * paths (the historical failure: `resources/` + `build-resources/` did not exist
 * and `scripts.package` was undefined — packaging would have hard-failed).
 *
 * Two tiers:
 *   - REQUIRED (always): the config references real, existing structure — the
 *     buildResources dir, both entitlements files, every `extraResources.from`
 *     directory, and the `package`/`verify` npm scripts.
 *   - STAGED (required only with `--strict`, which `npm run package` uses): each
 *     `extraResources.from` actually contains its (gitignored, machine-staged)
 *     payload, each bundled sidecar launcher sits at the leaf path the runtime
 *     resolver spawns (`sidecars/<name>/<name>`), AND — when notarization is on —
 *     the Apple notary credentials are present in the env (electron-builder skips
 *     notarization SILENTLY without them, so this is the real fail-closed guard),
 *     AND every shipped model default still resolves on the registry and reports
 *     the capability its role needs (#40 — the one check here that leaves the
 *     machine, so the one that must fail closed when it cannot).
 *     A fresh checkout passes the structure tier; an actual build must pass the
 *     staged tier too (run the `stage:*` scripts first, export credentials).
 *
 * Exit 0 when all applicable checks pass, 1 otherwise. No dependencies.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build ?? {};

/** @type {{ok:boolean, level:'required'|'staged', label:string, detail:string}[]} */
const results = [];
const check = (ok, level, label, detail = '') => results.push({ ok: !!ok, level, label, detail });

/** Total size of `dir` in MB, recursively. 0 when absent/unreadable. */
function dirSizeMb(dir) {
  if (!existsSync(dir)) return 0;
  let bytes = 0;
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      bytes += statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
    }
  } catch {
    return 0;
  }
  return bytes / 1048576;
}

/**
 * "Staged" means the extraResources entry holds real payload. A directory counts
 * when it has a real child beyond .gitkeep / dotfiles; a single file entry (e.g.
 * THIRD-PARTY-NOTICES.md) counts when it is non-empty. `readdirSync` on a file
 * throws, so a file MUST be handled before the directory branch.
 */
function hasPayload(p) {
  if (!existsSync(p)) return false;
  if (statSync(p).isFile()) return statSync(p).size > 0;
  return readdirSync(p).some((n) => n !== '.gitkeep' && !n.startsWith('.'));
}

// 1. npm scripts the release flow depends on.
check(typeof pkg.scripts?.package === 'string', 'required', 'package.json has a `package` script', pkg.scripts?.package ?? '(missing)');
check(typeof pkg.scripts?.verify === 'string', 'required', 'package.json has a `verify` script', pkg.scripts?.verify ?? '(missing)');

// 2. buildResources directory.
const buildResDir = path.join(ROOT, build.directories?.buildResources ?? 'build-resources');
check(existsSync(buildResDir), 'required', 'buildResources dir exists', path.relative(ROOT, buildResDir));

// 3. mac entitlements files (referenced; only used at the cert-gated signing step,
//    but their absence still breaks a configured build).
for (const key of ['entitlements', 'entitlementsInherit']) {
  const rel = build.mac?.[key];
  if (!rel) { check(false, 'required', `mac.${key} configured`, '(missing)'); continue; }
  const p = path.join(ROOT, rel);
  check(existsSync(p) && statSync(p).isFile() && statSync(p).size > 0, 'required', `mac.${key} file exists & non-empty`, rel);
}

// 4. extraResources: the path must exist (structure) and be populated (staged).
for (const res of build.extraResources ?? []) {
  const from = path.join(ROOT, res.from);
  check(existsSync(from), 'required', `extraResources path exists: ${res.from}`, path.relative(ROOT, from));
  const staged = hasPayload(from);
  check(staged, 'staged', `extraResources payload staged: ${res.from}`,
    staged ? 'present' : 'EMPTY — run the matching stage:* script');

  // For a sidecar (resources/sidecars/<name>), a populated dir is NOT enough: the
  // runtime spawns the launcher from the fixed leaf `<name>/<name>` (see
  // resolveSidecarCommand). Assert that exact leaf exists, or a mis-stage (wrong
  // nesting / renamed launcher) sails past --strict and only ENOENTs at runtime in
  // the packaged .app.
  const sidecar = /(?:^|[\\/])sidecars[\\/]([^\\/]+)$/.exec(res.from);
  if (sidecar) {
    const name = sidecar[1];
    const leaf = path.join(from, name);
    // A directory or non-executable at the leaf would pass a bare existsSync but
    // still ENOENT/EACCES at spawn time, so assert it is an executable regular file.
    const leafOk =
      existsSync(leaf) && statSync(leaf).isFile() && (statSync(leaf).mode & 0o111) !== 0;
    check(leafOk, 'staged', `sidecar launcher present & executable: sidecars/${name}/${name}`,
      leafOk ? 'present' : 'MISSING/not-executable — resolveSidecarCommand spawns this exact path; re-stage so the launcher lands here');
    // Ollama is not standalone: `ollama serve` spawns a sibling `llama-server` runner.
    if (name === 'ollama') {
      const runner = path.join(from, 'llama-server');
      const runnerOk =
        existsSync(runner) && statSync(runner).isFile() && (statSync(runner).mode & 0o111) !== 0;
      check(runnerOk, 'staged', 'ollama runner present & executable: sidecars/ollama/llama-server',
        runnerOk ? 'present' : 'MISSING/not-executable — `ollama serve` spawns llama-server as a sibling; stage the full runner set');
    }
    // The catalog CLI is useless without its course seed: the binary spawns fine and
    // every offline search silently returns zero rows. A bare launcher check would
    // pass that. Assert the seed is present and plausibly WHOLE — a half-finished
    // mirror also searches fine, it just misses half the district (an aborted sync
    // produced a 461 MB seed at 4,700/9,701 courses). A complete trimmed seed is
    // ~900 MB+; build-catalog-seed.mjs gates on live per-college coverage, this is
    // the cheap backstop for a stale/partial staging dir.
    if (name === 'laccd-courses-pp-cli') {
      const seed = path.join(from, 'seed/data.db');
      const seedMb = existsSync(seed) && statSync(seed).isFile() ? statSync(seed).size / 1048576 : 0;
      const seedOk = seedMb > 700;
      check(seedOk, 'staged', 'catalog seed present: sidecars/laccd-courses-pp-cli/seed/data.db',
        seedOk ? `present (${seedMb.toFixed(0)} MB)`
          : `MISSING/PARTIAL (${seedMb.toFixed(0)} MB, expected ~900 MB+) — offline catalog search would be empty or miss whole colleges; rebuild with \`CATALOG_CLI_BIN=… node scripts/build-catalog-seed.mjs\``);
    }
    // The document models ship INSIDE the app (ADR-0008), so ingestion is offline
    // out of the box and the first-run download is gone. Stage them with
    // DOCLING_BUNDLE_MODELS=1. Gate on SIZE, not presence: `download_models`
    // fetches several models in sequence, so an interrupted or partially-failed
    // fetch leaves a populated-but-incomplete dir that a presence check waves
    // through — exactly how a 461 MB half-mirrored catalog once passed. A
    // complete payload (classic pipeline + Granite-Docling MLX) is ~1.2 GB;
    // 800 MB is the floor. Re-tighten it once a real build has been measured.
    if (name === 'docling-serve') {
      const models = path.join(from, 'models');
      const mb = dirSizeMb(models);
      const ok = mb > 800;
      check(ok, 'staged', 'docling models bundled: sidecars/docling-serve/models',
        ok ? `present (${mb.toFixed(0)} MB)`
          : `MISSING/PARTIAL (${mb.toFixed(0)} MB, expected ~1.2 GB) — PDF and scanned-image conversion would need a first-run download; re-stage with \`DOCLING_BUNDLE_MODELS=1 npm run stage:sidecars\``);
    }
  }
}

// 5. Notarization credentials — only meaningful for an actual signed release build,
//    so it is a `staged`-tier check (enforced under --strict, advisory otherwise).
//    electron-builder 26.x SILENTLY SKIPS notarization (warning only, build succeeds)
//    when `mac.notarize` is enabled but NO credential family is in the env — shipping a
//    signed-but-un-notarized DMG that Gatekeeper rejects on other Macs. This guard makes
//    `npm run package` genuinely fail-closed instead.
if (build.mac?.notarize === true) {
  const credA = !!(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
  const credB = !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
  // A notarytool keychain profile alone is sufficient — it resolves via the default
  // keychain search list. (Do NOT also set APPLE_KEYCHAIN to a path: store-credentials
  // items are not found by an explicit --keychain lookup, so it breaks notarization.)
  const credK = !!process.env.APPLE_KEYCHAIN_PROFILE;
  const haveCreds = credA || credB || credK;
  check(haveCreds, 'staged', 'notarization credentials present (one full family)',
    haveCreds
      ? `present (${credA ? 'API key' : credB ? 'Apple ID' : 'keychain profile'})`
      : 'MISSING — export ONE of: Option A (APPLE_API_KEY/_ID/_ISSUER), Option B (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID), or Option C (APPLE_KEYCHAIN_PROFILE alone — do NOT also set APPLE_KEYCHAIN); else electron-builder skips notarization silently');
}

// 6. Shipped model defaults: each one still RESOLVES on the registry, and reports
//    the capability its role requires (#40). Same `staged` tier as the checks
//    above — enforced under --strict, advisory otherwise — because it is only
//    meaningful for a real release build, and because it needs a network and a
//    local Ollama that a fresh checkout has neither of.
//
//    Both halves have already shipped broken once. A tag whose registry entry is
//    renamed after release strands every user behind an `ollama pull` recovery
//    that resolves to nothing; and a tag that pulls perfectly can still be unable
//    to see, which is exactly how alt-text suggestion broke while every screen
//    read ready. The decision logic is pure and unit-tested offline
//    (`src/runtime/release-model-gate.ts`); this supplies the real probe.
//
//    Read from `dist/` on purpose: the shipped defaults live in `src/runtime`, so
//    the gate follows a default swap automatically instead of restating tags a
//    build script could not keep in sync. `npm run package` builds first; a
//    stand-alone strict run must too, and says so when it has not.
try {
  const [{ checkShippedModelTags }, { probeShippedTag }] = await Promise.all([
    import('../dist/runtime/release-model-gate.js'),
    import('./model-tag-probe.mjs'),
  ]);
  for (const c of await checkShippedModelTags(probeShippedTag)) {
    check(c.ok, 'staged', c.label, c.detail);
  }
} catch (err) {
  check(false, 'staged', 'shipped model defaults checked against the registry',
    `UNCHECKABLE (${err instanceof Error ? err.message : String(err)}) — run \`npm run build\` first; this gate reads the shipped defaults out of dist/`);
}

// Report.
let failed = 0;
for (const r of results) {
  const isRequired = r.level === 'required' || (r.level === 'staged' && strict);
  const mark = r.ok ? '✓' : isRequired ? '✗' : '⚠';
  if (!r.ok && isRequired) failed += 1;
  console.log(`${mark} [${r.level}] ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log('');
if (failed > 0) {
  console.error(`pre-release: ${failed} required check(s) failed${strict ? ' (strict)' : ''}. Fix the above before packaging.`);
  process.exit(1);
}
console.log(
  strict
    ? 'pre-release: all checks passed (strict — payloads staged). Safe to invoke electron-builder.'
    : 'pre-release: structure checks passed. Run `npm run pre-release -- --strict` (after staging) before an actual build.',
);
