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
  await win.waitForSelector('[data-testid="inst-task-build"]', { timeout: 30_000 });
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
  await win.getByTestId('inst-task-build').click();
  await win.getByTestId('build-template-continue').click();
  await win.getByTestId('build-title').fill('Module 1 - Getting Started');
  await win.getByTestId('build-rhythm').fill('Week 1');
  await win.getByTestId('build-tasks').fill('Read chapter 1; post to introductions.');
  await win.getByTestId('build-details-continue').click();
  await win.getByTestId('build-generate').click();
  await win.getByTestId('result-card').waitFor({ timeout: 10_000 });
}

async function remediatePaste(win: Page, source = BAD_HTML): Promise<void> {
  await win.getByTestId('inst-link-fix').click();
  await win.getByTestId('remediate-source-paste').click();
  await win.getByTestId('remediate-source-html').fill(source);
  await win.getByTestId('remediate-check-fix').click();
  await win.getByTestId('remediation-panel').waitFor({ timeout: 10_000 });
}

test('M09 inst-home hub reaches Build, Fix, and Ask screens', { skip, timeout: 60_000 }, async () => {
  await withApp('default', async (win) => {
    await win.getByTestId('inst-task-build').click();
    assert.match((await win.locator('#app').textContent()) ?? '', /Which page are you building/);
    await win.getByLabel('Back').click();
    await win.getByTestId('inst-link-fix').click();
    assert.match((await win.locator('#app').textContent()) ?? '', /What should we check/);
    await win.getByLabel('Back').click();
    // Task 02 must land on the source-input flow, never the bare review panel.
    await win.getByTestId('inst-task-remediation').click();
    assert.match((await win.locator('#app').textContent()) ?? '', /What should we check/);
    await win.getByLabel('Back').click();
    await win.getByTestId('inst-task-ask').click();
    await win.getByTestId('inst-ask-input').waitFor({ timeout: 10_000 });
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

test('M13 remediate fixed review shows inert before/after, fixed count, and download', { skip, timeout: 60_000 }, async () => {
  await withApp('remediate-fixed', async (win) => {
    await remediatePaste(win);
    // Clean run → the review panel reports it as clear and names the auto-fixed count.
    assert.match((await win.getByTestId('remed-tag').textContent()) ?? '', /Audit clear/);
    assert.match((await win.getByTestId('remed-desc').textContent()) ?? '', /2 issues were auto-fixed/);
    assert.match((await win.getByTestId('remed-html-before').textContent()) ?? '', /<img src="goggles\.png">/);
    assert.match((await win.getByTestId('remed-html-after').textContent()) ?? '', /alt="Safety goggles/);
    // Corrected page is downloadable + copyable when the run left no failures.
    assert.equal(await win.getByTestId('remed-download-html').count(), 1);
    assert.equal(await win.getByTestId('remed-copy-fix').count(), 1);
    // "Copy for Canvas" mirrors the download button's visibility rule; pasted
    // HTML has no Canvas page to link back to, so "Open page in Canvas" is absent.
    assert.equal(await win.getByTestId('remed-copy-canvas').count(), 1);
    assert.equal(await win.getByTestId('remed-open-canvas').count(), 0);
  });
});

test('M14 remediate residual review surfaces the blocker, fixed count, and withholds download', { skip, timeout: 60_000 }, async () => {
  await withApp('remediate-residual', async (win) => {
    await remediatePaste(win);
    const appText = (await win.locator('#app').textContent()) ?? '';
    // Remaining blocker → failing tag and the blocker surfaced as the selected issue.
    assert.match((await win.getByTestId('remed-tag').textContent()) ?? '', /Fails checks/);
    assert.match((await win.getByTestId('remed-title').textContent()) ?? '', /Image still needs human alt text/);
    // Fixed count is derived, never a hardcoded string.
    assert.match((await win.getByTestId('remed-desc').textContent()) ?? '', /1 issue was auto-fixed/);
    assert.equal(appText.includes('2 fixes passed'), false);
    // No corrected-HTML download offered while a blocker remains.
    assert.equal(await win.getByTestId('remed-download-html').count(), 0);
    // Same withheld rule applies to the Canvas hand-off actions.
    assert.equal(await win.getByTestId('remed-copy-canvas').count(), 0);
    assert.equal(await win.getByTestId('remed-open-canvas').count(), 0);
  });
});

test('M15 Canvas import remediation reads a page and lands on the review panel', { skip, timeout: 60_000 }, async () => {
  await withApp('canvas-import', async (win) => {
    await win.getByTestId('inst-link-fix').click();
    await win.getByTestId('remediate-source-canvas').click();
    await win.getByTestId('canvas-base-url').fill('https://canvas.example.test');
    await win.getByTestId('canvas-course-id').fill('123');
    await win.getByTestId('canvas-token').fill('token');
    await win.getByTestId('canvas-connect').click();
    await win.getByTestId('canvas-page-lab-safety').waitFor({ timeout: 10_000 });
    await win.getByTestId('canvas-import-fix').click();
    await win.getByTestId('remediation-panel').waitFor({ timeout: 10_000 });
    assert.match((await win.getByTestId('remed-html-before').textContent()) ?? '', /lab-safety/);
    assert.match((await win.getByTestId('remed-tag').textContent()) ?? '', /Audit clear/);
    // A Canvas-import source (passed) gets both hand-off actions: copy AND a
    // link back to the live page's editor. Not clicked here — clicking would
    // fire a real `shell.openExternal` in the OS browser; presence is enough
    // to prove the wiring (see navigation.test.ts for the URL-policy unit tests).
    assert.equal(await win.getByTestId('remed-copy-canvas').count(), 1);
    assert.equal(await win.getByTestId('remed-open-canvas').count(), 1);
  });
});

test('M16 inst-ask renders guidance prose without stale fragments', { skip, timeout: 60_000 }, async () => {
  await withApp('guidance', async (win) => {
    await win.getByTestId('inst-task-ask').click();
    await win.getByTestId('inst-ask-input').fill('How should Canvas tables work?');
    await win.getByTestId('inst-ask-submit').click();
    await waitForText(win.locator('#app'), /Use real table headers/);
    assert.equal(await win.getByTestId('result-card').count(), 0);
  });
});

test('M17 brand kit flow shows selected kit and accessible roles before build', { skip, timeout: 60_000 }, async () => {
  await withApp('build-pass', async (win) => {
    await win.getByTestId('inst-task-build').click();
    await win.getByTestId('build-template-continue').click();
    await win.getByTestId('build-details-continue').click();
    await win.getByTestId('brand-change').click();
    await win.getByTestId('brand-row-kit-e2e-slate').click();
    assert.match((await win.locator('#app').textContent()) ?? '', /Slate/);
    assert.match((await win.getByTestId('contrast-panel').textContent()) ?? '', /Heading/);
  });
});

test('M18 saved work restores a persisted remediation into the review panel', { skip, timeout: 60_000 }, async () => {
  await withApp('default', async (win) => {
    await win.getByTestId('inst-link-saved').click();
    await win.getByTestId('session-row-remediate').click();
    await win.getByTestId('remediation-panel').waitFor({ timeout: 10_000 });
    // Restored run is bound to the panel: clean tally + the persisted after-HTML.
    assert.match((await win.getByTestId('remed-tag').textContent()) ?? '', /Audit clear/);
    assert.match((await win.getByTestId('remed-html-after').textContent()) ?? '', /Safety goggles/);
  });
});

test('M19 runtime-down scenario degrades health and never fabricates a badge', { skip, timeout: 60_000 }, async () => {
  await withApp('runtime-down', async (win) => {
    // Plural admitted: the scripted API reports BOTH required models (ADR-0009),
    // so a down runtime names two missing models, not one.
    await waitForText(win.getByTestId('health'), /Models? (missing|not installed)|Local runtime/);
    await win.getByTestId('inst-task-ask').click();
    await win.getByTestId('inst-ask-input').fill('Can I get a fake result?');
    await win.getByTestId('inst-ask-submit').click();
    await waitForText(win.getByTestId('error-banner'), /runtime is down/);
    assert.equal(await win.getByTestId('result-card').count(), 0);
  });
});

test('M21 inst-ask screenshot attach captures a source, shows a removable thumbnail, and forwards it as an attachment', { skip, timeout: 60_000 }, async () => {
  await withApp('guidance', async (win) => {
    await win.getByTestId('inst-task-ask').click();
    // Attach first: every render() rebuilds the DOM tree from scratch (no
    // diffing), so a question typed before an attach/capture round-trip would
    // be wiped when the input node is recreated — attach, then type, then ask.
    await win.getByTestId('inst-ask-attach').click();
    await win.getByTestId('inst-ask-source-screen:e2e:0').waitFor({ timeout: 10_000 });
    await win.getByTestId('inst-ask-source-screen:e2e:0').click();
    await win.getByTestId('inst-ask-shot-remove').waitFor({ timeout: 10_000 });
    assert.equal(await win.getByTestId('inst-ask-shot-remove').count(), 1);
    // Source grid clears once a screenshot is captured.
    assert.equal(await win.getByTestId('inst-ask-source-screen:e2e:0').count(), 0);
    await win.getByTestId('inst-ask-input').fill('How should Canvas tables work?');
    await win.getByTestId('inst-ask-submit').click();
    await waitForText(win.locator('#app'), /Use real table headers/);
    // A successful turn clears the attachment rail.
    assert.equal(await win.getByTestId('inst-ask-shot-remove').count(), 0);
  });
});

test('M22 inst-ask screenshot remove drops the thumbnail before asking', { skip, timeout: 60_000 }, async () => {
  await withApp('guidance', async (win) => {
    await win.getByTestId('inst-task-ask').click();
    await win.getByTestId('inst-ask-attach').click();
    await win.getByTestId('inst-ask-source-screen:e2e:0').click();
    await win.getByTestId('inst-ask-shot-remove').waitFor({ timeout: 10_000 });
    await win.getByTestId('inst-ask-shot-remove').click();
    assert.equal(await win.getByTestId('inst-ask-shot-remove').count(), 0);
  });
});

test('M23 inst-ask surfaces a readable error when screenshot capture is unavailable', { skip, timeout: 60_000 }, async () => {
  await withApp('runtime-down', async (win) => {
    await win.getByTestId('inst-task-ask').click();
    await win.getByTestId('inst-ask-attach').click();
    await waitForText(win.getByTestId('error-banner'), /runtime is down/);
    assert.equal(await win.getByTestId('inst-ask-source-screen:e2e:0').count(), 0);
  });
});

test('M24 dark-mode toggle themes the global app chrome, not just the screen body', { skip, timeout: 60_000 }, async () => {
  await withApp('default', async (win) => {
    // The uiTheme preference persists across launches (localStorage), so don't
    // assume a light start — assert the toggle flips it, and back.
    const app = win.locator('#app');
    const initialClass = (await app.getAttribute('class')) ?? '';
    const initialDark = initialClass.split(/\s+/).includes('app--dark');
    await win.getByTestId('theme-toggle').click();
    const toggledClass = (await app.getAttribute('class')) ?? '';
    assert.equal(toggledClass.split(/\s+/).includes('app--dark'), !initialDark);
    // The chrome-wide marker is on `#app` itself; the existing screen-scoped
    // modifier is on its child screen root (inst-home renders `.inst`) — both
    // toggle together.
    const instClass = (await win.locator('.inst').first().getAttribute('class')) ?? '';
    assert.equal(instClass.split(/\s+/).includes('inst--dark'), !initialDark);
    await win.getByTestId('theme-toggle').click();
    const revertedClass = (await app.getAttribute('class')) ?? '';
    assert.equal(revertedClass.split(/\s+/).includes('app--dark'), initialDark);
  });
});

test('M20 review-panel before/after HTML is inert escaped text, never live markup', { skip, timeout: 60_000 }, async () => {
  await withApp('remediate-fixed', async (win) => {
    await remediatePaste(win);
    const beforeInner = await win.getByTestId('remed-html-before').evaluate((el) => el.innerHTML);
    assert.match(beforeInner, /&lt;img/);
    assert.equal(beforeInner.includes('<img src="goggles.png">'), false);
    // The repaired page's corrected markup is shown as text too (no live DOM injection).
    const afterInner = await win.getByTestId('remed-html-after').evaluate((el) => el.innerHTML);
    assert.match(afterInner, /Safety goggles/);
    assert.equal(afterInner.includes('<img src="goggles.png" alt='), false);
  });
});

test('M25 first-run two-model pull shows ONE bar that never resets', { skip, timeout: 60_000 }, async () => {
  await withApp('models-missing', async (win) => {
    // Both required models absent, sidecars up: the first-run case (ADR-0009).
    const health = win.getByTestId('health');
    await waitForText(health, /not installed/);
    const affordance = win.getByTestId('download-model');
    assert.match((await affordance.getAttribute('aria-label')) ?? '', /e2e-scripted.*e2e-scripted-vision/);

    await affordance.click();

    // Sample the live bar. Every progress line re-renders the WHOLE subtree, so
    // each sample lands on elements the previous frame destroyed — the aggregate
    // is only ever redrawn from screen state. One `evaluate` per frame keeps the
    // bar count, its value and the status text from straddling a re-render.
    const samples: number[] = [];
    const named = new Set<string>();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const frame = await win
        .locator('#app')
        .evaluate((app) => {
          const status = app.querySelector('[data-testid="health"]');
          const bars = status ? status.querySelectorAll('[role="progressbar"]') : [];
          return {
            bars: bars.length,
            value: bars.length > 0 ? bars[0]!.getAttribute('aria-valuenow') : null,
            text: status?.textContent ?? '',
          };
        })
        .catch(() => null);
      if (frame === null) {
        await sleep(25); // the subtree was mid-replacement; sample the next frame
        continue;
      }
      if (frame.bars === 0) {
        if (samples.length > 0) break; // the download finished and the bar was cleared
        await sleep(25);
        continue;
      }
      assert.equal(frame.bars, 1, 'ONE bar for the whole set, not one per model');
      const now = Number(frame.value ?? '0');
      if (Number.isFinite(now)) samples.push(now);
      for (const tag of ['e2e-scripted', 'e2e-scripted-vision']) {
        if (frame.text.includes(tag)) named.add(tag);
      }
      await sleep(25);
    }

    assert.ok(samples.length >= 5, `expected to observe the download in flight, saw ${samples.length} frames`);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i]! >= samples[i - 1]!, `bar reset mid-download: ${samples.join(' → ')}`);
    }
    assert.ok(Math.max(...samples) > Math.min(...samples), `bar never advanced: ${samples.join(' → ')}`);
    assert.ok(named.has('e2e-scripted-vision'), 'the model currently transferring is named');
    // Both models installed afterwards: no second offer to download gigabytes.
    await waitForText(health, /Local runtime ready/);
    assert.equal(await win.getByTestId('download-model').count(), 0);
  });
});

test('M26 a health probe landing mid-pull does not contradict the running bar', { skip, timeout: 60_000 }, async () => {
  await withApp('models-missing', async (win) => {
    await waitForText(win.getByTestId('health'), /not installed/);
    // Start the model pull (streams for ~1s), then finish the INDEPENDENT
    // document-model download, whose completion calls straight back into the
    // health probe. That probe must not overwrite the bar's status line with
    // "Models not installed" while the bar is at 60%.
    await win.getByTestId('download-model').click();
    await win.getByTestId('download-ingest-model').click();

    const contradictions: string[] = [];
    let sawProbeLandMidPull = false;
    let frames = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const frame = await win
        .locator('#app')
        .evaluate((app) => {
          const status = app.querySelector('[data-testid="health"]');
          return {
            bars: status ? status.querySelectorAll('[role="progressbar"]').length : 0,
            ingestOffered: !!app.querySelector('[data-testid="download-ingest-model"]'),
            text: status?.textContent ?? '',
          };
        })
        .catch(() => null);
      if (frame === null) {
        await sleep(25);
        continue;
      }
      if (frame.bars === 0) {
        if (frames > 0) break;
        await sleep(25);
        continue;
      }
      frames++;
      if (frame.text.includes('not installed')) contradictions.push(frame.text);
      // The document-model download has completed (its affordance is gone) while
      // the model bar is still running — i.e. its probe really did land mid-pull.
      if (!frame.ingestOffered) sawProbeLandMidPull = true;
      await sleep(25);
    }

    assert.ok(frames >= 5, `expected to observe the pull in flight, saw ${frames} frames`);
    assert.ok(
      sawProbeLandMidPull,
      'the document-model download never completed during the model pull — this test proved nothing',
    );
    assert.deepEqual(contradictions, [], 'status said "not installed" beside a running progress bar');
  });
});
