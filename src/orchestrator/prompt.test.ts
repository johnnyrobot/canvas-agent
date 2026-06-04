import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatOptions, ChatResult } from '../llm/index.js';
import type { KbResult, KbRetriever } from '../contracts/index.js';
import { groundSystemPrompt } from './prompt.js';
import { Orchestrator } from './orchestrator.js';
import { ToolRegistry } from './registry.js';
import type { ChatRunner } from './types.js';

const kb = (...snippets: Array<[string, string]>): KbResult => ({
  hits: snippets.map(([citation, snippet], i) => ({
    id: `p:${i}`,
    packId: 'p',
    title: 't',
    snippet,
    score: 1 - i * 0.1,
    citation,
  })),
});

// ── groundSystemPrompt (pure) ────────────────────────────────────────────────

test('grounding prepends the top citations ABOVE the existing hard rules', () => {
  const out = groundSystemPrompt('HARD RULES', kb(['WCAG §1.1', 'Add alt text.']));
  // citations first, then the untouched base prompt
  assert.ok(out.indexOf('WCAG §1.1') < out.indexOf('HARD RULES'), 'citations come first');
  assert.ok(out.includes('Add alt text.'));
  assert.ok(out.endsWith('HARD RULES'));
});

test('grounding caps the number of citations (default 3)', () => {
  const out = groundSystemPrompt('rules', kb(
    ['C1', 's1'], ['C2', 's2'], ['C3', 's3'], ['C4', 's4'], ['C5', 's5'],
  ));
  assert.ok(out.includes('C1') && out.includes('C2') && out.includes('C3'));
  assert.ok(!out.includes('C4'), 'fourth citation is dropped by the cap');
});

test('grounding respects an explicit maxCitations', () => {
  const out = groundSystemPrompt('rules', kb(['C1', 's1'], ['C2', 's2']), { maxCitations: 1 });
  assert.ok(out.includes('C1'));
  assert.ok(!out.includes('C2'));
});

test('no hits → the base prompt is returned unchanged', () => {
  assert.equal(groundSystemPrompt('rules', kb()), 'rules');
});

test('no base + no hits → empty string', () => {
  assert.equal(groundSystemPrompt(undefined, kb()), '');
});

test('citations with no base prompt are still emitted', () => {
  const out = groundSystemPrompt(undefined, kb(['C1', 's1']));
  assert.ok(out.includes('C1') && out.includes('s1'));
});

// ── Orchestrator integration ─────────────────────────────────────────────────

class CapturingRunner implements ChatRunner {
  lastSystem: string | undefined;
  constructor(private readonly reply: ChatResult) {}
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const sys = opts.messages.find((m) => m.role === 'system');
    this.lastSystem = typeof sys?.content === 'string' ? sys.content : undefined;
    return this.reply;
  }
}

test('handleTurn grounds the system prompt with retrieved citations', async () => {
  const runner = new CapturingRunner({ content: 'ok', model: 'm', raw: {} });
  const retrieveKb: KbRetriever = async (query) => {
    assert.equal(query, 'how do I add alt text?'); // retrieval keyed on the user message
    return kb(['WCAG §1.1.1', 'Every image needs alt text.']);
  };
  const orch = new Orchestrator(runner, new ToolRegistry(), { retrieveKb });
  await orch.handleTurn({ system: 'BE ACCESSIBLE', user: 'how do I add alt text?' });

  assert.ok(runner.lastSystem?.includes('WCAG §1.1.1'), 'citation injected into the system prompt');
  assert.ok(runner.lastSystem?.includes('BE ACCESSIBLE'), 'hard rules preserved');
});

test('without a retriever, handleTurn leaves the system prompt untouched (passthrough)', async () => {
  const runner = new CapturingRunner({ content: 'ok', model: 'm', raw: {} });
  const orch = new Orchestrator(runner, new ToolRegistry());
  await orch.handleTurn({ system: 'ONLY THIS', user: 'hi' });
  assert.equal(runner.lastSystem, 'ONLY THIS');
});
