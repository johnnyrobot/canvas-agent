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
