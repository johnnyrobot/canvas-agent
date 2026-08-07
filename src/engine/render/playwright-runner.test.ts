import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Browser } from 'playwright';
import {
  AXE_RULE_OVERRIDES,
  AXE_TAGS,
  createPlaywrightRunner,
  resolveBundledBrowsersPath,
} from './playwright-runner.js';

// Browser-free: asserts the COVERAGE CLAIM encoded in the axe tag set. The product
// states WCAG 2.2 AA; axe-core 4.12 tags rules by version+level, so the scan must
// run the Level A + AA umbrella tags across 2.0, 2.1 AND 2.2 — otherwise the
// "passed checks" badge and coverage banner overstate what was actually checked.
test('axe runs the full WCAG A+AA rule set through WCAG 2.2 (coverage claim)', () => {
  for (const tag of ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']) {
    assert.ok(AXE_TAGS.includes(tag), `AXE_TAGS must include "${tag}" to back the WCAG 2.2 AA claim`);
  }
});

test('axe excludes best-practice and AAA rules (only definite WCAG A/AA failures gate)', () => {
  // best-practice and AAA rules are not WCAG 2.2 AA failures; running them would
  // manufacture false "failures" and dishonestly withhold the badge.
  assert.ok(!AXE_TAGS.includes('best-practice'), 'best-practice rules are not WCAG conformance failures');
  assert.ok(!AXE_TAGS.includes('wcag2aaa'), 'AAA is above the AA conformance target');
});

// ── Packaged-Chromium resolution (the gate must launch a real browser in the .app) ──

test('resolveBundledBrowsersPath points at <resources>/ms-playwright when it exists (packaged)', () => {
  const resources = '/Applications/Canvas Agent.app/Contents/Resources';
  const expected = path.join(resources, 'ms-playwright');
  const got = resolveBundledBrowsersPath(resources, (p) => p === expected);
  assert.equal(got, expected, 'packaged app must resolve its bundled Chromium, not a dev cache');
});

test('resolveBundledBrowsersPath is undefined in dev/test (no resourcesPath or dir absent)', () => {
  // No resourcesPath (plain node/tsx) → fall back to playwright default cache.
  assert.equal(resolveBundledBrowsersPath(undefined, () => true), undefined);
  // resourcesPath present but nothing bundled (dev electron) → default cache.
  assert.equal(resolveBundledBrowsersPath('/some/Resources', () => false), undefined);
});

// ── Rule opt-ins (offline guard) ─────────────────────────────────────────────

test('the two gap-closing axe rules stay enabled', () => {
  // Silently dropping either re-opens a real gap found on 8 live Canvas courses:
  // axe ships `td-has-header` (wcag2a/1.3.1) as EXPERIMENTAL and `heading-order`
  // as BEST-PRACTICE, so both are off by default and neither fired on 314 real
  // pages that plainly have those defects. The gated browser tests in
  // integration.test.ts assert the resulting severities; this one just makes sure
  // the opt-ins cannot vanish without a failing test offline.
  assert.equal(AXE_RULE_OVERRIDES['td-has-header']?.enabled, true);
  assert.equal(AXE_RULE_OVERRIDES['heading-order']?.enabled, true);
});

test('rule opt-ins do not widen the WCAG tag set', () => {
  // They are per-rule opt-ins precisely so we do NOT pull in `best-practice`
  // wholesale, which would drag in dozens of unrelated non-WCAG rules.
  assert.ok(!AXE_TAGS.includes('best-practice'));
  assert.ok(!AXE_TAGS.includes('experimental'));
});

// ── Browser lifetime (ADR-0005) ───────────────────────────────────────────────
// These never launch Chromium either: they inject the `launch` seam and assert
// only how often it is called and when the browser is closed. The real
// render-and-scan behaviour is covered by the env-gated `integration.test.ts`.

/**
 * A browser that hands out contexts but whose pages cannot be created, so every
 * `run()` fails AFTER the launch and AFTER the context exists. That is exactly
 * the shape these tests need: the launch is the expensive thing to count, a
 * failed scan must not invalidate a healthy browser, and the context must still
 * be closed on the way out.
 */
function fakeBrowser() {
  let closed = 0;
  let contexts = 0;
  let contextCloses = 0;
  const browser = {
    newContext: async () => {
      contexts += 1;
      return {
        newPage: () => Promise.reject(new Error('no real browser in this test')),
        close: async () => {
          contextCloses += 1;
        },
      };
    },
    close: async () => {
      closed += 1;
    },
  } as unknown as Browser;
  return {
    browser,
    closes: () => closed,
    contexts: () => contexts,
    contextCloses: () => contextCloses,
  };
}

function fakeLaunch() {
  let launches = 0;
  const browsers: Array<ReturnType<typeof fakeBrowser>> = [];
  const launch = async () => {
    launches += 1;
    const b = fakeBrowser();
    browsers.push(b);
    return b.browser;
  };
  return { launch, launches: () => launches, browsers };
}

