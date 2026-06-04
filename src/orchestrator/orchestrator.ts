/**
 * The turn handler: prompt assembly + a bounded tool-dispatch loop.
 *
 * Calls the local model with the registered tool definitions; if the model
 * requests tools, executes them server-side, appends the results, and loops
 * (bounded — never infinite, PRD §13.3). Returns the final text plus the full
 * transcript and a trace of every tool invocation.
 */
import type { ChatMessage, ChatOptions } from '../llm/index.js';
import type { ChatRunner, ToolContext, ToolInvocation, TurnInput, TurnResult } from './types.js';
import type { ToolRegistry } from './registry.js';

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export interface OrchestratorOptions {
  /** Max model round-trips per turn (bounded loop). */
  maxToolIterations?: number;
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
    if (input.system) messages.push({ role: 'system', content: input.system });
    if (input.history) messages.push(...input.history);
    messages.push({ role: 'user', content: input.user });

    const toolInvocations: ToolInvocation[] = [];
    const definitions = this.registry.definitions();

    for (let iterations = 1; iterations <= maxIterations; iterations++) {
      const chatOpts: ChatOptions = { messages };
      if (input.role) chatOpts.role = input.role;
      if (definitions.length > 0) chatOpts.tools = definitions;
      if (ctx.signal) chatOpts.signal = ctx.signal;

      const res = await this.runner.chat(chatOpts);

      if (!res.toolCalls || res.toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: res.content });
        return { text: res.content, iterations, toolInvocations, messages };
      }

      // Record the assistant's tool-call turn, then execute each call.
      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
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
