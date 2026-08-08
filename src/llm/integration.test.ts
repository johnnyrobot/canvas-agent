/**
 * Integration tests for the LLM sidecar against a REAL Ollama.
 *
 * Skipped by default so `npm test` stays green in CI / dev without Ollama.
 * To run:  RUN_OLLAMA_INTEGRATION=1 ollama serve & ; ollama pull granite4.1:8b
 *          RUN_OLLAMA_INTEGRATION=1 npm test
 *
 * Token budgets below are sized for a *reasoning* model (e.g. granite4.1:30b via
 * MODEL_TEXT): a thinking model spends hidden tokens before emitting visible
 * content, so tiny caps (16/32/64) yielded empty content. 512 is comfortably
 * above the thinking overhead while staying fast for non-thinking models too.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaSidecar, loadLLMConfig } from './index.js';

// This module carries no shipping default (ADR-0007) and must not grow a second
// one here, so the smoke requires MODEL_TEXT rather than falling back to a tag.
const env = process.env;

const optedIn = ['1', 'true', 'yes'].includes((process.env.RUN_OLLAMA_INTEGRATION ?? '').toLowerCase());

async function reachable(): Promise<boolean> {
  const { nativeUrl } = loadLLMConfig(env);
  try {
    const res = await fetch(nativeUrl + '/api/version', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Resolve the skip reason once, before defining tests.
const skip: true | string | false = !optedIn
  ? 'set RUN_OLLAMA_INTEGRATION=1 to run'
  : !process.env.MODEL_TEXT
    ? 'set MODEL_TEXT to the installed tag to smoke (this module has no default — ADR-0007)'
    : (await reachable())
    ? false
    : 'Ollama not reachable on the configured host';

// Constructed only when the smoke will actually run: this module has no shipping
// default (ADR-0007), so building a sidecar without MODEL_TEXT throws — and at
// module scope that would fail the file on import, even when every test is skipped.
const llm = skip ? undefined : createOllamaSidecar({ env });

before(async () => {
  if (skip) return;
  await llm!.start();
});

after(async () => {
  if (skip) return;
  await llm!.stop();
});

test('isHealthy() is true once started', { skip }, async () => {
  assert.equal(await llm!.isHealthy(), true);
});

test('chat() returns non-empty text', { skip }, async () => {
  const res = await llm!.chat({
    role: 'fast',
    messages: [{ role: 'user', content: 'Reply with the single word: ready.' }],
    maxTokens: 512,
  });
  assert.ok(res.content.trim().length > 0, 'expected non-empty content');
  assert.ok(res.model.length > 0);
});

test('chatStream() yields deltas and a terminal done', { skip }, async () => {
  let text = '';
  let sawDone = false;
  for await (const chunk of llm!.chatStream({
    role: 'fast',
    messages: [{ role: 'user', content: 'Count: one two three.' }],
    maxTokens: 512,
  })) {
    text += chunk.delta;
    sawDone ||= chunk.done;
  }
  assert.ok(text.trim().length > 0);
  assert.equal(sawDone, true);
});

test('chatJSON() returns a parsed object', { skip }, async () => {
  const obj = await llm!.chatJSON<{ ok: boolean }>({
    role: 'deep',
    messages: [{ role: 'user', content: 'Return {"ok": true} as JSON, nothing else.' }],
    maxTokens: 512,
  });
  assert.ok(obj !== null && typeof obj === 'object');
});
