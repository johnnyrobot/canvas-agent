/**
 * Packaged-`.app` smoke test (SHIP-READINESS blocker #3 — the packaged half).
 *
 * Skipped by default. The dev bridge checks (`scripts/check-bridge.mjs`) drive
 * `electron .` from `dist/`, which CANNOT catch asar / path / preload /
 * `resourcesPath` breakage that only manifests in a built artifact. This launches
 * the actual packaged `.app` and asserts the privileged seam survives packaging:
 *   - the contextBridge preload exposes the full AppApi,
 *   - `health()` resolves over IPC (main ↔ renderer wiring intact),
 *   - a build turn that emits HTML is GATED — exercising the BUNDLED Chromium
 *     auditor (the `process.resourcesPath` → `ms-playwright` resolution) end to end.
 *     A packaged app with no bundled browser would reject here instead.
 *   - the bundled catalog CLI + its ~900 MB seed survive packaging: the binary sits
 *     at the resolver leaf, first launch copies the seed into the writable home,
 *     local search returns rows from that seed, and `catalogGet` serves LIVE detail.
 *     This one matters because the catalog wiring is deliberately FAIL-SAFE (any
 *     error yields `undefined` so the app still runs) — so in a packaged build a
 *     broken bundle degrades silently. These assertions are what make it loud.
 *
 * Run (on the arm64 build machine, after `npm run package`, sidecars up):
 *   RUN_PACKAGED_SMOKE=1 CANVAS_AGENT_APP="release/mac-arm64/Canvas Agent.app" \
 *     npx tsx --test e2e/packaged-smoke.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { resolveAppPaths } from '../src/storage/paths.js';

/** Shape of the bridge we exercise (type-only; erased at runtime inside evaluate). */
interface BridgeWindow {
  canvasAgent: {
    runTurn(req: { user: string; mode?: string }): Promise<{
      text: string;
      fragments: { gate?: { badgeWithheld?: boolean } }[];
    }>;
    health(): Promise<{ llm: boolean; ingest: boolean }>;
    catalogAvailable(): Promise<boolean>;
    catalogSearch(query: string): Promise<{ id: number; code: string; title: string; college?: string }[]>;
    catalogGet(id: number): Promise<{ id: number; code: string; slos: string[]; source: 'live' | 'mirror' }>;
  };
}

const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes'].includes((v ?? '').toLowerCase());
const optedIn = truthy(process.env.RUN_PACKAGED_SMOKE);
const appPathEnv = process.env.CANVAS_AGENT_APP;

/** Resolve the executable inside a macOS `.app` (or accept a direct executable path). */
function resolveExecutable(p: string): string | null {
  if (!existsSync(p)) return null;
  if (p.endsWith('.app')) {
    const macos = path.join(p, 'Contents', 'MacOS');
    if (!existsSync(macos)) return null;
    const entries = readdirSync(macos);
    return entries[0] ? path.join(macos, entries[0]) : null;
  }
  return statSync(p).isFile() ? p : null;
}

const executablePath = appPathEnv ? resolveExecutable(appPathEnv) : null;
const skip: string | false = !optedIn
  ? 'set RUN_PACKAGED_SMOKE=1 (and CANVAS_AGENT_APP=path/to/Canvas Agent.app) to run'
  : !appPathEnv
    ? 'set CANVAS_AGENT_APP to the packaged .app'
    : !executablePath
      ? `no executable found under ${appPathEnv}`
      : false;

test('packaged .app exposes the bridge, resolves health, and gates an emitted fragment', { skip }, async () => {
  const app = await electron.launch({ executablePath: executablePath as string, args: [] });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('#app', { timeout: 30_000 });
    await win.waitForSelector('[data-testid="inst-task-build"]', { timeout: 30_000 });

    // 1. The contextBridge preload exposes the AppApi in the packaged renderer.
    const bridge = await win.evaluate(() => {
      const w = globalThis as unknown as BridgeWindow;
      return {
        hasRunTurn: typeof w.canvasAgent?.runTurn === 'function',
        methods: w.canvasAgent ? Object.keys(w.canvasAgent).sort() : [],
      };
    });
    assert.equal(bridge.hasRunTurn, true, 'window.canvasAgent.runTurn must be exposed in the packaged app');
    for (const m of ['runTurn', 'health', 'saveCanvasAuth', 'importCanvas']) {
      assert.ok(bridge.methods.includes(m), `bridge must expose ${m} (saw: ${bridge.methods.join(',')})`);
    }

    // 2. health() resolves over IPC (proves main↔renderer wiring, not just preload).
    const health = await win.evaluate(() => (globalThis as unknown as BridgeWindow).canvasAgent.health());
    assert.equal(typeof health.llm, 'boolean');
    assert.equal(typeof health.ingest, 'boolean');

    // 3. A build turn that emits HTML must be GATED — driving the bundled Chromium
    //    auditor end to end. If the browser were missing, enforceGate's audit would
    //    throw and this rejects (fail-closed), which is the failure we want to catch.
    const view = await win.evaluate(() =>
      (globalThis as unknown as BridgeWindow).canvasAgent.runTurn({
        user: 'Build a short welcome page titled "Hello".',
        mode: 'build',
      }),
    );
    assert.equal(typeof view.text, 'string');
    assert.ok(Array.isArray(view.fragments), 'a TurnView always carries a fragments array');
    for (const f of view.fragments) {
      assert.ok(f.gate && typeof f.gate.badgeWithheld === 'boolean', 'every emitted fragment carries a gate verdict');
    }
  } finally {
    await app.close();
  }
});

