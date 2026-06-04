import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from './registry.js';
import { createCanonicalTools, NotImplementedError } from './tools.js';
import type { Tool } from './types.js';

const fakeTool = (name: string): Tool => ({
  definition: { name, description: name, parameters: { type: 'object', properties: {} } },
  execute: async () => ({ ok: true }),
});

test('register / get / has / size / definitions', () => {
  const reg = new ToolRegistry().registerAll([fakeTool('a'), fakeTool('b')]);
  assert.equal(reg.size, 2);
  assert.equal(reg.has('a'), true);
  assert.equal(reg.get('b')?.definition.name, 'b');
  assert.deepEqual(reg.definitions().map((d) => d.name).sort(), ['a', 'b']);
});

test('duplicate registration throws', () => {
  const reg = new ToolRegistry().register(fakeTool('a'));
  assert.throws(() => reg.register(fakeTool('a')), /Duplicate tool: a/);
});

test('canonical tools advertise the PRD §15.3 names', () => {
  const reg = new ToolRegistry().registerAll(createCanonicalTools({}));
  const names = reg.definitions().map((d) => d.name).sort();
  assert.deepEqual(names, [
    'audit_html',
    'check_contrast',
    'describe_image',
    'ingest_document',
    'render_template',
    'resolve_theme',
    'retrieve_kb',
    'validate_allowlist',
  ]);
});

test('a canonical tool with no injected dep throws NotImplemented', async () => {
  const reg = new ToolRegistry().registerAll(createCanonicalTools({}));
  await assert.rejects(() => reg.get('audit_html')!.execute({ html: '<p>x</p>' }, {}), NotImplementedError);
});

test('an injected dep is invoked with mapped args', async () => {
  let seen = '';
  const reg = new ToolRegistry().registerAll(
    createCanonicalTools({
      auditHtml: async (html) => {
        seen = html;
        return { issues: [] };
      },
    }),
  );
  const result = await reg.get('audit_html')!.execute({ html: '<h2>Hi</h2>' }, {});
  assert.equal(seen, '<h2>Hi</h2>');
  assert.deepEqual(result, { issues: [] });
});
