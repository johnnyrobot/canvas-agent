import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaSidecar, decodedBase64Bytes, MAX_DESCRIBE_IMAGE_BYTES } from './sidecar.js';
import { OllamaProcess } from './process.js';
import { loadLLMConfig } from './config.js';
import type { FetchLike } from './client.js';

const baseEnv = { LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MANAGE_PROCESS: 'false' };

/** A process double that counts liveness checks (no real daemon / spawn). */
class CountingProcess extends OllamaProcess {
  ensureAliveCalls = 0;
  override async ensureAlive(): Promise<void> {
    this.ensureAliveCalls += 1;
  }
}

/** A fake fetch that records each parsed request body and returns a canned chat reply. */
function recordingFetch() {
  const bodies: Array<{ model: string; messages: { content: string; images?: string[] }[] }> = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(
      JSON.stringify({ model: 'vision-model:test', message: { content: 'alt text' }, done: true, done_reason: 'stop' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch, bodies };
}

test('describeImage rejects when vision is disabled and never calls fetch', async () => {
  const rec = recordingFetch();
  const sidecar = createOllamaSidecar({ env: { ...baseEnv, LLM_VISION_ENABLED: 'false' }, fetch: rec.fetch });
  await assert.rejects(async () => sidecar.describeImage({ image: 'QUJD', prompt: 'alt?' }), /vision is disabled/i);
  assert.equal(rec.bodies.length, 0, 'no request is made when vision is off');
});

test('describeImage maps the vision role and strips the data: prefix into images[]', async () => {
  const rec = recordingFetch();
  const sidecar = createOllamaSidecar({
    env: { ...baseEnv, LLM_VISION_ENABLED: 'true', MODEL_VISION: 'vision-model:test' },
    fetch: rec.fetch,
  });
  const res = await sidecar.describeImage({ image: 'data:image/png;base64,QUJD', prompt: 'Describe this' });
  assert.equal(res.content, 'alt text');
  assert.equal(rec.bodies.length, 1);
  const body = rec.bodies[0]!;
  assert.equal(body.model, 'vision-model:test', 'the vision role resolves to the vision model tag');
  assert.deepEqual(body.messages[0]?.images, ['QUJD'], 'the data: prefix is stripped to raw base64');
  assert.match(body.messages[0]?.content ?? '', /Describe this/);
});

test('describeImage rejects an oversized image BEFORE any fetch (size guard)', async () => {
  const rec = recordingFetch();
  const sidecar = createOllamaSidecar({ env: { ...baseEnv, LLM_VISION_ENABLED: 'true' }, fetch: rec.fetch });
  // base64 chars → ~ len*3/4 bytes; build one comfortably over the limit.
  const overChars = Math.ceil(((MAX_DESCRIBE_IMAGE_BYTES + 4096) * 4) / 3);
  const huge = 'A'.repeat(overChars);
  await assert.rejects(async () => sidecar.describeImage({ image: huge, prompt: 'x' }), /too large/i);
  assert.equal(rec.bodies.length, 0, 'an oversized image must not reach the model');
});

test('chat() and chatStream() ensure the daemon is alive before issuing the request', async () => {
  const rec = recordingFetch();
  const proc = new CountingProcess(loadLLMConfig(baseEnv));
  const sidecar = createOllamaSidecar({ env: baseEnv, fetch: rec.fetch, process: proc });

  await sidecar.chat({ role: 'deep', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(proc.ensureAliveCalls, 1, 'chat() checks daemon liveness first');
  assert.equal(rec.bodies.length, 1, 'the chat request still goes through');

  for await (const _chunk of sidecar.chatStream({ role: 'deep', messages: [{ role: 'user', content: 'hi' }] })) {
    // drain
  }
  assert.equal(proc.ensureAliveCalls, 2, 'chatStream() checks daemon liveness first too');
});

test('decodedBase64Bytes approximates decoded size and strips a data: prefix', () => {
  assert.equal(decodedBase64Bytes('QUJD'), 3); // base64 of "ABC"
  assert.equal(decodedBase64Bytes('data:image/png;base64,QUJD'), 3);
  assert.equal(decodedBase64Bytes(''), 0);
});
