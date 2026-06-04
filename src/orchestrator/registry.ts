/** A registry of server-side tools the model can call. */
import type { ToolDefinition } from '../llm/index.js';
import type { Tool } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    const name = tool.definition.name;
    if (this.tools.has(name)) throw new Error(`Duplicate tool: ${name}`);
    this.tools.set(name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Definitions to advertise to the model. */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  get size(): number {
    return this.tools.size;
  }
}
