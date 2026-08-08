import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaSidecar, decodedBase64Bytes, MAX_DESCRIBE_IMAGE_BYTES } from './sidecar.js';
import { OllamaProcess } from './process.js';
import { loadLLMConfig } from './config.js';
import type { FetchLike } from './client.js';

const baseEnv = { LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MANAGE_PROCESS: 'false', MODEL_TEXT: 'test-text:1b' };

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

/**
 * A fake `/api/pull` that RECORDS the tag of every pull it is asked for.
 *
 * Recording the tags is the point: a stub that answers every pull identically
 * cannot tell one download from two, and "pulls only the text model" is exactly
 * the regression the two-required-models work risks (#30, ADR-0009).
 */
function recordingPullFetch() {
  const pulled: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = String(url);
    if (path.endsWith('/api/pull')) {
      pulled.push((JSON.parse(String(init?.body ?? '{}')) as { name?: string }).name ?? '');
      return new Response(
        [
          '{"status":"pulling manifest"}',
          '{"status":"downloading","total":1000,"completed":500}',
          '{"status":"success"}',
        ].join('\n') + '\n',
        { status: 200 },
      );
    }
    throw new Error(`unexpected request to ${path}`);
  };
  return { fetch, pulled };
}

/** A fake `/api/tags` reporting exactly `present` as installed locally. */
function tagsFetch(present: string[]) {
  const fetch: FetchLike = async (url) => {
    const path = String(url);
    if (path.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: present.map((name) => ({ name, model: name })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request to ${path}`);
  };
  return fetch;
}

/** A sidecar over a recording `/api/pull`, with the daemon lifecycle stubbed out. */
function pullingSidecar(env: Record<string, string | undefined>) {
  const rec = recordingPullFetch();
  const process = new CountingProcess(loadLLMConfig(env));
  return { ...rec, process, sidecar: createOllamaSidecar({ env, fetch: rec.fetch, process }) };
}

test('pullModel brings the daemon up, then streams normalized progress (percent derived)', async () => {
  const { sidecar, process: proc } = pullingSidecar(baseEnv);
  const seen: Array<{ status: string; percent?: number }> = [];
  await sidecar.pullModel((p) => seen.push(p));
  assert.equal(proc.ensureAliveCalls, 1, 'ensures the bundled daemon is up before pulling');
  assert.deepEqual(
    seen.map((p) => p.status),
    ['pulling manifest', 'downloading', 'success'],
  );
  assert.equal(seen[1]?.percent, 50, 'derives percent from completed/total');
});

test('pullModel downloads EVERY distinct required model, not just the text one', async () => {
  const { sidecar, pulled } = pullingSidecar({ ...baseEnv, MODEL_VISION: 'test-vision:2b' });
  await sidecar.pullModel();
  assert.deepEqual(pulled, ['test-text:1b', 'test-vision:2b']);
});

test('pullModel names the model each progress line belongs to', async () => {
  const { sidecar } = pullingSidecar({ ...baseEnv, MODEL_VISION: 'test-vision:2b' });
  const seen: Array<{ status: string; model?: string }> = [];
  await sidecar.pullModel((p) => seen.push(p));
  assert.deepEqual(
    [...new Set(seen.map((p) => p.model))],
    ['test-text:1b', 'test-vision:2b'],
    'progress names the tag currently transferring, in pull order',
  );
  assert.equal(seen.length, 6, 'both pulls stream their own progress');
});

test('pullModel requests a shared tag ONCE, not once per role', async () => {
  // Today's production shape: vision inherits the text model → one download.
  const { sidecar, pulled } = pullingSidecar(baseEnv);
  await sidecar.pullModel();
  assert.deepEqual(pulled, ['test-text:1b']);
});

test('pullModel never downloads a role outside the required set, however it is configured', async () => {
  // A `deep` override is a real, huge tag no production path calls (ADR-0009);
  // provisioning must not turn it into a multi-gigabyte first-run surprise.
  const { sidecar, pulled } = pullingSidecar({
    ...baseEnv,
    MODEL_DEEP: 'test-deep:30b',
    MODEL_FAST: 'test-fast:1b',
    MODEL_CHEAP: 'test-cheap:0.5b',
  });
  await sidecar.pullModel();
  assert.deepEqual(pulled, ['test-text:1b']);
});

test('modelStatus reports each required model separately', async () => {
  const env = { ...baseEnv, MODEL_VISION: 'test-vision:2b' };
  const sidecar = createOllamaSidecar({ env, fetch: tagsFetch(['test-text:1b']) });
  const status = await sidecar.modelStatus();
  assert.deepEqual(status.models, [
    { role: 'text', tag: 'test-text:1b', available: true },
    { role: 'vision', tag: 'test-vision:2b', available: false },
  ]);
});

test('modelStatus is NOT available when one required model is present and the other is missing', async () => {
  const env = { ...baseEnv, MODEL_VISION: 'test-vision:2b' };
  const textOnly = createOllamaSidecar({ env, fetch: tagsFetch(['test-text:1b']) });
  assert.equal((await textOnly.modelStatus()).available, false, 'a partial install must never read as ready');

  const visionOnly = createOllamaSidecar({ env, fetch: tagsFetch(['test-vision:2b']) });
  assert.equal((await visionOnly.modelStatus()).available, false);

  const both = createOllamaSidecar({ env, fetch: tagsFetch(['test-text:1b', 'test-vision:2b']) });
  assert.equal((await both.modelStatus()).available, true, 'ready only when every required model is present');
});

test('modelStatus reports everything missing when the daemon is unreachable', async () => {
  const env = { ...baseEnv, MODEL_VISION: 'test-vision:2b' };
  const down: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  const status = await createOllamaSidecar({ env, fetch: down }).modelStatus();
  assert.equal(status.available, false);
  assert.deepEqual(
    status.models.map((m) => m.available),
    [false, false],
  );
});
