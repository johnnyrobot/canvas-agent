/**
 * The turn handler: prompt assembly + a bounded tool-dispatch loop.
 *
 * Calls the local model with the registered tool definitions; if the model
 * requests tools, executes them server-side, appends the results, and loops
 * (bounded — never infinite, PRD §13.3). Returns the final text plus the full
 * transcript and a trace of every tool invocation.
 */
import type { ChatMessage, ChatOptions, ChatResult, ToolCall } from '../llm/index.js';
import type { KbRetriever } from '../contracts/index.js';
import type { ChatRunner, OrchestratorEvent, ToolContext, ToolInvocation, TurnInput, TurnResult } from './types.js';
import type { ToolRegistry } from './registry.js';
import { groundSystemPrompt } from './prompt.js';
import { packsForMode, toolsForMode } from './modes.js';

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export interface OrchestratorOptions {
  /** Max model round-trips per turn (bounded loop). */
  maxToolIterations?: number;
  /**
   * Optional Knowledge-Pack retriever. When present, `handleTurn` retrieves on
   * the user message and prepends the top citations to the system prompt
   * (PRD §13.1). Omitted → the system prompt is passed through unchanged.
   */
  retrieveKb?: KbRetriever;
  /** Max citations grounded into the system prompt (see `groundSystemPrompt`). */
  maxCitations?: number;
}

export class Orchestrator {
  constructor(
    private readonly runner: ChatRunner,
    private readonly registry: ToolRegistry,
    private readonly options: OrchestratorOptions = {},
  ) {}

  async handleTurn(input: TurnInput, ctx: ToolContext = {}): Promise<TurnResult> {
    const maxIterations = this.options.maxToolIterations ?? 5;
    const messages: ChatMessage[] = [];

    // Knowledge-Pack grounding: prepend the top citations to the hard rules.
    // When a mode is set, retrieval is scoped to that mode's packs.
    let system = input.system;
    if (this.options.retrieveKb) {
      const kb = input.mode
        ? await this.options.retrieveKb(input.user, packsForMode(input.mode))
        : await this.options.retrieveKb(input.user);
      const gopts =
        this.options.maxCitations !== undefined ? { maxCitations: this.options.maxCitations } : {};
      system = groundSystemPrompt(system, kb, gopts);
    }
    if (system) messages.push({ role: 'system', content: system });
    if (input.history) messages.push(...input.history);
    messages.push({ role: 'user', content: input.user });

    const toolInvocations: ToolInvocation[] = [];
    // When a mode is set, advertise only that mode's tools; the registry itself
    // stays mode-agnostic (filtering lives here, never in the registry).
    const allDefinitions = this.registry.definitions();
    const definitions = input.mode ? toolsForMode(input.mode, allDefinitions) : allDefinitions;

    // Stream only when the caller wants events AND the runner can stream;
    // otherwise the non-streaming path behaves exactly as before.
    const streaming = !!(ctx.onEvent && this.runner.chatStream);

    for (let iterations = 1; iterations <= maxIterations; iterations++) {
      const chatOpts: ChatOptions = { messages };
      if (input.role) chatOpts.role = input.role;
      if (definitions.length > 0) chatOpts.tools = definitions;
      if (ctx.signal) chatOpts.signal = ctx.signal;

      const res = streaming ? await this.streamChat(chatOpts, ctx.onEvent!) : await this.runner.chat(chatOpts);

      if (!res.toolCalls || res.toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: res.content });
        // Non-streaming callers still get the final text as one terminal event.
        if (ctx.onEvent && !streaming && res.content) ctx.onEvent({ type: 'text', delta: res.content });
        const result: TurnResult = { text: res.content, iterations, toolInvocations, messages };
        // C11: carry the terminal response's done_reason so turn assembly can flag a
        // truncated ('length') final answer as incomplete.
        if (res.doneReason !== undefined && res.doneReason !== '') result.doneReason = res.doneReason;
        return result;
      }

      // Record the assistant's tool-call turn, then execute each call.
      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        ctx.onEvent?.({ type: 'tool', name: call.name });
        const invocation = await this.runTool(call.name, call.arguments, ctx);
        toolInvocations.push(invocation);
        messages.push({
          role: 'tool',
          toolName: call.name,
          content: JSON.stringify(invocation.error ? { error: invocation.error } : (invocation.result ?? null)),
        });
      }
    }

    throw new OrchestratorError(`Tool loop exceeded ${maxIterations} iterations without a final answer.`);
  }

  /**
   * Consume `chatStream` for one model call: accumulate the full text (emitting a
   * `{ type: 'text', delta }` event per chunk) AND any tool calls the model
   * surfaces mid-stream. Returns a `ChatResult`-shaped value so the tool-dispatch
   * loop runs identically whether the turn streamed or not — a tool-driven turn
   * under streaming executes its tools instead of returning an empty answer.
   */
  private async streamChat(
    opts: ChatOptions,
    onEvent: (e: OrchestratorEvent) => void,
  ): Promise<ChatResult> {
    let content = '';
    let doneReason: string | undefined;
    const toolCalls: ToolCall[] = [];
    for await (const chunk of this.runner.chatStream!(opts)) {
      if (chunk.delta) {
        content += chunk.delta;
        onEvent({ type: 'text', delta: chunk.delta });
      }
      if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls);
      // C11: the terminal chunk carries done_reason ('length' = truncated). Carry it
      // through instead of dropping it, so a streamed truncated draft is detectable.
      if (chunk.doneReason !== undefined && chunk.doneReason !== '') doneReason = chunk.doneReason;
    }
    const result: ChatResult = { content, model: '', raw: undefined };
    if (toolCalls.length > 0) result.toolCalls = toolCalls;
    if (doneReason !== undefined) result.doneReason = doneReason;
    return result;
  }

  private async runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolInvocation> {
    const call = { name, arguments: args };
    const tool = this.registry.get(name);
    if (!tool) return { call, error: `Unknown tool: ${name}` };
    try {
      return { call, result: await tool.execute(args, ctx) };
    } catch (err) {
      return { call, error: (err as Error).message };
    }
  }
}
