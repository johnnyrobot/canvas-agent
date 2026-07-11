/**
 * Live integration paths (gated; skipped by default so `npm test` stays offline).
 *
 * These drive the REAL on-device sidecars through the assembled `AppApi`:
 *   RUN_OLLAMA_INTEGRATION=1   → a real Gemma turn + LLM health
 *   RUN_DOCLING_INTEGRATION=1  → real Docling reachability
 *
 * The model is selected via the llm config override (env): the runtime defaults
 * `MODEL_TEXT` to `gemma4:e2b` (`ollama pull gemma4:e2b`). Override with
 * `MODEL_TEXT=…` to pick another local tag. See `src/runtime/README.md`.
 *
 * Run with: RUN_OLLAMA_INTEGRATION=1 npx tsx --test "e2e"
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaSidecar, loadLLMConfig } from '../src/llm/index.js';
import { createDoclingSidecar, loadIngestConfig } from '../src/ingest/index.js';
import { createAppApi, runtimeLlmEnv } from '../src/runtime/index.js';
import type { Auditor } from '../src/contracts/index.js';

/** Keep the gate browser-free in live tests — these exercise the sidecars, not Chromium. */
const cleanAudit: Auditor = async () => ({ issues: [] });

const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes'].includes((v ?? '').toLowerCase());
const ollamaOptedIn = truthy(process.env.RUN_OLLAMA_INTEGRATION);
const doclingOptedIn = truthy(process.env.RUN_DOCLING_INTEGRATION);

async function ollamaReachable(): Promise<boolean> {
  const { nativeUrl } = loadLLMConfig(runtimeLlmEnv());
  try {
    return (await fetch(nativeUrl + '/api/version', { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function doclingReachable(): Promise<boolean> {
  const cfg = loadIngestConfig();
  try {
    // docling-serve health is undocumented; any HTTP response means it is up.
    await fetch(cfg.baseUrl + cfg.healthPath, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

const ollamaSkip: true | string | false = !ollamaOptedIn
  ? 'set RUN_OLLAMA_INTEGRATION=1 to run'
  : (await ollamaReachable())
    ? false
    : 'Ollama not reachable on the configured host';

const doclingSkip: true | string | false = !doclingOptedIn
  ? 'set RUN_DOCLING_INTEGRATION=1 to run'
  : (await doclingReachable())
    ? false
    : 'docling-serve not reachable on the configured host';

const llm = createOllamaSidecar({ env: runtimeLlmEnv() });
const ingest = createDoclingSidecar();

before(async () => {
  if (!ollamaSkip) await llm.start();
  if (!doclingSkip) await ingest.start();
});

after(async () => {
  if (!ollamaSkip) await llm.stop();
  if (!doclingSkip) await ingest.stop();
});

test('LLM live: a real on-device turn returns non-empty text', { skip: ollamaSkip }, async () => {
  const app = createAppApi({ chatRunner: llm, llm, ingest, audit: cleanAudit });
  const view = await app.runTurn({
    user: 'Reply with the single word: ready.',
    system: 'You are a terse assistant. Do not call any tools.',
  });
  assert.ok(view.text.trim().length > 0, 'expected non-empty model text');
  assert.ok(view.iterations >= 1);
});

test('LLM live: health() reports the model sidecar reachable', { skip: ollamaSkip }, async () => {
  const app = createAppApi({ chatRunner: llm, llm, ingest, audit: cleanAudit });
  assert.equal((await app.health()).llm, true);
});

test('Docling live: health() reports the ingest sidecar reachable', { skip: doclingSkip }, async () => {
  const app = createAppApi({ chatRunner: llm, llm, ingest, audit: cleanAudit });
  assert.equal((await app.health()).ingest, true);
});
