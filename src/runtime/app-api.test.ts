import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, ChatOptions, ChatResult } from '../llm/index.js';
import type { Auditor, CanvasImportResult, KbResult } from '../contracts/index.js';
import { validateAllowlist } from '../engine/index.js';
import type { ChatRunner } from '../orchestrator/index.js';
import { createAppApi } from './app-api.js';

/** A scripted model: returns queued responses, records the system prompt it saw. */
class ScriptedRunner implements ChatRunner {
  systems: Array<string | undefined> = [];
  constructor(private readonly script: ChatResult[]) {}
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const sys = opts.messages.find((m: ChatMessage) => m.role === 'system');
    this.systems.push(typeof sys?.content === 'string' ? sys.content : undefined);
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedRunner exhausted');
    return next;
  }
}

const cleanAudit: Auditor = async () => ({ issues: [] });
const text = (content: string): ChatResult => ({ content, model: 'm', raw: {} });
const callTool = (name: string, args: Record<string, unknown>): ChatResult => ({
  content: '', model: 'm', raw: {}, toolCalls: [{ name, arguments: args }],
});

const fakeLlm = { describeImage: async () => text('alt'), isHealthy: async () => true };
const fakeIngest = { convertPath: async () => ({ status: 'success', processingTimeMs: 1 }), isHealthy: async () => true };
const emptyRetriever = async (): Promise<KbResult> => ({ hits: [] });

function api(runner: ChatRunner, over: Partial<Parameters<typeof createAppApi>[0]> = {}) {
  return createAppApi({
    chatRunner: runner,
    llm: fakeLlm,
    ingest: fakeIngest,
    retriever: emptyRetriever,
    audit: cleanAudit,
    ...over,
  });
}

test('runTurn returns a TurnView (text, toolsUsed, iterations)', async () => {
  const runner = new ScriptedRunner([
    callTool('render_template', { type: 'page-content', slots: { title: 'Welcome' } }),
    text('Here is your page.'),
  ]);
  const view = await api(runner).runTurn({ user: 'make a welcome page' });
  assert.equal(view.text, 'Here is your page.');
  assert.equal(view.iterations, 2);
  assert.deepEqual(view.toolsUsed, ['render_template']);
});

test('runTurn gates a render_template fragment: passes checks + allowlist-clean', async () => {
  const runner = new ScriptedRunner([
    callTool('render_template', { type: 'page-content', slots: { title: 'Welcome', sections: [{ heading: 'Intro', body: 'Hello' }] } }),
    text('done'),
  ]);
  const view = await api(runner).runTurn({ user: 'build it' });
  assert.equal(view.fragments.length, 1);
  const frag = view.fragments[0]!;
  assert.equal(frag.gate.conformance.passedChecks, true);
  assert.equal(frag.gate.badgeWithheld, false);
  // allowlist-clean = the gated HTML survives the allowlist unchanged, no semantic loss.
  const re = await validateAllowlist(frag.html);
  assert.deepEqual(re.removedSemantic, []);
  assert.equal(re.html, frag.html);
});

test('runTurn withholds the badge for a deliberately bad fenced fragment', async () => {
  // <figure>/<figcaption> are semantic but off the Canvas allowlist → removed → blocker.
  const bad = 'Sure:\n\n```html\n<figure><img src="https://x/y.png" alt="y"><figcaption>cap</figcaption></figure>\n```\n';
  const runner = new ScriptedRunner([text(bad)]);
  const view = await api(runner).runTurn({ user: 'give me html' });
  assert.equal(view.fragments.length, 1);
  const frag = view.fragments[0]!;
  assert.equal(frag.gate.badgeWithheld, true);
  assert.equal(frag.gate.conformance.passedChecks, false);
  assert.ok(frag.gate.conformance.blockers.some((b) => b.id === 'allowlist-removed-semantic'));
});

test('runTurn grounds the system prompt with retrieved Knowledge-Pack citations', async () => {
  const runner = new ScriptedRunner([text('answer')]);
  const retriever = async (): Promise<KbResult> => ({
    hits: [{ id: 'p:1', packId: 'p', title: 't', snippet: 'Use scope on header cells.', score: 1, citation: 'WCAG H51' }],
  });
  await api(runner, { retriever, systemPrompt: 'HARD RULES' }).runTurn({ user: 'accessible tables?' });
  const sys = runner.systems[0];
  assert.ok(sys?.includes('WCAG H51'), 'citation grounded into the system prompt');
  assert.ok(sys?.includes('HARD RULES'), 'base hard rules preserved');
});

test('runTurn lets the caller override the system prompt', async () => {
  const runner = new ScriptedRunner([text('answer')]);
  await api(runner).runTurn({ user: 'hi', system: 'CUSTOM PROMPT' });
  assert.equal(runner.systems[0], 'CUSTOM PROMPT');
});

test('toolsUsed is de-duplicated by name', async () => {
  const runner = new ScriptedRunner([
    callTool('audit_html', { html: '<p>a</p>' }),
    callTool('audit_html', { html: '<p>b</p>' }),
    text('done'),
  ]);
  const view = await api(runner).runTurn({ user: 'audit twice' });
  assert.deepEqual(view.toolsUsed, ['audit_html']);
});

test('health() reports per-sidecar reachability and never throws', async () => {
  const runner = new ScriptedRunner([]);
  const view = api(runner, {
    llm: { describeImage: async () => text('x'), isHealthy: async () => true },
    ingest: { convertPath: async () => ({ status: 'failure', processingTimeMs: 0 }), isHealthy: async () => { throw new Error('down'); } },
  });
  const health = await view.health();
  assert.deepEqual(health, { llm: true, ingest: false });
});

test('importCanvas delegates to the injected importer', async () => {
  const runner = new ScriptedRunner([]);
  const expected: CanvasImportResult = {
    courseId: '42', name: 'Bio 101', importedAt: '2026-01-01T00:00:00Z',
    pages: 3, assignments: 2, files: 1, warnings: [],
  };
  let seen: { baseUrl: string; courseId: string } | undefined;
  const view = api(runner, {
    importer: async (config, courseId) => { seen = { baseUrl: config.baseUrl, courseId }; return expected; },
  });
  const res = await view.importCanvas({ baseUrl: 'https://canvas.test', token: 't' }, '42');
  assert.deepEqual(res, expected);
  assert.deepEqual(seen, { baseUrl: 'https://canvas.test', courseId: '42' });
});
