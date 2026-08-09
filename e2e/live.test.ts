/**
 * Live integration paths (gated; skipped by default so `npm test` stays offline).
 *
 * These drive the REAL on-device sidecars through the assembled `AppApi`:
 *   RUN_OLLAMA_INTEGRATION=1   → a real model turn + LLM health
 *   RUN_DOCLING_INTEGRATION=1  → real Docling reachability
 *
 * Models are selected via the llm config override (env). The runtime defaults the
 * two required tags (ADR-0009) — `MODEL_TEXT` to `granite4.1:8b` and
 * `MODEL_VISION` to `hf.co/ibm-granite/granite-vision-4.1-4b-GGUF:Q4_K_M` — so
 * both must be pulled locally. Override either independently to pick another
 * local tag. See `src/runtime/README.md`.
 *
 * Run with: RUN_OLLAMA_INTEGRATION=1 npx tsx --test "e2e"
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaSidecar, loadLLMConfig, requiredModels } from '../src/llm/index.js';
import { createDoclingSidecar, loadIngestConfig } from '../src/ingest/index.js';
import { createAppApi, runtimeLlmEnv, RUNTIME_DEFAULT_MODEL } from '../src/runtime/index.js';
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

test('LLM live: the shipped vision default can actually SEE (#33)', { skip: ollamaSkip }, async () => {
  // The check that pulling cannot give you. #29 switched the text default to a
  // tag that pulls perfectly and reports `completion, tools` — no `vision` — and
  // because the vision role inherited it, alt-text suggestion 400d in the field
  // while every offline test stayed green. A tag string cannot express "is
  // multimodal", so the only place to assert it is against a real Ollama.
  //
  // Asserted per ROLE, not on a hardcoded tag, so it keeps its meaning when
  // `scripts/model-eval/` swaps the provisional vision model — and so it fails
  // just as loudly for an operator whose MODEL_VISION override cannot see.
  const config = loadLLMConfig(runtimeLlmEnv());
  const { nativeUrl } = config;

  const capabilities = async (model: string): Promise<string[]> => {
    const res = await fetch(nativeUrl + '/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(20000),
    });
    assert.ok(res.ok, `/api/show failed for ${model} (${res.status}) — is it pulled?`);
    const body = (await res.json()) as { capabilities?: string[] };
    return body.capabilities ?? [];
  };

  for (const { role, tag } of requiredModels(config)) {
    const caps = await capabilities(tag);
    assert.ok(caps.includes('completion'), `${role} model ${tag} reports no completion: ${caps.join(', ')}`);
    if (role === 'vision') {
      assert.ok(
        caps.includes('vision'),
        `the vision model ${tag} does not report the vision capability (${caps.join(', ')}) — ` +
          'alt-text suggestion would fail with `/api/chat returned 400`',
      );
    }
  }
});

test('LLM live: the SHIPPED defaults read ready under the capability probe (#38)', { skip: ollamaSkip }, async () => {
  // The other half of the red-proof. A probe that fails everything would pass the
  // incapable test below and be worthless — this is what says the new check
  // still lets a correct installation through.
  const status = await llm.modelStatus();
  assert.deepEqual(
    status.models.map((m) => m.status),
    ['ready', 'ready'],
    `both shipped defaults must satisfy their roles: ${JSON.stringify(status.models)}`,
  );
  assert.equal(status.ready, true);
});

test('LLM live: an installed but text-only vision override is NOT ready (#38)', { skip: ollamaSkip }, async () => {
  // THE RED-PROOF for ADR-0010, and the reason it lives here rather than beside
  // the fakes: a fake reports whatever it was told, so it can demonstrate the
  // logic and not the contract. This asserts against the capability answer a real
  // Ollama gives for a real installed tag.
  //
  // The configuration is the #29 regression exactly: MODEL_VISION pointed at the
  // shipped TEXT default, which is installed, pulls fine, and cannot see. Before
  // the capability probe this read `available: true` on every surface.
  const env = runtimeLlmEnv({ ...process.env, MODEL_VISION: RUNTIME_DEFAULT_MODEL });
  const sidecar = createOllamaSidecar({ env });
  const status = await sidecar.modelStatus();
  const vision = status.models.find((m) => m.role === 'vision');

  assert.equal(
    vision?.status,
    'incapable',
    `${RUNTIME_DEFAULT_MODEL} is installed and cannot see — it must not read as ready`,
  );
  assert.equal(status.ready, false, 'an incapable required model must not let the set read as ready');

  // And the app-level payload must carry it through to advice, not to a pull.
  const app = createAppApi({ chatRunner: llm, llm: sidecar, ingest, audit: cleanAudit, llmEnv: env });
  const health = await app.health();
  assert.equal(health.visionModel?.status, 'incapable');
  assert.ok(
    !(health.visionModel?.recovery ?? '').includes('ollama pull'),
    'the tag is already installed; re-pulling it fixes nothing',
  );
});
