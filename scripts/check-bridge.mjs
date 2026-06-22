// Fast launch check: confirm the preload bridge is exposed + health is reachable.
// No LLM turn — just verify window.canvasAgent and the runtime health probe.
import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = '/Users/laccd/code/canvas-agent';
const app = await electron.launch({ args: ['.'], cwd: REPO, env: { ...process.env } });
const mainLogs = [];
app.process().stderr.on('data', (d) => mainLogs.push('STDERR ' + d.toString()));
app.process().stdout.on('data', (d) => mainLogs.push('STDOUT ' + d.toString()));
const win = await app.firstWindow();
await win.waitForSelector('[data-testid="home-build"]', { timeout: 30_000 });
await sleep(3000); // let the health probe resolve

const hasBridge = await win.evaluate(
  () => typeof window.canvasAgent === 'object' && typeof window.canvasAgent.runTurn === 'function',
);
const methods = await win.evaluate(() =>
  window.canvasAgent ? Object.keys(window.canvasAgent).sort().join(',') : '(none)',
);
const health = ((await win.textContent('[data-testid="health"]').catch(() => '')) ?? '').trim();
console.log('HAS_BRIDGE:', hasBridge);
console.log('METHODS:', methods);
console.log('HEALTH:', health);
await win.screenshot({ path: '/tmp/canvas-agent-bridge-check.png' });
await app.close();
console.log('--- MAIN PROCESS LOGS ---');
for (const line of mainLogs) process.stdout.write(line);
console.log('OK');
