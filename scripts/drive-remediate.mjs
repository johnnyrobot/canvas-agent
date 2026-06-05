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
await win.waitForSelector('#prompt', { timeout: 30_000 });
await sleep(1500);
console.log('HEALTH:', ((await win.textContent('#health').catch(() => '')) ?? '').trim());

// Pick Remediate mode (mode buttons are rendered into #mode-bar).
await win.click('#mode-bar >> text=Remediate');
await sleep(500);
await win.waitForSelector('#remediate-source', { state: 'visible', timeout: 5000 });
await win.fill('#remediate-source', BAD_HTML);
await win.fill('#prompt', 'Repair the accessibility issues in this page.');
await win.screenshot({ path: `${OUT}-1-input.png` });
await win.click('#submit');
console.log('SUBMITTED remediate with bad HTML (missing alt + low contrast)');

const deadline = Date.now() + 300_000;
let done = false;
while (Date.now() < deadline) {
  if ((await win.$('.fragment')) || (await win.$('.turn--error'))) { done = true; break; }
  await sleep(2000);
}
await sleep(1000);
await win.screenshot({ path: `${OUT}-2-result.png`, fullPage: true });

const transcript = ((await win.textContent('#transcript').catch(() => '')) ?? '').replace(/\s+/g, ' ');
const hasBeforeAfter = await win.$$eval('.remediate__label, .remediate__before, .remediate__diffs', (els) => els.length);
const badgePassed = await win.$('.badge--passed');
const badgeWithheld = await win.$('.badge--withheld');
console.log('RESULT_FOUND:', done);
console.log('REMEDIATE_DIFF_ELEMENTS:', hasBeforeAfter);
console.log('BADGE_PASSED:', !!badgePassed, '| BADGE_WITHHELD:', !!badgeWithheld);
console.log('TRANSCRIPT_TEXT:', transcript.slice(0, 700));
await app.close();
console.log('SCREENSHOTS:', `${OUT}-1-input.png`, `${OUT}-2-result.png`);
