import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AllowlistResult, ContrastResult, IssueSet, KbResult, TemplateResult, ThemeResult } from '../contracts/index.js';
import type { Auditor } from '../contracts/index.js';
import { createEngineDeps } from './deps.js';

/** A scripted offline auditor (the real Playwright audit is browser-bound). */
const cleanAudit: Auditor = async () => ({ issues: [] });

function makeDeps(over: Partial<Parameters<typeof createEngineDeps>[0]> = {}) {
  return createEngineDeps({
    uploadsDir: '/app/uploads',
    audit: cleanAudit,
    retriever: async (q): Promise<KbResult> => ({
      hits: [{ id: 'p:1', packId: 'p', title: 't', snippet: `hit:${q}`, score: 1, citation: 'C1' }],
    }),
    llm: { describeImage: async (o) => ({ content: `alt:${o.prompt}`, model: 'm', raw: {} }) },
    ingest: { convertPath: async (p) => ({ status: 'success', processingTimeMs: 1, markdown: `md:${p}` }) },
    ...over,
  });
}

test('createEngineDeps wires all eight EngineDeps as functions', () => {
  const d = makeDeps();
  for (const name of [
    'auditHtml', 'validateAllowlist', 'checkContrast', 'resolveTheme',
    'renderTemplate', 'ingestDocument', 'describeImage', 'retrieveKb',
  ] as const) {
    assert.equal(typeof d[name], 'function', `${name} should be wired`);
  }
});

test('validateAllowlist delegates to the real engine (repairs + reports semantic loss)', async () => {
  const d = makeDeps();
  // <h1> is rewritten to <h2>; <figure> is semantic + off-allowlist → removed.
  const res = (await d.validateAllowlist!('<figure><h1>Hi</h1></figure>')) as AllowlistResult;
  assert.ok(res.html.includes('<h2>'));
  assert.ok(!res.html.includes('<h1>'));
  assert.deepEqual(res.removedSemantic, ['figure']);
});

test('checkContrast is the real WCAG math, wrapped async', async () => {
  const d = makeDeps();
  const res = (await d.checkContrast!('#000000', '#ffffff', 'normal')) as ContrastResult;
  assert.equal(res.ratio, 21);
  assert.equal(res.passesAA, true);
});

test('auditHtml delegates to the injected auditor', async () => {
  let seen = '';
  const d = makeDeps({ audit: async (html) => { seen = html; return { issues: [] }; } });
  const res = (await d.auditHtml!('<p>x</p>')) as IssueSet;
  assert.equal(seen, '<p>x</p>');
  assert.deepEqual(res.issues, []);
});

test('resolveTheme returns AA-safe colors; empty roles falls back to the defaults', async () => {
  const d = makeDeps();
  const res = (await d.resolveTheme!('#0a0a0a', '#ffffff', [])) as ThemeResult;
  assert.ok(res.colors.length > 0, 'empty roles → default role set, not zero colors');
  for (const c of res.colors) assert.equal(c.contrast.passesAA, true);
});

test('renderTemplate validates the type and renders a valid one to allowlist-safe HTML', async () => {
  const d = makeDeps();
  const res = (await d.renderTemplate!('page-content', { title: 'Welcome' }, undefined)) as TemplateResult;
  assert.equal(res.type, 'page-content');
  assert.ok(res.html.includes('<h2'));
  assert.ok(res.html.includes('Welcome'));
});

test('renderTemplate handles an unknown type safely (warning, not a throw)', async () => {
  const d = makeDeps();
  const res = (await d.renderTemplate!('not-a-template', {}, undefined)) as TemplateResult;
  assert.ok(res.warnings.some((w) => w.includes('unknown template type')));
});

test('ingestDocument confines the fileRef to the uploads dir, then delegates (C6)', async () => {
  const d = makeDeps();
  const res = (await d.ingestDocument!('a.docx')) as { markdown?: string };
  // The sidecar receives the path resolved INSIDE the uploads dir, not the raw ref.
  assert.equal(res.markdown, 'md:/app/uploads/a.docx');
});

test('ingestDocument refuses an absolute or traversal fileRef without reading (C6)', async () => {
  let called = false;
  const d = makeDeps({
    ingest: {
      convertPath: async () => {
        called = true;
        return { status: 'success', processingTimeMs: 0 };
      },
    },
  });
  await assert.rejects(() => d.ingestDocument!('/etc/passwd'), /Refusing to ingest/);
  await assert.rejects(() => d.ingestDocument!('../../etc/passwd'), /Refusing to ingest/);
  assert.equal(called, false, 'the sidecar convertPath must never run for an escaping ref');
});

test('describeImage delegates to the LLM sidecar and returns the description text', async () => {
  const d = makeDeps();
  const res = await d.describeImage!({ image: 'base64', prompt: 'alt please' });
  assert.equal(res, 'alt:alt please');
});

test('retrieveKb delegates to the injected retriever', async () => {
  const d = makeDeps();
  const res = (await d.retrieveKb!('tables')) as KbResult;
  assert.equal(res.hits[0]?.snippet, 'hit:tables');
});

test('the wired deps satisfy createCanonicalTools (no NotImplemented for any tool)', async () => {
  const { ToolRegistry, createCanonicalTools } = await import('../orchestrator/index.js');
  const reg = new ToolRegistry().registerAll(createCanonicalTools(makeDeps()));
  // Every canonical tool resolves (does not throw NotImplementedError).
  await reg.get('check_contrast')!.execute({ fg: '#000', bg: '#fff' }, {});
  await reg.get('retrieve_kb')!.execute({ query: 'x' }, {});
  await reg.get('render_template')!.execute({ type: 'syllabus', slots: {} }, {});
});
