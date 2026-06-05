// Probe: does the REAL createAppApi() construct under Electron's Node?
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe-runtime.mjs
import { createAppApi } from '../dist/runtime/index.js';
try {
  const api = createAppApi();
  console.log('CONSTRUCT OK — methods:', Object.keys(api).length);
} catch (e) {
  console.error('CONSTRUCT THREW:\n', (e && e.stack) || e);
}
