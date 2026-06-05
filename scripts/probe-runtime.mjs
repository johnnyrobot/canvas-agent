// Probe: does the REAL createAppApi() construct under Electron's Node?
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe-runtime.mjs
import { createAppApi } from '../dist/runtime/index.js';
try {
  const api = createAppApi();
  console.log('CONSTRUCT OK — methods:', Object.keys(api).length);
  const sessions = await api.listSessions(); // exercises the lazy DB open + migrate
  console.log('listSessions OK — count:', sessions.length);
  const kits = await api.listBrandKits();
  console.log('listBrandKits OK — count:', kits.length);
} catch (e) {
  console.error('THREW:\n', (e && e.stack) || e);
}