test('the browser is launched lazily — constructing a runner touches nothing', async () => {
  const l = fakeLaunch();
  createPlaywrightRunner({ launch: l.launch });
  assert.equal(l.launches(), 0, 'constructing a runner must not launch Chromium');
});

test('one browser is REUSED across every run() on the same runner', async () => {
  const l = fakeLaunch();
  const runner = createPlaywrightRunner({ launch: l.launch });

  // Five scans — the measured remediate-turn worst case (before + 1 repair + 3 re-audits).
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => runner.run('<p>x</p>'));
  }

  assert.equal(l.launches(), 1, 'five scans, one Chromium launch');
});

test('concurrent run() calls share a single launch', async () => {
  const l = fakeLaunch();
  const runner = createPlaywrightRunner({ launch: l.launch });

  await Promise.allSettled([runner.run('<p>a</p>'), runner.run('<p>b</p>'), runner.run('<p>c</p>')]);

  assert.equal(l.launches(), 1, 'the in-flight launch is shared, not raced');
});

test('dispose() closes the browser', async () => {
  const l = fakeLaunch();
  const runner = createPlaywrightRunner({ launch: l.launch });
  await assert.rejects(() => runner.run('<p>x</p>'));

  await runner.dispose();

  assert.equal(l.browsers[0]!.closes(), 1, 'the browser is closed exactly once');
});

test('dispose() is safe on a runner that never ran', async () => {
  const l = fakeLaunch();
  const runner = createPlaywrightRunner({ launch: l.launch });

  await runner.dispose();

  assert.equal(l.launches(), 0, 'nothing was launched, so nothing is closed');
});

test('dispose() is idempotent', async () => {
  const l = fakeLaunch();
  const runner = createPlaywrightRunner({ launch: l.launch });
  await assert.rejects(() => runner.run('<p>x</p>'));

  await runner.dispose();
  await runner.dispose();

  assert.equal(l.browsers[0]!.closes(), 1, 'a second dispose must not re-close');
});

test('disposal is FINAL — a later run() refuses rather than launching a second browser', async () => {
  const l = fakeLaunch();
  const runner = createPlaywrightRunner({ launch: l.launch });
  await assert.rejects(() => runner.run('<p>x</p>'));
  await runner.dispose();

  await assert.rejects(() => runner.run('<p>y</p>'), /disposed/i);

  assert.equal(l.launches(), 1, 'a disposed runner never launches again — nobody is left to close it');
});

test('each run() closes its own context, so contexts do not pile up behind the reused browser', async () => {
  // The browser now OUTLIVES the scan, so `browser.close()` no longer sweeps
  // per-scan contexts. Five audits in a turn must not leave five contexts (and
  // their pages) alive until dispose().
  const l = fakeLaunch();
  const runner = createPlaywrightRunner({ launch: l.launch });

  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => runner.run('<p>x</p>'));
  }

  assert.equal(l.browsers[0]!.contexts(), 5, 'a fresh context per scan');
  assert.equal(l.browsers[0]!.contextCloses(), 5, 'every one of them closed');
});

// A runner is used sequentially inside one turn's try/finally, so neither race
// below is reachable in practice — but "unreachable" is an invariant of the
// CALLER, and the failure mode if it ever breaks is a leaked Chromium. There
// are two windows, because `run()` awaits the axe-core import before it ever
// asks for a browser.

test('dispose() BEFORE run() reaches the browser: nothing is ever launched', async () => {
  const l = fakeLaunch();
  const runner = createPlaywrightRunner({ launch: l.launch });

  const scan = runner.run('<p>x</p>'); // still inside the axe-core import
  await runner.dispose();

  await assert.rejects(() => scan, /disposed/i);
  assert.equal(l.launches(), 0, 'a browser started here would have no one to close it');
});

test('dispose() racing an IN-FLIGHT launch still closes the late-arriving browser', async () => {
  let release!: (b: Browser) => void;
  let launchStarted = false;
  const b = fakeBrowser();
  const runner = createPlaywrightRunner({
    launch: () => {
      launchStarted = true;
      return new Promise<Browser>((resolve) => {
        release = resolve;
      });
    },
  });

  const scan = runner.run('<p>x</p>');
  while (!launchStarted) await new Promise((r) => setImmediate(r)); // let run() reach the launch

  const disposing = runner.dispose(); // now the launch is genuinely in flight
  release(b.browser);
  await Promise.allSettled([scan, disposing]);

  assert.equal(b.closes(), 1, 'the browser that arrived after dispose() is still closed');
});

test('a failed scan does not discard the browser', async () => {
  // `run()` rejects here on every call (newContext throws). A runner that tore
  // the browser down on scan failure would relaunch each time — the leak-shaped
  // mistake in the other direction.
  const l = fakeLaunch();
  const runner = createPlaywrightRunner({ launch: l.launch });

  await assert.rejects(() => runner.run('<p>x</p>'));
  await assert.rejects(() => runner.run('<p>x</p>'));

  assert.equal(l.launches(), 1);
  assert.equal(l.browsers[0]!.closes(), 0, 'a scan failure is not a browser failure');
});
