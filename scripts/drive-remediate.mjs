// Computer-use driver for the REMEDIATE flow: pick Remediate mode, paste bad
// HTML, submit, and capture the before→after diff + gated result.
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = '/Users/laccd/code/canvas-agent';
const OUT = process.env.DRIVE_OUT ?? '/tmp/cda-remediate';
const BAD_HTML =
  '<h2>Lab Safety</h2>' +
  '<img src="goggles.png">' +
  '<p style="color:#aaaaaa;background:#cccccc">Always wear safety goggles in the lab.</p>';

const app = await electron.launch({ args: ['.'], cwd: REPO, env: { ...process.env } });
const win = await app.firstWindow();
await win.waitForSelector('[data-testid="home-remediate"]', { timeout: 30_000 });
await sleep(1500);
console.log('HEALTH:', ((await win.textContent('[data-testid="health"]').catch(() => '')) ?? '').trim());

// Pick the guided Remediate flow and paste source HTML.
await win.click('[data-testid="home-remediate"]');
await sleep(500);
await win.click('[data-testid="remediate-source-paste"]');
await win.waitForSelector('[data-testid="remediate-source-html"]', { state: 'visible', timeout: 5000 });
await win.fill('[data-testid="remediate-source-html"]', BAD_HTML);
await win.screenshot({ path: `${OUT}-1-input.png` });
await win.click('[data-testid="remediate-check-fix"]');
console.log('SUBMITTED remediate with bad HTML (missing alt + low contrast)');

const deadline = Date.now() + 300_000;
let done = false;
while (Date.now() < deadline) {
  if ((await win.$('[data-testid="result-card"]')) || (await win.$('[data-testid="error-banner"]'))) { done = true; break; }
  await sleep(2000);
}
await sleep(1000);
await win.screenshot({ path: `${OUT}-2-result.png`, fullPage: true });

const appText = ((await win.textContent('#app').catch(() => '')) ?? '').replace(/\s+/g, ' ');
const hasBeforeAfter = await win.$$eval('[data-testid="remediate-before-html"], [data-testid="remediate-after-html"], [data-testid="remediate-diff-list"]', (els) => els.length);
const badgeText = ((await win.textContent('[data-testid="result-badge"]').catch(() => '')) ?? '').trim();
console.log('RESULT_FOUND:', done);
console.log('REMEDIATE_DIFF_ELEMENTS:', hasBeforeAfter);
console.log('BADGE:', badgeText);
console.log('APP_TEXT:', appText.slice(0, 700));
await app.close();
console.log('SCREENSHOTS:', `${OUT}-1-input.png`, `${OUT}-2-result.png`);