test('packaged .app bundles the catalog CLI + seed, copies the home, and serves local search', { skip }, async () => {
  // 1. Bundle layout — the exact leaf `resolveSidecarCommand` spawns, plus the seed
  //    beside it. Checked from disk (not via the app) so a staging miss is reported
  //    as a staging miss, rather than surfacing as a confusing runtime degradation.
  const resources = path.join(appPathEnv as string, 'Contents', 'Resources');
  const cliPath = path.join(resources, 'sidecars', 'laccd-courses-pp-cli', 'laccd-courses-pp-cli');
  const seedPath = path.join(resources, 'sidecars', 'laccd-courses-pp-cli', 'seed', 'data.db');
  assert.ok(existsSync(cliPath), `bundled catalog CLI must exist at ${cliPath}`);
  assert.ok((statSync(cliPath).mode & 0o111) !== 0, 'bundled catalog CLI must be executable');
  assert.ok(existsSync(seedPath), `bundled catalog seed must exist at ${seedPath}`);
  // A partial mirror searches fine but silently misses whole colleges, so assert the
  // seed is plausibly WHOLE, not merely present (a complete trimmed seed is ~900 MB;
  // an aborted sync once produced 461 MB at 4,700 of 9,701 courses).
  const seedMb = statSync(seedPath).size / 1048576;
  assert.ok(seedMb > 700, `bundled seed looks partial: ${seedMb.toFixed(0)} MB (expected ~900 MB+)`);

  const app = await electron.launch({ executablePath: executablePath as string, args: [] });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('#app', { timeout: 30_000 });

    // 2. The bundled client is wired in. `packagedCatalogClient()` is fail-safe by
    //    design (returns undefined on any error so the app still runs), which means a
    //    broken bundle degrades SILENTLY — this assertion is what makes it loud.
    const available = await win.evaluate(() =>
      (globalThis as unknown as BridgeWindow).canvasAgent.catalogAvailable(),
    );
    assert.equal(available, true, 'packaged app must resolve the bundled catalog CLI (fail-safe wiring hides breakage otherwise)');

    // 3. First run copies the read-only bundled seed into the writable home. The
    //    bundle itself is read-only and the CLI opens its DB read-write, so without
    //    this copy every query fails.
    const homeDb = path.join(resolveAppPaths().catalogHomeDir, 'data', 'data.db');
    assert.ok(existsSync(homeDb), `first launch must copy the seed to ${homeDb}`);
    assert.ok(
      Math.abs(statSync(homeDb).size - statSync(seedPath).size) < 1024,
      'the copied home DB must match the bundled seed byte-for-byte in size (a short copy means a truncated catalog)',
    );

    // 4. Search is LOCAL by construction (the client passes --data-source local,
    //    because live search measured ~17s). So this exercises the bundled seed, not
    //    the network — the point of shipping ~900 MB.
    const rows = await win.evaluate(() =>
      (globalThis as unknown as BridgeWindow).canvasAgent.catalogSearch('accounting'),
    );
    assert.ok(rows.length > 0, 'local catalog search must return rows from the bundled seed');
    assert.ok(rows[0]?.code, 'a catalog row carries a course code');
    assert.equal(typeof rows[0]?.id, 'number');

    // 5. GET is LIVE (2.4s, and SLOs must be current, not a stale mirror). `source`
    //    proves which path served it — a 'mirror' here means the live call silently
    //    fell back and the user is reading stale outcomes.
    const course = await win.evaluate(
      (id) => (globalThis as unknown as BridgeWindow).canvasAgent.catalogGet(id),
      rows[0]!.id,
    );
    assert.equal(course.id, rows[0]!.id);
    assert.equal(course.source, 'live', 'catalogGet must serve LIVE detail (a "mirror" source means it fell back to stale data)');
    assert.ok(Array.isArray(course.slos), 'a fetched course carries an SLO array');
  } finally {
    await app.close();
  }
});
