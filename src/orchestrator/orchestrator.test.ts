import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatOptions, ChatResult } from '../llm/index.js';
import { Orchestrator, OrchestratorError } from './orchestrator.js';
import { ToolRegistry } from './registry.js';
import type { ChatRunner, Tool } from './types.js';

/**
 * A scripted ChatRunner that returns queued responses and records each call.
 * Note: the orchestrator mutates `opts.messages` in place across iterations, so
 * we snapshot the message roles *at call time* rather than keep a live reference.
 */
class ScriptedRunner implements ChatRunner {
  calls: ChatOptions[] = [];
  callRoles: string[][] = [];
  toolsAdvertised: number[] = [];
  constructor(private readonly script: ChatResult[]) {}
  async chat(opts: ChatOptions): Promise<ChatResult> {
    this.calls.push(opts);
    this.callRoles.push(opts.messages.map((m) => m.role));
    this.toolsAdvertised.push(opts.tools?.length ?? 0);
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedRunner ran out of responses');
    return next;
  }
}

const echoTool = (name: string, fn: (args: Record<string, unknown>) => unknown): Tool => ({
  definition: { name, description: name, parameters: { type: 'object', properties: {} } },
  execute: async (args) => fn(args),
});

test('returns final text directly when the model makes no tool call', async () => {
  const runner = new ScriptedRunner([{ content: 'Hello!', model: 'm', raw: {} }]);
  const orch = new Orchestrator(runner, new ToolRegistry());
  const res = await orch.handleTurn({ system: 'sys', user: 'hi' });
  assert.equal(res.text, 'Hello!');
  assert.equal(res.iterations, 1);
  assert.equal(res.toolInvocations.length, 0);
  // system + user + assistant
  assert.deepEqual(res.messages.map((m) => m.role), ['system', 'user', 'assistant']);
  // tools advertised? registry empty → none
  assert.equal(runner.calls[0]?.tools, undefined);
});

test('executes a requested tool, feeds the result back, then finalizes', async () => {
  const runner = new ScriptedRunner([
    { content: '', model: 'm', raw: {}, toolCalls: [{ name: 'audit_html', arguments: { html: '<img>' } }] },
    { content: 'Found 1 issue.', model: 'm', raw: {} },
  ]);
  const registry = new ToolRegistry().register(
    echoTool('audit_html', (a) => ({ issues: [{ id: 'img-alt-missing', html: a['html'] }] })),
  );
  const orch = new Orchestrator(runner, registry);

  const res = await orch.handleTurn({ user: 'check this' });
  assert.equal(res.text, 'Found 1 issue.');
  assert.equal(res.iterations, 2);
  assert.equal(res.toolInvocations.length, 1);
  assert.equal(res.toolInvocations[0]?.call.name, 'audit_html');

  // The second model call saw the tool result as a `tool` message (snapshot at call time).
  assert.deepEqual(runner.callRoles[1], ['user', 'assistant', 'tool']);
  // Tools were advertised on each call.
  assert.equal(runner.toolsAdvertised[0], 1);
});

test('an unknown tool surfaces an error to the model rather than throwing', async () => {
  const runner = new ScriptedRunner([
    { content: '', model: 'm', raw: {}, toolCalls: [{ name: 'nope', arguments: {} }] },
    { content: 'recovered', model: 'm', raw: {} },
  ]);
  const orch = new Orchestrator(runner, new ToolRegistry());
  const res = await orch.handleTurn({ user: 'x' });
  assert.equal(res.toolInvocations[0]?.error, 'Unknown tool: nope');
  assert.equal(res.text, 'recovered');
});

test('a throwing tool is caught and reported, not fatal', async () => {
  const runner = new ScriptedRunner([
    { content: '', model: 'm', raw: {}, toolCalls: [{ name: 'boom', arguments: {} }] },
    { content: 'ok', model: 'm', raw: {} },
  ]);
  const registry = new ToolRegistry().register(
    echoTool('boom', () => {
      throw new Error('kaboom');
    }),
  );
  const res = await new Orchestrator(runner, registry).handleTurn({ user: 'x' });
  assert.equal(res.toolInvocations[0]?.error, 'kaboom');
});

test('the tool loop is bounded (never infinite)', async () => {
  // Always returns a tool call → must hit the iteration cap.
  const always: ChatResult = { content: '', model: 'm', raw: {}, toolCalls: [{ name: 't', arguments: {} }] };
  const runner = new ScriptedRunner([always, always, always]);
  const registry = new ToolRegistry().register(echoTool('t', () => ({ ok: true })));
  const orch = new Orchestrator(runner, registry, { maxToolIterations: 2 });
  await assert.rejects(() => orch.handleTurn({ user: 'x' }), OrchestratorError);
});
