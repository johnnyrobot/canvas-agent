/**
 * Deterministic guided-UI E2E matrix.
 *
 * Run after `npm run build` with:
 *   CANVAS_AGENT_E2E_API=scripted npx tsx --test e2e/ui-guided.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtMain = path.join(repo, 'dist', 'app', 'main.js');
const optedIn = process.env.CANVAS_AGENT_E2E_API === 'scripted';
const skip: string | false = !optedIn
  ? 'set CANVAS_AGENT_E2E_API=scripted to run deterministic Electron UI E2E'
  : !existsSync(builtMain)
    ? 'run npm run build before deterministic Electron UI E2E'
    : false;

const BAD_HTML =
  '<h2>Lab Safety</h2><img src="goggles.png"><p style="color:#aaaaaa;background:#cccccc">Always wear goggles.</p>';

async function launch(scenario: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: repo,
    env: {
      ...process.env,
      CANVAS_AGENT_E2E_API: 'scripted',
      CANVAS_AGENT_E2E_SCENARIO: scenario,
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="home-build"]', { timeout: 30_000 });
  return { app, win };
}

async function withApp(scenario: string, fn: (win: Page) => Promise<void>): Promise<void> {
  const { app, win } = await launch(scenario);
  try {
    await fn(win);
  } finally {
    await app.close();
  }
}

async function waitForText(locator: Locator, expected: string | RegExp): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = (await locator.textContent()) ?? '';
    if (typeof expected === 'string' ? text.includes(expected) : expected.test(text)) return text;
    await sleep(100);
  }
  const finalText = (await locator.textContent()) ?? '';
  assert.fail(`Timed out waiting for ${String(expected)} in: ${finalText}`);
}

async function completeBuild(win: Page): Promise<void> {
  await win.getByTestId('home-build').click();
  await win.getByTestId('build-template-continue').click();
  await win.getByTestId('build-title').fill('Module 1 - Getting Started');
  await win.getByTestId('build-rhythm').fill('Week 1');
  await win.getByTestId('build-tasks').fill('Read chapter 1; post to introductions.');
  await win.getByTestId('build-details-continue').click();
  await win.getByTestId('build-generate').click();
  await win.getByTestId('result-card').waitFor({ timeout: 10_000 });
}

async function remediatePaste(win: Page, source = BAD_HTML): Promise<void> {
  await win.getByTestId('home-remediate').click();
  await win.getByTestId('remediate-source-paste').click();
  await win.getByTestId('remediate-source-html').fill(source);
  await win.getByTestId('remediate-check-fix').click();
  await win.getByTestId('result-card').waitFor({ timeout: 10_000 });
}

test('M09 home navigation reaches Build, Remediate, and Guidance screens', { skip, timeout: 60_000 }, async () => {
  await withApp('default', async (win) => {
    await win.getByTestId('home-build').click();
    assert.match((await win.locator('#app').textContent()) ?? '', /Which page are you building/);
    await win.getByLabel('Back').click();
    await win.getByTestId('home-remediate').click();
    assert.match((await win.locator('#app').textContent()) ?? '', /What should we check/);
    await win.getByLabel('Back').click();
    await win.getByTestId('home-guidance').click();
    assert.match((await win.locator('#app').textContent()) ?? '', /What do you want to understand/);
  });
});

test('M10 build guided happy path renders passed preview and copy affordance', { skip, timeout: 60_000 }, async () => {
  await withApp('build-pass', async (win) => {
    await completeBuild(win);
    assert.match((await win.getByTestId('result-badge').textContent()) ?? '', /Accessibility checks passed/);
    assert.equal(await win.getByTestId('copy-ready-html').isDisabled(), false);
    assert.equal(await win.getByTestId('download-ready-html').isDisabled(), false);
    assert.equal(await win.getByTestId('result-preview-frame').getAttribute('sandbox'), '');
    assert.match((await win.getByTestId('result-preview-frame').getAttribute('srcdoc')) ?? '', /Module 1 - Getting Started/);
  });
});

test('M11 build withheld path shows blockers without false ready copy', { skip, timeout: 60_000 }, async () => {
  await withApp('build-withheld', async (win) => {
    await completeBuild(win);
    const appText = (await win.locator('#app').textContent()) ?? '';
    assert.match((await win.getByTestId('result-badge').textContent()) ?? '', /Accessibility checks withheld/);
    assert.match((await win.getByTestId('blocker-list').textContent()) ?? '', /Removed semantic/);
    assert.equal(await win.getByTestId('copy-ready-html').isDisabled(), true);
    assert.equal(await win.getByTestId('download-ready-html').isDisabled(), true);
    assert.equal(appText.includes('module overview passed'), false);
    assert.equal(((await win.getByTestId('result-preview-frame').getAttribute('srcdoc')) ?? '').includes('<figure'), false);
  });
});

test('M12 build warnings and human-review items remain visible with pass badge', { skip, timeout: 60_000 }, async () => {
  await withApp('build-warnings', async (win) => {
    await completeBuild(win);
    assert.match((await win.getByTestId('result-badge').textContent()) ?? '', /Accessibility checks passed/);
    assert.match((await win.getByTestId('warning-list').textContent()) ?? '', /Table has no caption/);
    assert.match((await win.getByTestId('review-list').textContent()) ?? '', /linked resource/);
  });
});

test('M13 remediate fixed path shows inert before, after, fixed diffs, and pass copy', { skip, timeout: 60_000 }, async () => {
  await withApp('remediate-fixed', async (win) => {
    await remediatePaste(win);
    assert.match((await win.getByTestId('result-badge').textContent()) ?? '', /Accessibility checks passed/);
    assert.match((await win.getByTestId('remediate-before-html').textContent()) ?? '', /<img src="goggles\.png">/);
    assert.match((await win.getByTestId('remediate-after-html').textContent()) ?? '', /alt="Safety goggles/);
    assert.match((await win.getByTestId('remediate-diff-list').textContent()) ?? '', /Image missing alt text/);
    assert.equal(await win.getByTestId('copy-repaired-html').isDisabled(), false);
    assert.equal(await win.getByTestId('download-repaired-html').isDisabled(), false);
  });
});

test('M14 remediate residual path withholds copy and never uses hardcoded fix counts', { skip, timeout: 60_000 }, async () => {
  await withApp('remediate-residual', async (win) => {
    await remediatePaste(win);
    const appText = (await win.locator('#app').textContent()) ?? '';
    assert.match((await win.getByTestId('result-badge').textContent()) ?? '', /Accessibility checks withheld/);
    assert.match((await win.getByTestId('blocker-list').textContent()) ?? '', /Image still needs human alt text/);
    assert.match((await win.getByTestId('remediate-diff-list').textContent()) ?? '', /Low contrast text/);
    assert.equal(await win.getByTestId('copy-repaired-html').isDisabled(), true);
    assert.equal(await win.getByTestId('download-repaired-html').isDisabled(), true);
    assert.equal(appText.includes('2 fixes passed'), false);
  });
});

test('M15 Canvas import remediation reads a page and runs the same repair result flow', { skip, timeout: 60_000 }, async () => {
  await withApp('canvas-import', async (win) => {
    await win.getByTestId('home-remediate').click();
    await win.getByTestId('remediate-source-canvas').click();
    await win.getByTestId('canvas-base-url').fill('https://canvas.example.test');
    await win.getByTestId('canvas-course-id').fill('123');
    await win.getByTestId('canvas-token').fill('token');
    await win.getByTestId('canvas-connect').click();
    await win.getByTestId('canvas-page-lab-safety').waitFor({ timeout: 10_000 });
    await win.getByTestId('canvas-import-fix').click();
    await win.getByTestId('result-card').waitFor({ timeout: 10_000 });
    assert.match((await win.getByTestId('remediate-before-html').textContent()) ?? '', /lab-safety/);
    assert.match((await win.getByTestId('result-badge').textContent()) ?? '', /Accessibility checks passed/);
  });
});

test('M16 guidance answer renders prose without stale fragments', { skip, timeout: 60_000 }, async () => {
  await withApp('guidance', async (win) => {
    await win.getByTestId('home-guidance').click();
    await win.getByTestId('guidance-question').fill('How should Canvas tables work?');
    await win.getByTestId('guidance-ask').click();
    await waitForText(win.locator('#app'), /Use real table headers/);
    assert.equal(await win.getByTestId('result-card').count(), 0);
  });
});

test('M17 brand kit flow shows selected kit and accessible roles before build', { skip, timeout: 60_000 }, async () => {
  await withApp('build-pass', async (win) => {
    await win.getByTestId('home-build').click();
    await win.getByTestId('build-template-continue').click();
    await win.getByTestId('build-details-continue').click();
    await win.getByTestId('brand-change').click();
    await win.getByTestId('brand-row-kit-e2e-slate').click();
    assert.match((await win.locator('#app').textContent()) ?? '', /Slate/);
    assert.match((await win.getByTestId('contrast-panel').textContent()) ?? '', /Heading/);
  });
});

test('M18 saved work restores persisted fragments, badges, and remediation diffs', { skip, timeout: 60_000 }, async () => {
  await withApp('default', async (win) => {
    await win.getByTestId('quick-saved-work').click();
    await win.getByTestId('session-row-remediate').click();
    await win.getByTestId('result-card').waitFor({ timeout: 10_000 });
    assert.match((await win.getByTestId('result-badge').textContent()) ?? '', /Accessibility checks passed/);
    assert.match((await win.getByTestId('remediate-diff-list').textContent()) ?? '', /Image missing alt text/);
  });
});

test('M19 runtime-down scenario degrades health and never fabricates a badge', { skip, timeout: 60_000 }, async () => {
  await withApp('runtime-down', async (win) => {
    await waitForText(win.getByTestId('health'), /Model missing|Local runtime/);
    await win.getByTestId('home-guidance').click();
    await win.getByTestId('guidance-question').fill('Can I get a fake result?');
    await win.getByTestId('guidance-ask').click();
    await waitForText(win.getByTestId('error-banner'), /runtime is down/);
    assert.equal(await win.getByTestId('result-card').count(), 0);
  });
});

test('M20 remediation source is inert text and preview is sandboxed srcdoc', { skip, timeout: 60_000 }, async () => {
  await withApp('remediate-fixed', async (win) => {
    await remediatePaste(win);
    const beforeInner = await win.getByTestId('remediate-before-html').evaluate((el) => el.innerHTML);
    assert.match(beforeInner, /&lt;img/);
    assert.equal(beforeInner.includes('<img src="goggles.png">'), false);
    assert.equal(await win.getByTestId('result-preview-frame').getAttribute('sandbox'), '');
    assert.match((await win.getByTestId('result-preview-frame').getAttribute('srcdoc')) ?? '', /Safety goggles/);
  });
});
