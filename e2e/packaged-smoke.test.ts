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

/** Shape of the bridge we exercise (type-only; erased at runtime inside evaluate). */
interface BridgeWindow {
  canvasAgent: {
    runTurn(req: { user: string; mode?: string }): Promise<{
      text: string;
      fragments: { gate?: { badgeWithheld?: boolean } }[];
    }>;
    health(): Promise<{ llm: boolean; ingest: boolean }>;
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
    await win.waitForSelector('#prompt', { timeout: 30_000 });

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
