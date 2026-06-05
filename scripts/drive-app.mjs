// Computer-use driver for the Canvas Agent Electron app.
// Launches the real app window (visible) via Playwright's Electron API, types a
// prompt, lets the LOCAL model drive a turn, and screenshots the gated result.
// Model is chosen via MODEL_TEXT / MODEL_VISION env (set by the caller).
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = '/Users/laccd/code/canvas-agent';
const PROMPT = process.env.DRIVE_PROMPT
  ?? 'Create an accessible Canvas page-content fragment titled "Photosynthesis" with a short intro section and a section on the light reactions.';
const OUT = process.env.DRIVE_OUT ?? '/tmp/canvas-agent-app';

async function main() {
  const app = await electron.launch({
    args: ['.'],
    cwd: REPO,
    env: { ...process.env },
  });
  const win = await app.firstWindow();
  await win.waitForSelector('#prompt', { timeout: 30_000 });
  await sleep(1500); // let the health probe settle
  const health = (await win.textContent('#health').catch(() => '')) ?? '';
  console.log('HEALTH:', health.trim());
  await win.screenshot({ path: `${OUT}-1-launched.png` });

  await win.fill('#prompt', PROMPT);
  await win.click('#submit');
  console.log('SUBMITTED:', PROMPT);

  // Wait for an assistant turn + a gated fragment (or an error). Model inference
  // is slow on first load, so allow several minutes.
  const deadline = Date.now() + 300_000;
  let done = false;
  while (Date.now() < deadline) {
    const frag = await win.$('.fragment');
    const err = await win.$('.turn--error');
    if (frag || err) { done = true; break; }
    await sleep(2000);
  }
  await sleep(1000);
  await win.screenshot({ path: `${OUT}-2-result.png`, fullPage: true });

  const transcript = (await win.textContent('#transcript').catch(() => '')) ?? '';
  const badgePassed = await win.$('.badge--passed');
  const badgeWithheld = await win.$('.badge--withheld');
  const fragHtml = await win.$$eval('.fragment', (els) => els.map((e) => e.outerHTML.slice(0, 400)));
  console.log('RESULT_FOUND:', done);
  console.log('BADGE_PASSED:', !!badgePassed, '| BADGE_WITHHELD:', !!badgeWithheld);
  console.log('FRAGMENT_COUNT:', fragHtml.length);
  console.log('TRANSCRIPT_TEXT:', transcript.replace(/\s+/g, ' ').slice(0, 600));
  for (const h of fragHtml) console.log('FRAGMENT_HTML:', h.replace(/\s+/g, ' '));

  await sleep(2000);
  await app.close();
  console.log('SCREENSHOTS:', `${OUT}-1-launched.png`, `${OUT}-2-result.png`);
}

main().catch((e) => { console.error('DRIVE_ERROR:', e?.stack || e); process.exit(1); });
