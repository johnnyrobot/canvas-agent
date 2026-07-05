/**
 * Renderer chrome accessibility scan (opt-in integration test).
 *
 * The `src/engine/render` auditor only ever scans GENERATED Canvas HTML
 * fragments — it never looks at the app's own UI chrome (appbar, screens,
 * panels). This suite closes that gap: it serves the built renderer over a
 * real HTTP origin, drives it through headless Chromium with a stubbed
 * `window.canvasAgent`, and runs axe-core directly against the live DOM for a
 * representative set of screens in both light and dark chrome.
 *
 * Skipped by default so `npm test` stays green offline with NO browser
 * download and NO build precondition. To run:
 *   npm run build
 *   RUN_BROWSER_INTEGRATION=1 npx tsx --test e2e/renderer-a11y.test.ts
 *
 * Reuses the same `RUN_BROWSER_INTEGRATION` flag as
 * `src/engine/render/integration.test.ts` (see that file) rather than
 * inventing a new one, and resolves Chromium the same way
 * `src/engine/render/playwright-runner.ts` does (bundled-browsers-path
 * override, `chromium-headless-shell` channel).
 *
 * The app's own `index.html` ships a strict CSP (`script-src 'self'`, no
 * `unsafe-inline`). `page.addScriptTag({ content })` inserts a real <script>
 * element and is subject to that CSP (it would be blocked); `page.evaluate`
 * and `context.addInitScript` run via the DevTools protocol and are NOT
 * subject to page CSP, so axe-core and the `window.canvasAgent` stub are both
 * injected that way instead of via `addScriptTag`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { AXE_TAGS, resolveBundledBrowsersPath } from '../src/engine/render/playwright-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const DIST_INDEX = path.join(DIST_DIR, 'app', 'renderer', 'index.html');

const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes'].includes((v ?? '').toLowerCase());
const optedIn = truthy(process.env.RUN_BROWSER_INTEGRATION);
const skip: true | string | false = optedIn ? false : 'set RUN_BROWSER_INTEGRATION=1 to run';

// ── Minimal static server for dist/ (no external deps) ──────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveDist(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const filePath = path.normalize(path.join(DIST_DIR, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  readFile(filePath)
    .then((data) => {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    })
    .catch(() => {
      res.writeHead(404);
      res.end('not found');
    });
}

// ── window.canvasAgent stub (adapted from .frugal-fable/dark-chrome/harness.mjs — ──
// ── copied inline; nothing under .frugal-fable is imported at runtime) ──────
const STUB_SCRIPT = `
(function () {
  function contrastOf(ratio) {
    return { ratio, level: ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : 'fail', passesAA: ratio >= 4.5, passesAAA: ratio >= 7, size: 'normal' };
  }
  const brandKits = [
    { id: 'kit-ocean', name: 'Ocean', palette: { primary: '#0b5394', secondary: '#38761d' }, createdAt: '2026-04-10T12:00:00.000Z' },
  ];
  function gate(html, blockers) {
    return { html, badgeWithheld: blockers.length > 0, conformance: { passedChecks: blockers.length === 0, blockers, warnings: [], needsHumanReview: [] } };
  }
  window.canvasAgent = {
    async runTurn(req) {
      if (req.mode === 'guidance') {
        if (req.user === 'ERROR_TRIGGER') throw new Error('Scripted a11y-harness error: guidance turn failed');
        return { text: 'Use real table headers, captions, and scoped cells.', fragments: [], toolsUsed: ['retrieve_kb'], iterations: 1, mode: 'guidance' };
      }
      if (req.mode === 'remediate') {
        const before = (req.remediateInput && req.remediateInput.sourceHtml) || '<h2>Lab Safety</h2><img src="goggles.png">';
        const after = '<h2>Lab Safety</h2><img src="goggles.png" alt="Safety goggles"><p>Always wear goggles.</p>';
        const afterGate = gate(after, []);
        return {
          text: 'Repaired the page and rechecked it.',
          fragments: [{
            html: afterGate.html,
            gate: afterGate,
            remediateResult: {
              before,
              after: afterGate.html,
              issueDiffs: [{ issue: { id: 'image-alt', severity: 'blocker', message: 'Image missing alt text', category: 'error' }, fixed: true }],
              gate: afterGate,
            },
          }],
          toolsUsed: ['audit_html'],
          iterations: 2,
          mode: 'remediate',
        };
      }
      const afterGate = gate('<h2>Module 1</h2>', []);
      return { text: 'Built a checked module overview.', fragments: [{ html: afterGate.html, gate: afterGate }], toolsUsed: ['render_template'], iterations: 1, mode: 'build' };
    },
    async saveCanvasAuth() {},
    async importCanvas(_baseUrl, courseId) {
      return { courseId, name: 'Stub course', importedAt: new Date().toISOString(), pages: 1, assignments: 0, files: 0, warnings: [] };
    },
    async health() {
      return { llm: true, ingest: true, model: { tag: 'stub-model', available: true, installCommand: 'noop' }, ingestModel: { available: true } };
    },
    async pullModel(onProgress) { onProgress && onProgress({ status: 'success' }); },
    async pullIngestModel(onProgress) { onProgress && onProgress({ status: 'success' }); },
    async createSession(init) {
      return { id: 'sess-stub', title: init.title, mode: init.mode, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    },
    async listSessions() { return []; },
    async loadSession() { return null; },
    async deleteSession() {},
    async resolveBrandTheme(primary, secondary) {
      return {
        colors: [
          { role: 'heading', background: '#ffffff', foreground: primary, contrast: contrastOf(8.2) },
          { role: 'accent', background: primary, foreground: '#ffffff', contrast: contrastOf(5.4) },
          { role: 'button-bg', background: secondary, foreground: '#ffffff', contrast: contrastOf(4.8) },
        ],
        warnings: [],
      };
    },
    async listBrandKits() { return brandKits.map((k) => ({ ...k })); },
    async saveBrandKit(kit) { return { ...kit, id: 'kit-new', createdAt: new Date().toISOString() }; },
    async deleteBrandKit() {},
    async fetchCanvasPage(_baseUrl, _courseId, pageId) { return '<h2>' + pageId + '</h2><img src="goggles.png">'; },
    async listCanvasPages() { return [{ id: 'lab-safety', title: 'Lab Safety' }]; },
    async convertDocument(document) {
      return { filename: document.filename, status: 'success', processingTimeMs: 1, html: '<p>stub</p>', text: 'stub' };
    },
    async screenshotPermissionStatus() { return 'granted'; },
    async listScreenshotSources() { return []; },
    async captureScreenshot(sourceId) {
      return { id: 'shot-stub', kind: 'screenshot', mime: 'image/png', dataUrl: 'data:image/png;base64,QUJD', label: sourceId, capturedAt: new Date().toISOString() };
    },
    async catalogAvailable() { return true; },
    async catalogSearch() { return []; },
    async catalogGet() { throw new Error('catalog unavailable in harness'); },
  };
})();
`;

// ── Scenarios: navigate from inst-home (the default screen) to each target ──

interface Scenario {
  name: string;
  navigate(page: Page): Promise<void>;
}

const SCENARIOS: Scenario[] = [
  { name: 'inst-home', navigate: async () => {} },
  {
    name: 'build-template',
    navigate: async (page) => {
      await page.locator('[data-testid="inst-task-build"]').click();
      await page.locator('[data-testid="build-template-continue"]').waitFor({ timeout: 10_000 });
    },
  },
  {
    name: 'build-details',
    navigate: async (page) => {
      await page.locator('[data-testid="inst-task-build"]').click();
      await page.locator('[data-testid="build-template-continue"]').click();
      // Catalog panel appears async (ensureCatalogAvailable → catalogAvailable stub → true).
      await page.locator('[data-testid="catalog-search-input"]').waitFor({ timeout: 10_000 });
    },
  },
  {
    name: 'inst-ask',
    navigate: async (page) => {
      await page.locator('[data-testid="inst-task-ask"]').click();
      await page.locator('[data-testid="inst-ask-input"]').fill('ERROR_TRIGGER');
      await page.locator('[data-testid="inst-ask-submit"]').click();
      await page.locator('[data-testid="error-banner"]').waitFor({ timeout: 10_000 });
    },
  },
  {
    name: 'remediate-review',
    navigate: async (page) => {
      await page.locator('[data-testid="inst-link-fix"]').click();
      await page.locator('[data-testid="remediate-source-paste"]').click();
      await page.locator('[data-testid="remediate-source-html"]').fill('<h2>Lab Safety</h2><img src="goggles.png">');
      await page.locator('[data-testid="remediate-check-fix"]').click();
      // The stub returns a clean afterGate (no blockers) — this is the passed-run state.
      await page.locator('[data-testid="remediation-panel"]').waitFor({ timeout: 10_000 });
    },
  },
  {
    name: 'brand-manager',
    navigate: async (page) => {
      await page.locator('[data-testid="inst-task-brand"]').click();
      await page.locator('[data-testid="inst-brand-manage"]').click();
      await page.locator('[data-testid="brand-row-kit-ocean"]').waitFor({ timeout: 10_000 });
    },
  },
];

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

// ── axe plumbing ─────────────────────────────────────────────────────────────

interface AxeViolationNode {
  html: string;
  target: string[];
  failureSummary?: string;
}
interface AxeViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: AxeViolationNode[];
}
interface AxeRunResult {
  violations: AxeViolation[];
}

async function scanPage(page: Page): Promise<AxeRunResult> {
  const axeSource = (await import('axe-core')).default.source;
  // Injected via evaluate (see header comment) — addScriptTag would be blocked by CSP.
  await page.evaluate(axeSource);
  const axeExpr =
    `axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(AXE_TAGS)} }, ` +
    `resultTypes: ['violations'] })`;
  return (await page.evaluate(axeExpr)) as AxeRunResult;
}

function formatViolations(violations: AxeViolation[]): string {
  if (violations.length === 0) return '(none)';
  return violations
    .map((v) => {
      const nodes = v.nodes
        .map((n) => `      target=${JSON.stringify(n.target)} html=${n.html.slice(0, 200)}`)
        .join('\n');
      return `  - [${v.impact ?? 'unknown'}] ${v.id}: ${v.help} (${v.helpUrl})\n${nodes}`;
    })
    .join('\n');
}

async function gotoApp(page: Page, baseUrl: string, theme: Theme): Promise<void> {
  await page.goto(`${baseUrl}/app/renderer/index.html`, { waitUntil: 'load' });
  if (theme === 'dark') {
    await page.locator('[data-testid="theme-toggle"]').click();
  }
}

// ── suite wiring ─────────────────────────────────────────────────────────────

let server: http.Server | undefined;
let baseUrl = '';
let browser: Browser | undefined;
const nonFailingSummary: string[] = [];

before(async () => {
  if (skip) return;
  assert.ok(
    existsSync(DIST_INDEX),
    `${DIST_INDEX} not found — run \`npm run build\` first (this suite scans the BUILT renderer, it does not build it)`,
  );

  server = http.createServer(serveDist);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const bundled = resolveBundledBrowsersPath();
    if (bundled) process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
  }
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true, channel: 'chromium-headless-shell' });
});

after(async () => {
  if (skip) return;
  if (nonFailingSummary.length > 0) {
    console.log('\n--- renderer a11y scan: moderate/minor summary (non-failing) ---');
    console.log(nonFailingSummary.join('\n'));
  } else {
    console.log('\n--- renderer a11y scan: no moderate/minor violations found ---');
  }
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

for (const scenario of SCENARIOS) {
  for (const theme of THEMES) {
    test(`renderer a11y: ${scenario.name} (${theme})`, { skip }, async () => {
      const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(STUB_SCRIPT);
      const page = await context.newPage();
      try {
        await gotoApp(page, baseUrl, theme);
        await scenario.navigate(page);
        const { violations } = await scanPage(page);

        const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        const minor = violations.filter((v) => v.impact === 'moderate' || v.impact === 'minor');

        if (minor.length > 0) {
          nonFailingSummary.push(`[${scenario.name}/${theme}] ${minor.length} moderate/minor:\n${formatViolations(minor)}`);
        }

        assert.equal(
          serious.length,
          0,
          `expected zero serious/critical a11y violations on ${scenario.name} (${theme}), got:\n${formatViolations(serious)}`,
        );
      } finally {
        await context.close();
      }
    });
  }
}
