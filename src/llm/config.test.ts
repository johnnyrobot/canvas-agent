import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveNativeUrl, loadLLMConfig, uniqueModels } from './config.js';

// This module holds no shipping default (ADR-0007), so every config here names
// its own model. A placeholder tag, not a real one: these tests are about
// resolution rules, and pinning them to a shipped tag would make them re-break
// on every future model switch.
const TEXT = 'test-text:1b';

test('defaults match PRD Appendix H (local-only, single model)', () => {
  const c = loadLLMConfig({ MODEL_TEXT: TEXT });
  assert.equal(c.baseUrl, 'http://localhost:11434/v1');
  assert.equal(c.nativeUrl, 'http://localhost:11434');
  assert.equal(c.ollamaHost, '127.0.0.1:11434');
  assert.equal(c.numCtx, 32768);
  assert.equal(c.maxOutputTokens, 8000);
  assert.equal(c.temperature, 0.3);
  assert.equal(c.numParallel, 1);
  assert.equal(c.visionEnabled, true);
  assert.equal(c.manageProcess, true);
  // Every role resolves to the one configured text model.
  for (const tag of Object.values(c.models)) assert.equal(tag, TEXT);
});

test('per-role overrides fall back to MODEL_TEXT', () => {
  const c = loadLLMConfig({ MODEL_TEXT: TEXT, MODEL_CHEAP: 'test-cheap:0.5b' });
  assert.equal(c.models.text, TEXT);
  assert.equal(c.models.deep, TEXT); // inherits text
  assert.equal(c.models.cheap, 'test-cheap:0.5b'); // explicit override
});

test('deriveNativeUrl strips a trailing /v1', () => {
  assert.equal(deriveNativeUrl('http://localhost:11434/v1'), 'http://localhost:11434');
  assert.equal(deriveNativeUrl('http://localhost:11434/v1/'), 'http://localhost:11434');
  assert.equal(deriveNativeUrl('http://host:1/'), 'http://host:1');
});

test('uniqueModels dedups across roles (for warm-loading)', () => {
  const c = loadLLMConfig({ MODEL_TEXT: TEXT, MODEL_CHEAP: 'test-cheap:0.5b' });
  assert.deepEqual(uniqueModels(c).sort(), ['test-cheap:0.5b', TEXT].sort());
});

test('invalid numeric env throws', () => {
  assert.throws(() => loadLLMConfig({ MODEL_TEXT: TEXT, LLM_NUM_CTX: 'huge' }), /Invalid number for LLM_NUM_CTX/);
});

test('LLM_VISION_ENABLED=false is respected', () => {
  assert.equal(loadLLMConfig({ MODEL_TEXT: TEXT, LLM_VISION_ENABLED: 'false' }).visionEnabled, false);
});

test('MODEL_TEXT is required: the LLM module carries no shipping default (ADR-0007)', () => {
  // Shipping defaults live in ONE place — the runtime's `runtimeLlmEnv`, which
  // always injects MODEL_TEXT. A fallback here would be a second default that
  // drifts, and the one it used to hold was licence-encumbered.
  assert.throws(() => loadLLMConfig({}), /MODEL_TEXT/);
});
