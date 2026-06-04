import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveNativeUrl, loadLLMConfig, uniqueModels } from './config.js';

test('defaults match PRD Appendix H (local-only, single model)', () => {
  const c = loadLLMConfig({});
  assert.equal(c.baseUrl, 'http://localhost:11434/v1');
  assert.equal(c.nativeUrl, 'http://localhost:11434');
  assert.equal(c.ollamaHost, '127.0.0.1:11434');
  assert.equal(c.numCtx, 32768);
  assert.equal(c.maxOutputTokens, 8000);
  assert.equal(c.temperature, 0.3);
  assert.equal(c.numParallel, 1);
  assert.equal(c.visionEnabled, true);
  assert.equal(c.manageProcess, true);
  // Every role resolves to the one Gemma 4 12B build.
  for (const tag of Object.values(c.models)) assert.equal(tag, 'gemma4:12b-mlx');
});

test('per-role overrides fall back to MODEL_TEXT, then the global default', () => {
  const c = loadLLMConfig({ MODEL_TEXT: 'gemma4:12b-mlx', MODEL_CHEAP: 'gemma4:e4b-mlx' });
  assert.equal(c.models.text, 'gemma4:12b-mlx');
  assert.equal(c.models.deep, 'gemma4:12b-mlx'); // inherits text
  assert.equal(c.models.cheap, 'gemma4:e4b-mlx'); // explicit override
});

test('deriveNativeUrl strips a trailing /v1', () => {
  assert.equal(deriveNativeUrl('http://localhost:11434/v1'), 'http://localhost:11434');
  assert.equal(deriveNativeUrl('http://localhost:11434/v1/'), 'http://localhost:11434');
  assert.equal(deriveNativeUrl('http://host:1/'), 'http://host:1');
});

test('uniqueModels dedups across roles (for warm-loading)', () => {
  const c = loadLLMConfig({ MODEL_CHEAP: 'gemma4:e4b-mlx' });
  assert.deepEqual(uniqueModels(c).sort(), ['gemma4:12b-mlx', 'gemma4:e4b-mlx']);
});

test('invalid numeric env throws', () => {
  assert.throws(() => loadLLMConfig({ LLM_NUM_CTX: 'huge' }), /Invalid number for LLM_NUM_CTX/);
});

test('LLM_VISION_ENABLED=false is respected', () => {
  assert.equal(loadLLMConfig({ LLM_VISION_ENABLED: 'false' }).visionEnabled, false);
});
