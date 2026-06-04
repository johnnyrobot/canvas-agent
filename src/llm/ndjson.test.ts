import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNdjson } from './ndjson.js';

/** Build a ReadableStream that emits the given byte chunks (to exercise line splits). */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

test('parses one object per line', async () => {
  const objs = await collect(parseNdjson(streamOf(['{"a":1}\n{"a":2}\n'])));
  assert.deepEqual(objs, [{ a: 1 }, { a: 2 }]);
});

test('reassembles objects split across chunk boundaries', async () => {
  const objs = await collect(parseNdjson(streamOf(['{"msg":"hel', 'lo"}\n{"done":', 'true}\n'])));
  assert.deepEqual(objs, [{ msg: 'hello' }, { done: true }]);
});

test('emits a trailing object with no final newline', async () => {
  const objs = await collect(parseNdjson(streamOf(['{"a":1}\n{"a":2}'])));
  assert.deepEqual(objs, [{ a: 1 }, { a: 2 }]);
});

test('ignores blank lines and a null body', async () => {
  assert.deepEqual(await collect(parseNdjson(streamOf(['\n{"a":1}\n\n']))), [{ a: 1 }]);
  assert.deepEqual(await collect(parseNdjson(null)), []);
});

test('models an Ollama-style streaming response', async () => {
  const lines = [
    '{"message":{"content":"Acc"},"done":false}\n',
    '{"message":{"content":"essible"},"done":false}\n',
    '{"message":{"content":""},"done":true}\n',
  ];
  const chunks = await collect(parseNdjson<{ message?: { content?: string }; done?: boolean }>(streamOf(lines)));
  assert.equal(chunks.map((c) => c.message?.content ?? '').join(''), 'Accessible');
  assert.equal(chunks.at(-1)?.done, true);
});
