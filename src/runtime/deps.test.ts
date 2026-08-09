import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AllowlistResult, ContrastResult, IssueSet, KbResult, TemplateResult, ThemeResult } from '../contracts/index.js';
import type { Auditor } from '../contracts/index.js';
import {
  createEngineDeps,
  runtimeLlmEnv,
  RUNTIME_DEFAULT_VISION_MODEL,
  SHIPPED_MODEL_LICENCES,
  PERMISSIVE_LICENCES,
} from './deps.js';
import { loadLLMConfig, requiredModelTags } from '../llm/config.js';
// The renderer's DOM-free first-run module; imported here only so the shipped
// defaults and their declared download sizes are guarded in one place.
import { MODEL_DOWNLOAD_SIZES_GB } from '../app/renderer/model-health.js';

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

// --- shipping model defaults (ADR-0007) --------------------------------------

test('runtimeLlmEnv injects the shipping text default, and an explicit override wins', () => {
  assert.equal(runtimeLlmEnv({}).MODEL_TEXT, 'granite4.1:8b', 'permissively licensed default');
  assert.equal(
    runtimeLlmEnv({ MODEL_TEXT: 'my-own:tag' }).MODEL_TEXT,
    'my-own:tag',
    'an operator override is never overridden',
  );
  assert.equal(runtimeLlmEnv({ MODEL_TEXT: '' }).MODEL_TEXT, 'granite4.1:8b', 'empty means unset');
});

test('runtimeLlmEnv injects the shipping vision default, and an explicit override wins (#33)', () => {
  assert.equal(
    runtimeLlmEnv({}).MODEL_VISION,
    RUNTIME_DEFAULT_VISION_MODEL,
    'the vision role ships its own default',
  );
  assert.equal(
    runtimeLlmEnv({ MODEL_VISION: 'my-own-vision:tag' }).MODEL_VISION,
    'my-own-vision:tag',
    'an operator override is never overridden',
  );
  assert.equal(
    runtimeLlmEnv({ MODEL_VISION: '' }).MODEL_VISION,
    RUNTIME_DEFAULT_VISION_MODEL,
    'empty means unset',
  );
  // The override must not be undone by MODEL_TEXT's inheritance path: setting
  // only MODEL_TEXT used to change the vision tag too, which is the coupling
  // this ticket removes.
  assert.equal(
    runtimeLlmEnv({ MODEL_TEXT: 'my-own:tag' }).MODEL_VISION,
    RUNTIME_DEFAULT_VISION_MODEL,
    'a text override does not drag the vision role with it',
  );
});

test('the vision role no longer inherits the text model (#33, ADR-0009)', () => {
  // The regression this ticket closes: `granite4.1:8b` reports `completion,
  // tools` and NO vision, so while vision inherited it a real describeImage
  // call 400d. Asserting on the resolved CONFIG, not on the constants, is what
  // makes this about behaviour rather than about two strings being unequal.
  const models = loadLLMConfig(runtimeLlmEnv({})).models;
  assert.equal(models.vision, RUNTIME_DEFAULT_VISION_MODEL);
  assert.notEqual(models.vision, models.text, 'vision must resolve to a multimodal tag of its own');
});

test('the shipping defaults now provision TWO downloads (#33)', () => {
  // The tripwire left by #30, now tripped on purpose: the required set is two
  // roles and — since vision stopped inheriting text — two distinct tags, so
  // first run pulls twice. Order is role order, text first.
  assert.deepEqual(requiredModelTags(loadLLMConfig(runtimeLlmEnv({}))), [
    'granite4.1:8b',
    RUNTIME_DEFAULT_VISION_MODEL,
  ]);
});

test('every shipped model default is declared and permissively licensed (ADR-0007)', () => {
  // The constraint is invisible in the code it governs — a model tag is only a
  // string — so it is asserted here or nowhere. Injecting the defaults rather
  // than reading the constants means a NEW default role (vision, #33) is caught
  // too, not just a change to an existing one.
  const injected = runtimeLlmEnv({});
  const shipped = Object.entries(injected)
    .filter(([k]) => k.startsWith('MODEL_'))
    .map(([, tag]) => tag as string);

  assert.ok(shipped.length > 0, 'runtimeLlmEnv should inject at least the text model');
  for (const tag of shipped) {
    // `SHIPPED_MODEL_LICENCES` is typed to the permissive union, so a
    // non-permissive value cannot be declared — tsc rejects it. What tsc cannot
    // see is a default that was never declared at all, which is this assertion.
    const licence: string | undefined = SHIPPED_MODEL_LICENCES[tag];
    assert.ok(licence, `${tag} ships as a default but is not declared in SHIPPED_MODEL_LICENCES`);
    assert.ok(
      (PERMISSIVE_LICENCES as readonly string[]).includes(licence),
      `${tag} is licensed ${licence}, which is not permissive — see ADR-0007`,
    );
  }
});

test('the runtime-pulled notices name every shipped default, with its licence and source (#33)', async () => {
  // Third in the family of guards above, and undeclarable in the same way. These
  // weights are pulled by Ollama at runtime and never redistributed, so the
  // notices are the only place a district reviewing the app can see WHAT it
  // downloads and under what terms — and nothing in the code fails when a new
  // default is added and that section is not. Each entry is checked against the
  // licence THIS repo declares, so a copy-paste that keeps the previous vendor's
  // licence beside a new tag fails rather than reads plausibly.
  const notices = await readFile(new URL('../../THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8');
  const heading = '## Model weights used at runtime (NOT redistributed)';
  const start = notices.indexOf(heading);
  assert.ok(start >= 0, 'the runtime-pulled section must exist in THIRD-PARTY-NOTICES.md');
  const rest = notices.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  const section = end < 0 ? rest : rest.slice(0, end);

  for (const [tag, licence] of Object.entries(SHIPPED_MODEL_LICENCES)) {
    // Per-entry, not per-section: both defaults are Apache-2.0 today, so a
    // section-wide search for the licence string would pass on one entry.
    const entry = section.split(/\n- /).find((e) => e.includes(`\`${tag}\``));
    assert.ok(entry, `${tag} ships as a default but is not named in the runtime-pulled notices`);
    assert.ok(
      entry.includes(licence),
      `the notices entry for ${tag} does not state its declared licence (${licence})`,
    );
    assert.ok(/https?:\/\//.test(entry), `the notices entry for ${tag} states no source URL`);
  }
});

test('every shipped model default declares its download size (first-run copy, #32)', () => {
  // The sibling of the licence guard above, and undeclarable in the same way: the
  // first-run screen states the total download BEFORE the user commits to it, and
  // an undeclared tag silently downgrades that sentence to a floor ("more than
  // 5.3 GB") instead of failing. A new default (vision, #33) is caught here.
  const shipped = Object.entries(runtimeLlmEnv({}))
    .filter(([k]) => k.startsWith('MODEL_'))
    .map(([, tag]) => tag as string);

  for (const tag of shipped) {
    const gb: number | undefined = MODEL_DOWNLOAD_SIZES_GB[tag];
    assert.ok(
      typeof gb === 'number' && gb > 0,
      `${tag} ships as a default but declares no download size in MODEL_DOWNLOAD_SIZES_GB`,
    );
  }
});
