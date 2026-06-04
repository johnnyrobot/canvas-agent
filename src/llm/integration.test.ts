/**
 * Integration tests for the LLM sidecar against a REAL Ollama.
 *
 * Skipped by default so `npm test` stays green in CI / dev without Ollama.
 * To run:  RUN_OLLAMA_INTEGRATION=1 ollama serve & ; ollama pull gemma4:12b-mlx
 *          RUN_OLLAMA_INTEGRATION=1 npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaSidecar, loadLLMConfig } from './index.js';

const optedIn = ['1', 'true', 'yes'].includes((process.env.RUN_OLLAMA_INTEGRATION ?? '').toLowerCase());

async function reachable(): Promise<boolean> {
  const { nativeUrl } = loadLLMConfig();
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
  : (await reachable())
    ? false
    : 'Ollama not reachable on the configured host';

const llm = createOllamaSidecar();

before(async () => {
  if (skip) return;
  await llm.start();
});

after(async () => {
  if (skip) return;
  await llm.stop();
});

test('isHealthy() is true once started', { skip }, async () => {
  assert.equal(await llm.isHealthy(), true);
});

test('chat() returns non-empty text', { skip }, async () => {
  const res = await llm.chat({
    role: 'fast',
    messages: [{ role: 'user', content: 'Reply with the single word: ready.' }],
    maxTokens: 16,
  });
  assert.ok(res.content.trim().length > 0, 'expected non-empty content');
  assert.ok(res.model.length > 0);
});

test('chatStream() yields deltas and a terminal done', { skip }, async () => {
  let text = '';
  let sawDone = false;
  for await (const chunk of llm.chatStream({
    role: 'fast',
    messages: [{ role: 'user', content: 'Count: one two three.' }],
    maxTokens: 32,
  })) {
    text += chunk.delta;
    sawDone ||= chunk.done;
  }
  assert.ok(text.trim().length > 0);
  assert.equal(sawDone, true);
});

test('chatJSON() returns a parsed object', { skip }, async () => {
  const obj = await llm.chatJSON<{ ok: boolean }>({
    role: 'deep',
    messages: [{ role: 'user', content: 'Return {"ok": true} as JSON, nothing else.' }],
    maxTokens: 64,
  });
  assert.equal(typeof obj, 'object');
});
