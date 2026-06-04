import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLLMConfig } from './config.js';
import { buildChatRequest, resolveModel, toNativeMessage, toRawBase64 } from './payload.js';
import type { ChatOptions } from './types.js';

const config = loadLLMConfig({});

test('resolveModel maps role → tag and defaults to text', () => {
  assert.equal(resolveModel('vision', config), 'gemma4:12b-mlx');
  assert.equal(resolveModel(undefined, config), config.models.text);
});

test('toRawBase64 strips a data: URL prefix', () => {
  assert.equal(toRawBase64('data:image/png;base64,QUJD'), 'QUJD');
  assert.equal(toRawBase64('QUJD'), 'QUJD'); // already raw
});

test('toNativeMessage flattens multimodal content into {content, images}', () => {
  const native = toNativeMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ],
  });
  assert.equal(native.content, 'Describe this');
  assert.deepEqual(native.images, ['QUJD']);
});

test('toNativeMessage passes plain strings through without images', () => {
  const native = toNativeMessage({ role: 'system', content: 'You are helpful.' });
  assert.equal(native.content, 'You are helpful.');
  assert.equal(native.images, undefined);
});

test('buildChatRequest sets model, options, keep_alive and stream flag', () => {
  const opts: ChatOptions = {
    role: 'deep',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.1,
    maxTokens: 2048,
    numCtx: 8192,
  };
  const req = buildChatRequest(opts, config, true);
  assert.equal(req.model, 'gemma4:12b-mlx');
  assert.equal(req.stream, true);
  assert.equal(req.keep_alive, '24h');
  assert.equal(req.options.temperature, 0.1);
  assert.equal(req.options.num_predict, 2048);
  assert.equal(req.options.num_ctx, 8192);
  assert.equal(req.format, undefined);
  assert.equal(req.think, undefined);
});

test('buildChatRequest threads JSON format and think flags', () => {
  const req = buildChatRequest(
    { messages: [{ role: 'user', content: 'x' }], format: 'json', think: true },
    config,
    false,
  );
  assert.equal(req.format, 'json');
  assert.equal(req.think, true);
  assert.equal(req.stream, false);
});

test('buildChatRequest falls back to configured defaults', () => {
  const req = buildChatRequest({ messages: [{ role: 'user', content: 'x' }] }, config, false);
  assert.equal(req.options.temperature, config.temperature);
  assert.equal(req.options.num_ctx, config.numCtx);
  assert.equal(req.options.num_predict, config.maxOutputTokens);
});

test('toNativeMessage maps assistant toolCalls and tool results', () => {
  const asst = toNativeMessage({
    role: 'assistant',
    content: '',
    toolCalls: [{ name: 'audit_html', arguments: { html: '<p>x</p>' } }],
  });
  assert.deepEqual(asst.tool_calls, [{ function: { name: 'audit_html', arguments: { html: '<p>x</p>' } } }]);

  const toolMsg = toNativeMessage({ role: 'tool', toolName: 'audit_html', content: '{"issues":[]}' });
  assert.equal(toolMsg.tool_name, 'audit_html');
  assert.equal(toolMsg.content, '{"issues":[]}');
});

test('buildChatRequest advertises tools in native function shape', () => {
  const req = buildChatRequest(
    {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'audit_html', description: 'audit', parameters: { type: 'object', properties: {} } }],
    },
    config,
    false,
  );
  assert.equal(req.tools?.length, 1);
  assert.equal(req.tools?.[0]?.type, 'function');
  assert.equal(req.tools?.[0]?.function.name, 'audit_html');
});
