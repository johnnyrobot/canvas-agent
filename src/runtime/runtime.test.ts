import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatOptions, ChatResult } from '../llm/index.js';
import type { ActivityTracker } from './activity.js';
import type { LazyDatabase } from './database.js';
import { createRuntime, type OwnedIngest, type OwnedLlm } from './runtime.js';

const chatResult = (content: string): ChatResult => ({ content, model: 'm', raw: {} });

/** An owned LLM double: records stops, satisfies both ChatRunner and LlmRuntime. */
function fakeLlm(overrides: { stop?: () => Promise<void> } = {}) {
  const state = { stops: 0 };
  const llm: OwnedLlm = {
    async chat(_opts: ChatOptions) {
      return chatResult('ok');
    },
    async describeImage() {
      return chatResult('alt');
    },
    async isHealthy() {
      return true;
    },
    async stop() {
      state.stops += 1;
      if (overrides.stop) await overrides.stop();
    },
  };
  return { llm, state };
}

/** An owned Docling double: records stops. */
function fakeIngest(overrides: { stop?: () => Promise<void> } = {}) {
  const state = { stops: 0 };
  const ingest: OwnedIngest = {
    async convertPath() {
      return { status: 'success', processingTimeMs: 1 };
    },
    async isHealthy() {
      return true;
    },
    async stop() {
      state.stops += 1;
      if (overrides.stop) await overrides.stop();
    },
  };
  return { ingest, state };
}

/** A LazyDatabase double: records closes. */
function fakeLazyDb() {
  const state = { closes: 0 };
  const database: LazyDatabase = {
    async open() {
      throw new Error('not used in this test');
    },
    async close() {
      state.closes += 1;
    },
  };
  return { database, state };
}

test('dispose stops both sidecars and closes the database', async () => {
  const llm = fakeLlm();
  const ingest = fakeIngest();
  const db = fakeLazyDb();
  const runtime = createRuntime({
    createLlm: () => llm.llm,
    createIngest: () => ingest.ingest,
    createDatabase: () => db.database,
  });
  await runtime.dispose();
  assert.equal(llm.state.stops, 1);
  assert.equal(ingest.state.stops, 1);
  assert.equal(db.state.closes, 1);
});

test('the LLM is stopped ONCE even though it backs both llm and chatRunner', async () => {
  const llm = fakeLlm();
  const runtime = createRuntime({
    createLlm: () => llm.llm,
    createIngest: () => fakeIngest().ingest,
    createDatabase: () => fakeLazyDb().database,
  });
  await runtime.dispose();
  assert.equal(llm.state.stops, 1, 'chatRunner and llm are the same object; stopping it twice is a bug');
});

test('one failing stop does not prevent the others from running', async () => {
  const llm = fakeLlm({
    stop: async () => {
      throw new Error('ollama refused to stop');
    },
  });
  const ingest = fakeIngest();
  const db = fakeLazyDb();
  const logs: string[] = [];
  const runtime = createRuntime({
    createLlm: () => llm.llm,
    createIngest: () => ingest.ingest,
    createDatabase: () => db.database,
    log: (msg) => logs.push(msg),
  });
  await runtime.dispose(); // must not reject
  assert.equal(ingest.state.stops, 1, 'docling must still be signalled');
  assert.equal(db.state.closes, 1, 'the database must still be closed');
  assert.ok(
    logs.some((l) => /ollama/.test(l) && /refused to stop/.test(l)),
    `expected a log line reporting the ollama failure, got: ${JSON.stringify(logs)}`,
  );
});

test('dispose is idempotent', async () => {
  const llm = fakeLlm();
  const ingest = fakeIngest();
  const runtime = createRuntime({
    createLlm: () => llm.llm,
    createIngest: () => ingest.ingest,
    createDatabase: () => fakeLazyDb().database,
  });
  await Promise.all([runtime.dispose(), runtime.dispose()]);
  await runtime.dispose();
  assert.equal(llm.state.stops, 1);
  assert.equal(ingest.state.stops, 1);
});

test('dispose drains an in-flight turn BEFORE it signals anything', async () => {
  const order: string[] = [];
  const llm = fakeLlm({
    stop: async () => {
      order.push('stop');
    },
  });
  let releaseDrain!: () => void;
  const drained = new Promise<void>((r) => {
    releaseDrain = r;
  });
  const tracker: ActivityTracker = {
    begin: () => () => {},
    async whenIdle() {
      order.push('drain-start');
      await drained;
      order.push('drain-end');
      return true;
    },
  };
  const runtime = createRuntime({
    createLlm: () => llm.llm,
    createIngest: () => fakeIngest().ingest,
    createDatabase: () => fakeLazyDb().database,
    createActivity: () => tracker,
  });
  const disposing = runtime.dispose();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['drain-start'], 'must not signal the sidecars mid-turn');
  releaseDrain();
  await disposing;
  assert.deepEqual(order, ['drain-start', 'drain-end', 'stop']);
});

test('the api it returns is a working AppApi', async () => {
  const runtime = createRuntime({
    createLlm: () => fakeLlm().llm,
    createIngest: () => fakeIngest().ingest,
    createDatabase: () => fakeLazyDb().database,
  });
  const health = await runtime.api.health();
  assert.equal(health.llm, true);
  assert.equal(health.ingest, true);
});

test('dispose waits for a turn started through the real api before stopping the sidecars', async () => {
  let releaseModel!: () => void;
  const modelBlocked = new Promise<void>((r) => {
    releaseModel = r;
  });
  const llm = fakeLlm();
  // Make the model hang until we release it, so a turn is genuinely in flight.
  llm.llm.chat = async () => {
    await modelBlocked;
    return chatResult('done');
  };
  const ingest = fakeIngest();

  const runtime = createRuntime({
    createLlm: () => llm.llm,
    createIngest: () => ingest.ingest,
    createDatabase: () => fakeLazyDb().database,
    audit: async () => ({ issues: [] }),
    retriever: async () => ({ hits: [] }),
  });

  const turn = runtime.api.runTurn({ user: 'hello' });
  await new Promise((r) => setImmediate(r));

  const disposing = runtime.dispose();
  await new Promise((r) => setImmediate(r));
  assert.equal(llm.state.stops, 0, 'must not stop the LLM while a real turn is still in flight');

  releaseModel();
  await turn;
  await disposing;
  assert.equal(llm.state.stops, 1);
  assert.equal(ingest.state.stops, 1);
});
