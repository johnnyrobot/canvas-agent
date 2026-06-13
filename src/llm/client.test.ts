import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaClient, type FetchLike } from './client.js';
import { loadLLMConfig } from './config.js';
import type { ChatChunk } from './types.js';

const config = loadLLMConfig({});

/** A fetch that returns the given NDJSON body as a streaming Response. */
function ndjsonFetch(lines: object[]): FetchLike {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return (async () => new Response(body, { status: 200 })) as unknown as FetchLike;
}

/** A fetch that returns a single JSON object (the non-streaming `/api/chat` shape). */
function jsonFetch(obj: object): FetchLike {
  return (async () => new Response(JSON.stringify(obj), { status: 200 })) as unknown as FetchLike;
}

test('chatStream surfaces native tool_calls from the stream (C1 transport)', async () => {
  const client = new OllamaClient(
    config,
    ndjsonFetch([
      { message: { content: 'one moment' }, done: false },
      {
        message: {
          content: '',
          tool_calls: [{ function: { name: 'audit_html', arguments: { html: '<img>' } } }],
        },
        done: false,
      },
      { message: { content: '' }, done: true },
    ]),
  );

  const chunks: ChatChunk[] = [];
  for await (const c of client.chatStream({ messages: [{ role: 'user', content: 'x' }] })) {
    chunks.push(c);
  }

  const withTools = chunks.find((c) => c.toolCalls && c.toolCalls.length > 0);
  assert.ok(withTools, 'expected a stream chunk carrying tool_calls');
  assert.equal(withTools.toolCalls?.[0]?.name, 'audit_html');
  assert.deepEqual(withTools.toolCalls?.[0]?.arguments, { html: '<img>' });
  // Text deltas still stream through alongside the tool call.
  assert.equal(chunks.map((c) => c.delta).join(''), 'one moment');
});

test('chatStream throws on a mid-stream Ollama error line instead of swallowing it (C11)', async () => {
  // A standalone {"error":...} NDJSON line has no message/done/tool_calls, so the
  // old guard dropped it silently and the stream ended as if the draft completed.
  const client = new OllamaClient(
    config,
    ndjsonFetch([
      { message: { content: 'partial draft' }, done: false },
      { error: 'model runner has crashed' },
    ]),
  );

  await assert.rejects(
    async () => {
      const drained: ChatChunk[] = [];
      for await (const c of client.chatStream({ messages: [{ role: 'user', content: 'x' }] })) {
        drained.push(c);
      }
    },
    /model runner has crashed/,
  );
});

test('chatStream surfaces done_reason so truncation is detectable (C11)', async () => {
  // done_reason='length' = the model was cut off. Downstream must be able to tell a
  // truncated draft from a complete one (it was previously dropped entirely).
  const client = new OllamaClient(
    config,
    ndjsonFetch([
      { message: { content: 'this draft was cut o' }, done: false },
      { message: { content: '' }, done: true, done_reason: 'length' },
    ]),
  );

  const chunks: ChatChunk[] = [];
  for await (const c of client.chatStream({ messages: [{ role: 'user', content: 'x' }] })) {
    chunks.push(c);
  }

  const terminal = chunks.find((c) => c.done);
  assert.ok(terminal, 'expected a terminal chunk');
  assert.equal(terminal.doneReason, 'length');
});

test('chat() throws on a body-level Ollama error instead of returning empty (C11 non-streaming)', async () => {
  // Mirror the streaming guard: a 200 response carrying {"error":…} must reject,
  // not surface a silent empty completion.
  const client = new OllamaClient(config, jsonFetch({ model: 'm', error: 'model runner has crashed' }));
  await assert.rejects(
    () => client.chat({ messages: [{ role: 'user', content: 'x' }] }),
    /model runner has crashed/,
  );
});

test('chat() surfaces done_reason so a truncated completion is detectable (C11 non-streaming)', async () => {
  const client = new OllamaClient(
    config,
    jsonFetch({ model: 'm', message: { content: 'truncated' }, done: true, done_reason: 'length' }),
  );
  const res = await client.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.doneReason, 'length');
});
