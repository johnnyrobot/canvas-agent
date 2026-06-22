// Computer-use driver for the Canvas Agent Electron app.
// Launches the real app window (visible) via Playwright's Electron API, types a
// prompt, lets the LOCAL model drive a turn, and screenshots the gated result.
// Model is chosen via MODEL_TEXT / MODEL_VISION env (set by the caller).
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = process.env.REPO_PATH ?? process.cwd();
const PROMPT = process.env.DRIVE_PROMPT
  ?? 'Create an accessible Canvas page-content fragment titled "Photosynthesis" with a short intro section and a section on the light reactions.';
const OUT = process.env.DRIVE_OUT ?? '/tmp/canvas-agent-app';
const TITLE = process.env.DRIVE_TITLE ?? 'Photosynthesis';

async function main() {
  const app = await electron.launch({
    args: ['.'],
    cwd: REPO,
    env: { ...process.env },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="home-build"]', { timeout: 30_000 });
  await sleep(1500); // let the health probe settle
  const health = (await win.textContent('[data-testid="health"]').catch(() => '')) ?? '';
  console.log('HEALTH:', health.trim());
  await win.screenshot({ path: `${OUT}-1-launched.png` });

  await win.click('[data-testid="home-build"]');
  await win.click('[data-testid="build-template-continue"]');
  await win.fill('[data-testid="build-title"]', TITLE);
  await win.fill('[data-testid="build-tasks"]', PROMPT);
  await win.click('[data-testid="build-details-continue"]');
  await win.waitForSelector('[data-testid="build-generate"]', { timeout: 30_000 });
  await win.click('[data-testid="build-generate"]');
  console.log('SUBMITTED:', PROMPT);

  // Wait for an assistant turn + a gated fragment (or an error). Model inference
  // is slow on first load, so allow several minutes.
  const deadline = Date.now() + 300_000;
  let done = false;
  while (Date.now() < deadline) {
    const frag = await win.$('[data-testid="result-card"]');
    const err = await win.$('[data-testid="error-banner"]');
    if (frag || err) { done = true; break; }
    await sleep(2000);
  }
  await sleep(1000);
  await win.screenshot({ path: `${OUT}-2-result.png`, fullPage: true });

  const pageText = (await win.textContent('#app').catch(() => '')) ?? '';
  const badgeText = ((await win.textContent('[data-testid="result-badge"]').catch(() => '')) ?? '').trim();
  const fragHtml = await win.$$eval('[data-testid="result-card"]', (els) => els.map((e) => e.outerHTML.slice(0, 400)));
  console.log('RESULT_FOUND:', done);
  console.log('BADGE:', badgeText);
  console.log('FRAGMENT_COUNT:', fragHtml.length);
  console.log('APP_TEXT:', pageText.replace(/\s+/g, ' ').slice(0, 600));
  for (const h of fragHtml) console.log('FRAGMENT_HTML:', h.replace(/\s+/g, ' '));

  await sleep(2000);
  await app.close();
  console.log('SCREENSHOTS:', `${OUT}-1-launched.png`, `${OUT}-2-result.png`);
}

main().catch((e) => { console.error('DRIVE_ERROR:', e?.stack || e); process.exit(1); });
