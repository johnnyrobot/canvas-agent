import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOllamaSidecar,
  decodedBase64Bytes,
  MAX_DESCRIBE_IMAGE_BYTES,
  ModelNotFetchedError,
} from './sidecar.js';
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

/**
 * A fake `/api/tags` reporting exactly `present` as installed locally, plus the
 * `/api/show` capability answer for each tag.
 *
 * Capabilities default to a fully-capable model, so a test that says nothing
 * about them is testing presence against a tag that CAN do the job — which is
 * what every pre-#38 test meant by "installed". Pass `caps` to describe a tag
 * that is installed and cannot: the case where presence and usability come
 * apart (ADR-0010).
 */
function tagsFetch(present: string[], caps: Record<string, string[]> = {}) {
  const fetch: FetchLike = async (url, init) => {
    const path = String(url);
    if (path.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: present.map((name) => ({ name, model: name })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path.endsWith('/api/show')) {
      const tag = (JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? '';
      return new Response(JSON.stringify({ capabilities: caps[tag] ?? ['completion', 'tools', 'vision'] }), {
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

test('pullModel downloads the FIRST-RUN set, which no longer includes vision (ADR-0012)', async () => {
  // Was "every distinct required model". Vision is still required — it just is
  // not fetched until the instructor asks for something that needs it, which is
  // what takes first run from ~8.6 GB to 5.3 GB.
  const { sidecar, pulled } = pullingSidecar({ ...baseEnv, MODEL_VISION: 'test-vision:2b' });
  await sidecar.pullModel();
  assert.deepEqual(pulled, ['test-text:1b']);
});

test('pullModel names the model each progress line belongs to', async () => {
  const { sidecar } = pullingSidecar({ ...baseEnv, MODEL_VISION: 'test-vision:2b' });
  const seen: Array<{ status: string; model?: string }> = [];
  await sidecar.pullModel((p) => seen.push(p));
  assert.deepEqual(
    [...new Set(seen.map((p) => p.model))],
    ['test-text:1b'],
    'progress names the tag currently transferring, in pull order',
  );
  assert.equal(seen.length, 3, 'the first-run pull streams its own progress');
});

test('pullModel requests a shared tag ONCE, not once per role', async () => {
  // Not the shipping defaults since #33 (text and vision are distinct tags), but
  // still reachable: an operator can point both required roles at one multimodal
  // tag, and that must stay one download rather than two identical pulls.
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
  // The vision entry reads `deferred` rather than `missing` since ADR-0012 — the
  // roles are still reported separately, which is what this test is about.
  assert.deepEqual(status.models, [
    { role: 'text', tag: 'test-text:1b', status: 'ready' },
    { role: 'vision', tag: 'test-vision:2b', status: 'deferred' },
  ]);
});

test('modelStatus is NOT ready when a first-run model is absent or an installed one cannot do its job', async () => {
  // ADR-0009's rule, restated for the set ADR-0012 leaves: "a partial install
  // must never read as ready" is about the models first run promised to fetch.
  // A deferred model was never promised at setup, so it does not make the
  // install partial — but an installed model that cannot do its job still does.
  const env = { ...baseEnv, MODEL_VISION: 'test-vision:2b' };
  const nothing = createOllamaSidecar({ env, fetch: tagsFetch([]) });
  assert.equal((await nothing.modelStatus()).ready, false, 'the text model is a first-run promise');

  const visionOnly = createOllamaSidecar({ env, fetch: tagsFetch(['test-vision:2b']) });
  assert.equal((await visionOnly.modelStatus()).ready, false, 'vision alone is not an app');

  const incapableVision = createOllamaSidecar({
    env,
    fetch: tagsFetch(['test-text:1b', 'test-vision:2b'], { 'test-vision:2b': ['completion'] }),
  });
  assert.equal((await incapableVision.modelStatus()).ready, false, 'fetched but blind is still a broken promise');

  const both = createOllamaSidecar({ env, fetch: tagsFetch(['test-text:1b', 'test-vision:2b']) });
  assert.equal((await both.modelStatus()).ready, true, 'ready when every required model is satisfied');
});

test('modelStatus is not ready when the daemon is unreachable', async () => {
  // Nothing is known to be installed, so the first-run model reads missing and
  // the set is not ready. The deferred role reads deferred rather than missing
  // even here: the two facts it distinguishes are about what was PROMISED at
  // setup, not about what the probe managed to see, and the unreachable daemon
  // is already reported on its own (`llm: false`).
  const env = { ...baseEnv, MODEL_VISION: 'test-vision:2b' };
  const down: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  const status = await createOllamaSidecar({ env, fetch: down }).modelStatus();
  assert.equal(status.ready, false);
  assert.deepEqual(
    status.models.map((m) => m.status),
    ['missing', 'deferred'],
  );
});

// ── Capability, not presence (ADR-0010) ─────────────────────────────────────

test('an installed model that cannot do its role’s job reads as INCAPABLE, never ready', async () => {
  // The #29 regression, reduced: the vision role pointed at a text-only tag that
  // IS installed. Presence was the whole test, so every surface read green and
  // describeImage failed with `/api/chat returned 400` at runtime.
  const env = { ...baseEnv, MODEL_VISION: 'text-only:8b' };
  const fetch = tagsFetch(['test-text:1b', 'text-only:8b'], { 'text-only:8b': ['completion', 'tools'] });
  const status = await createOllamaSidecar({ env, fetch }).modelStatus();

  assert.equal(status.ready, false, 'an incapable required model must not read as ready');
  assert.deepEqual(status.models, [
    { role: 'text', tag: 'test-text:1b', status: 'ready' },
    { role: 'vision', tag: 'text-only:8b', status: 'incapable' },
  ]);
});

test('the TEXT role requires tool-calling, not merely completion', async () => {
  // The same bug one layer in: the orchestrator is a tool-calling loop, so a text
  // override without `tools` fails deep inside a turn rather than at startup.
  const fetch = tagsFetch(['test-text:1b'], { 'test-text:1b': ['completion'] });
  const status = await createOllamaSidecar({ env: baseEnv, fetch }).modelStatus();
  assert.equal(status.models[0]?.status, 'incapable');
});

test('an EMPTY capability list is a real answer, not a probe failure', async () => {
  const fetch = tagsFetch(['test-text:1b'], { 'test-text:1b': [] });
  const status = await createOllamaSidecar({ env: baseEnv, fetch }).modelStatus();
  assert.equal(status.models[0]?.status, 'incapable');
});

test('a FAILED capability probe falls back to presence rather than accusing the tag', async () => {
  // The documented asymmetry of ADR-0010. Reporting `incapable` here would tell a
  // user with a correct configuration to change it, on the strength of a daemon
  // hiccup — and `incapable` recovery is advice, so no retry clears it.
  const flaky: FetchLike = async (url) => {
    const path = String(url);
    if (path.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'test-text:1b', model: 'test-text:1b' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('ECONNRESET');
  };
  const status = await createOllamaSidecar({ env: baseEnv, fetch: flaky }).modelStatus();
  assert.equal(status.models[0]?.status, 'ready', 'an unknown capability is not evidence of incapability');
});

// ── A disabled capability leaves the required set (ADR-0010) ─────────────────

test('vision disabled: the role reports DISABLED and the set is still ready', async () => {
  const env = { ...baseEnv, MODEL_VISION: 'test-vision:2b', LLM_VISION_ENABLED: 'false' };
  const status = await createOllamaSidecar({ env, fetch: tagsFetch(['test-text:1b']) }).modelStatus();

  assert.equal(status.ready, true, 'readiness must not gate on a model nothing will call');
  assert.deepEqual(status.models, [
    { role: 'text', tag: 'test-text:1b', status: 'ready' },
    { role: 'vision', tag: 'test-vision:2b', status: 'disabled' },
  ]);
});

test('vision disabled: the role is still REPORTED, never dropped from the payload', async () => {
  // Dropping it would read to the UI as "nothing missing" — the silent-hole
  // failure restated, which is the whole reason the state is named.
  const env = { ...baseEnv, MODEL_VISION: 'test-vision:2b', LLM_VISION_ENABLED: 'false' };
  const status = await createOllamaSidecar({ env, fetch: tagsFetch(['test-text:1b']) }).modelStatus();
  assert.equal(status.models.length, 2);
  assert.ok(status.models.some((m) => m.role === 'vision'));
});

test('vision disabled: provisioning does not download the vision model', async () => {
  const { sidecar, pulled } = pullingSidecar({
    ...baseEnv,
    MODEL_VISION: 'test-vision:2b',
    LLM_VISION_ENABLED: 'false',
  });
  await sidecar.pullModel();
  assert.deepEqual(pulled, ['test-text:1b'], 'a disabled capability must not cost a multi-gigabyte pull');
});

// ── The vision model is pulled on first use (ADR-0012) ───────────────────────

const deferredEnv = { ...baseEnv, MODEL_VISION: 'test-vision:2b' };

test('vision not yet pulled: the role reports DEFERRED, and the set is still ready', async () => {
  // The distinction this state exists to draw: absent-and-broken versus
  // not-yet-fetched. Nothing is wrong here, so nothing may read as wrong.
  const status = await createOllamaSidecar({
    env: deferredEnv,
    fetch: tagsFetch(['test-text:1b']),
  }).modelStatus();

  assert.equal(status.ready, true, 'a model the app will fetch on demand is not a reason to hold the app back');
  assert.deepEqual(status.models, [
    { role: 'text', tag: 'test-text:1b', status: 'ready' },
    { role: 'vision', tag: 'test-vision:2b', status: 'deferred' },
  ]);
});

test('a MISSING text model is still missing — deferral belongs to the role, not to absence', async () => {
  // The text model is fetched at first run, so its absence is a real failure and
  // must keep reading as one. If `deferred` leaked to every uninstalled tag it
  // would silence the very state ADR-0009 exists to enforce.
  const status = await createOllamaSidecar({ env: deferredEnv, fetch: tagsFetch([]) }).modelStatus();

  assert.equal(status.ready, false);
  assert.equal(status.models[0]?.status, 'missing');
});

test('vision installed: the role is graded normally again, capability and all', async () => {
  const ready = await createOllamaSidecar({
    env: deferredEnv,
    fetch: tagsFetch(['test-text:1b', 'test-vision:2b']),
  }).modelStatus();
  assert.equal(ready.models[1]?.status, 'ready');

  // Deferral is about WHEN it is fetched, never about whether it can see: a
  // fetched tag that cannot do the job is incapable, exactly as before.
  const incapable = await createOllamaSidecar({
    env: deferredEnv,
    fetch: tagsFetch(['test-text:1b', 'test-vision:2b'], { 'test-vision:2b': ['completion', 'tools'] }),
  }).modelStatus();
  assert.equal(incapable.models[1]?.status, 'incapable');
  assert.equal(incapable.ready, false, 'an incapable model is still a reason to hold the app back');
});

test('vision switched off outranks deferral — an operator who said no is not offered a download', async () => {
  const status = await createOllamaSidecar({
    env: { ...deferredEnv, LLM_VISION_ENABLED: 'false' },
    fetch: tagsFetch(['test-text:1b']),
  }).modelStatus();
  assert.equal(status.models[1]?.status, 'disabled');
});

test('pullVisionModel fetches the deferred tag, and only that one', async () => {
  const { sidecar, pulled } = pullingSidecar(deferredEnv);
  await sidecar.pullVisionModel();
  assert.deepEqual(pulled, ['test-vision:2b']);
});

test('pullVisionModel streams its own progress, naming the tag', async () => {
  const { sidecar } = pullingSidecar(deferredEnv);
  const seen: Array<{ status: string; model?: string }> = [];
  await sidecar.pullVisionModel((p) => seen.push(p));
  assert.deepEqual([...new Set(seen.map((p) => p.model))], ['test-vision:2b']);
  assert.deepEqual(
    seen.map((p) => p.status),
    ['pulling manifest', 'downloading', 'success'],
  );
});

test('describeImage on a not-yet-fetched model fails with the deferred diagnosis, not a raw 404', async () => {
  // The in-turn guard of ADR-0012. A pre-turn check can be bypassed by a path
  // nobody anticipated, and what the user sees then must not be
  // `Ollama /api/chat returned 404` — the error that names nothing they can act
  // on, and the exact shape of the failure this whole lane exists to end.
  const notFound: FetchLike = async () =>
    new Response(JSON.stringify({ error: `model "test-vision:2b" not found, try pulling it first` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  const sidecar = createOllamaSidecar({ env: deferredEnv, fetch: notFound });

  await assert.rejects(
    async () => sidecar.describeImage({ image: 'QUJD', prompt: 'alt?' }),
    (err: Error) => {
      assert.ok(err instanceof ModelNotFetchedError, 'the caller must be able to tell this from any other failure');
      assert.equal(err.tag, 'test-vision:2b', 'and know which model to offer');
      assert.match(err.message, /alt-text|download/i, 'the text a person reads says what to do');
      return true;
    },
  );
});

test('a 400 from a model that cannot see is NOT reported as a missing download', async () => {
  // The failure #39 and ADR-0010 quote verbatim — `Ollama /api/chat returned
  // 400` — is a model that is INSTALLED and text-only. Its fix is to change the
  // tag (`incapable`), never to download the one already on disk, so rewriting
  // it here would send an instructor to wait on gigabytes that cannot help.
  const cannotSee: FetchLike = async () =>
    new Response(JSON.stringify({ error: 'this model does not support images' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  const sidecar = createOllamaSidecar({ env: deferredEnv, fetch: cannotSee });
  await assert.rejects(
    async () => sidecar.describeImage({ image: 'QUJD', prompt: 'alt?' }),
    (err: Error) => !(err instanceof ModelNotFetchedError),
  );
});

test('describeImage does not disguise an unrelated failure as a deferred model', async () => {
  // Rewriting every error into "just download it" would send a user to a
  // download that fixes nothing — the same loop the incapable state refuses.
  const boom: FetchLike = async () =>
    new Response(JSON.stringify({ error: 'out of memory' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  const sidecar = createOllamaSidecar({ env: deferredEnv, fetch: boom });
  await assert.rejects(
    async () => sidecar.describeImage({ image: 'QUJD', prompt: 'alt?' }),
    (err: Error) => !(err instanceof ModelNotFetchedError),
  );
});

test('pullVisionModel downloads nothing when the operator switched vision off', async () => {
  const { sidecar, pulled } = pullingSidecar({ ...deferredEnv, LLM_VISION_ENABLED: 'false' });
  await sidecar.pullVisionModel();
  assert.deepEqual(pulled, [], 'a capability nobody will call must never cost a download');
});
