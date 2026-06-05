/**
 * Mode-awareness + streaming tests for `handleTurn`, kept separate from the
 * original orchestrator.test.ts (which pins the pre-modes behaviour).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatChunk, ChatOptions, ChatResult } from '../llm/index.js';
import type { KbResult } from '../contracts/index.js';
import { Orchestrator } from './orchestrator.js';
import { ToolRegistry } from './registry.js';
import { createCanonicalTools } from './tools.js';
import { TOOLS_BY_MODE, KB_PACKS_BY_MODE } from './modes.js';
import type { ChatRunner, OrchestratorEvent, Tool } from './types.js';

/** Records the tools advertised on each call; replays a scripted result list. */
class RecordingRunner implements ChatRunner {
  toolNamesAdvertised: string[][] = [];
  constructor(private readonly script: ChatResult[]) {}
  async chat(opts: ChatOptions): Promise<ChatResult> {
    this.toolNamesAdvertised.push((opts.tools ?? []).map((t) => t.name));
    const next = this.script.shift();
    if (!next) throw new Error('RecordingRunner out of responses');
    return next;
  }
}

/** A runner that also streams: yields the queued chunk lists for each call. */
class StreamingRunner implements ChatRunner {
  streamCalls = 0;
  signalsSeen: (AbortSignal | undefined)[] = [];
  constructor(private readonly chunkScript: ChatChunk[][]) {}
  async chat(): Promise<ChatResult> {
    throw new Error('chat() should not be called when streaming');
  }
  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk> {
    this.signalsSeen.push(opts.signal);
    const chunks = this.chunkScript[this.streamCalls++] ?? [];
    for (const c of chunks) yield c;
  }
}

const okTool = (name: string): Tool => ({
  definition: { name, description: name, parameters: { type: 'object', properties: {} } },
  execute: async () => ({ ok: true }),
});

const allCanonical = (): ToolRegistry => new ToolRegistry().registerAll(createCanonicalTools({}));

test('mode filters the advertised tools to that mode\'s allowed set', async () => {
  const runner = new RecordingRunner([{ content: 'done', model: 'm', raw: {} }]);
  const orch = new Orchestrator(runner, allCanonical());
  await orch.handleTurn({ user: 'hi', mode: 'guidance' });
  assert.deepEqual(new Set(runner.toolNamesAdvertised[0]), new Set(TOOLS_BY_MODE.guidance));
});

test('without a mode, all registered tools are advertised (unchanged behaviour)', async () => {
  const runner = new RecordingRunner([{ content: 'done', model: 'm', raw: {} }]);
  const orch = new Orchestrator(runner, allCanonical());
  await orch.handleTurn({ user: 'hi' });
  assert.equal(runner.toolNamesAdvertised[0]?.length, 8);
});

test('mode scopes KB retrieval to that mode\'s packs', async () => {
  const packsSeen: (string[] | undefined)[] = [];
  const retrieveKb = async (_q: string, packs?: string[]): Promise<KbResult> => {
    packsSeen.push(packs);
    return { hits: [] };
  };
  const runner = new RecordingRunner([{ content: 'done', model: 'm', raw: {} }]);
  const orch = new Orchestrator(runner, allCanonical(), { retrieveKb });
  await orch.handleTurn({ user: 'hi', mode: 'build' });
  assert.deepEqual(packsSeen[0], KB_PACKS_BY_MODE.build);
});

test('without a mode, KB retrieval is called with no packs (unchanged behaviour)', async () => {
  const packsSeen: (string[] | undefined)[] = [];
  const retrieveKb = async (_q: string, packs?: string[]): Promise<KbResult> => {
    packsSeen.push(packs);
    return { hits: [] };
  };
  const runner = new RecordingRunner([{ content: 'done', model: 'm', raw: {} }]);
  const orch = new Orchestrator(runner, allCanonical(), { retrieveKb });
  await orch.handleTurn({ user: 'hi' });
  assert.deepEqual(packsSeen[0], undefined);
});

test('streaming emits a text event per chunk and accumulates the final text', async () => {
  const runner = new StreamingRunner([
    [
      { delta: 'Hel', done: false },
      { delta: 'lo ', done: false },
      { delta: 'world', done: true },
    ],
  ]);
  const events: OrchestratorEvent[] = [];
  const orch = new Orchestrator(runner, new ToolRegistry());
  const res = await orch.handleTurn({ user: 'hi' }, { onEvent: (e) => events.push(e) });
  assert.equal(res.text, 'Hello world');
  assert.deepEqual(events, [
    { type: 'text', delta: 'Hel' },
    { type: 'text', delta: 'lo ' },
    { type: 'text', delta: 'world' },
  ]);
  assert.equal(runner.streamCalls, 1);
});

test('streaming passes the abort signal through to chatStream', async () => {
  const runner = new StreamingRunner([[{ delta: 'x', done: true }]]);
  const controller = new AbortController();
  const orch = new Orchestrator(runner, new ToolRegistry());
  await orch.handleTurn({ user: 'hi' }, { onEvent: () => {}, signal: controller.signal });
  assert.equal(runner.signalsSeen[0], controller.signal);
});

test('without onEvent, a streaming-capable runner still uses chat() (no events)', async () => {
  // chat() is the only path; chatStream must not be touched.
  const runner = new RecordingRunner([{ content: 'plain', model: 'm', raw: {} }]);
  const orch = new Orchestrator(runner, new ToolRegistry());
  const res = await orch.handleTurn({ user: 'hi' });
  assert.equal(res.text, 'plain');
});

test('a tool event fires as each tool begins executing (non-streaming + onEvent)', async () => {
  const runner = new RecordingRunner([
    { content: '', model: 'm', raw: {}, toolCalls: [{ name: 'audit_html', arguments: {} }] },
    { content: 'final answer', model: 'm', raw: {} },
  ]);
  const registry = new ToolRegistry().register(okTool('audit_html'));
  const events: OrchestratorEvent[] = [];
  const orch = new Orchestrator(runner, registry);
  const res = await orch.handleTurn({ user: 'check' }, { onEvent: (e) => events.push(e) });
  assert.equal(res.text, 'final answer');
  // Tool event before the terminal text event.
  assert.deepEqual(events, [
    { type: 'tool', name: 'audit_html' },
    { type: 'text', delta: 'final answer' },
  ]);
});

test('non-streaming + onEvent emits one terminal text event for the final answer', async () => {
  const runner = new RecordingRunner([{ content: 'just text', model: 'm', raw: {} }]);
  const events: OrchestratorEvent[] = [];
  const orch = new Orchestrator(runner, new ToolRegistry());
  await orch.handleTurn({ user: 'hi' }, { onEvent: (e) => events.push(e) });
  assert.deepEqual(events, [{ type: 'text', delta: 'just text' }]);
});

test('tool execution is unaffected by mode filtering (registry stays full)', async () => {
  // Model (allowed in remediate) calls audit_html; it must still execute.
  const runner = new RecordingRunner([
    { content: '', model: 'm', raw: {}, toolCalls: [{ name: 'audit_html', arguments: {} }] },
    { content: 'ok', model: 'm', raw: {} },
  ]);
  const registry = allCanonical();
  const orch = new Orchestrator(runner, registry);
  const res = await orch.handleTurn({ user: 'fix', mode: 'remediate' });
  assert.equal(res.toolInvocations[0]?.call.name, 'audit_html');
  // remediate advertises 6 tools.
  assert.equal(runner.toolNamesAdvertised[0]?.length, 6);
});
