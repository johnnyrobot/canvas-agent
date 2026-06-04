/**
 * Canonical server-side tools (PRD §15.3), built via dependency injection so the
 * real implementations (the deterministic engine, the sidecars) plug in later.
 *
 * `describe_image` and `ingest_document` are wired to the LLM and Docling
 * sidecars when those deps are supplied; the engine tools default to a
 * NotImplemented stub until `/src/engine` exists. The model only ever *requests*
 * these; the unconditional gate (gate.ts) is what actually guarantees safety.
 */
import type { ToolDefinition } from '../llm/index.js';
import type { Tool, ToolContext } from './types.js';

export class NotImplementedError extends Error {
  constructor(tool: string) {
    super(`Tool "${tool}" is not implemented yet (engine TODO).`);
    this.name = 'NotImplementedError';
  }
}

/** Implementations the tools delegate to. All optional in the scaffold. */
export interface EngineDeps {
  auditHtml(html: string): Promise<unknown>;
  validateAllowlist(html: string): Promise<unknown>;
  checkContrast(fg: string, bg: string, size: string): Promise<unknown>;
  resolveTheme(color1: string, color2: string, roles: string[]): Promise<unknown>;
  renderTemplate(type: string, slots: Record<string, unknown>, theme: unknown): Promise<unknown>;
  ingestDocument(fileRef: string): Promise<unknown>;
  describeImage(args: { image: string; prompt: string }): Promise<unknown>;
  retrieveKb(query: string, packs?: string[]): Promise<unknown>;
}

type DepName = keyof EngineDeps;

function tool(definition: ToolDefinition, dep: DepName, run: (deps: Partial<EngineDeps>, args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>): (deps: Partial<EngineDeps>) => Tool {
  return (deps) => ({
    definition,
    execute: async (args, ctx) => {
      if (typeof deps[dep] !== 'function') throw new NotImplementedError(definition.name);
      return run(deps, args, ctx);
    },
  });
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

/** Build the canonical tool set with whatever deps are available. */
export function createCanonicalTools(deps: Partial<EngineDeps>): Tool[] {
  const factories: ((d: Partial<EngineDeps>) => Tool)[] = [
    tool(
      {
        name: 'audit_html',
        description: 'Run the deterministic accessibility engine on an HTML fragment; returns an IssueSet.',
        parameters: { type: 'object', properties: { html: { type: 'string' } }, required: ['html'] },
      },
      'auditHtml',
      (d, a) => d.auditHtml!(str(a['html'])),
    ),
    tool(
      {
        name: 'validate_allowlist',
        description: 'Validate/repair HTML against the Canvas allowlist; returns violations + repaired HTML.',
        parameters: { type: 'object', properties: { html: { type: 'string' } }, required: ['html'] },
      },
      'validateAllowlist',
      (d, a) => d.validateAllowlist!(str(a['html'])),
    ),
    tool(
      {
        name: 'check_contrast',
        description: 'Deterministic WCAG contrast ratio for a foreground/background pair.',
        parameters: {
          type: 'object',
          properties: { fg: { type: 'string' }, bg: { type: 'string' }, size: { type: 'string' } },
          required: ['fg', 'bg'],
        },
      },
      'checkContrast',
      (d, a) => d.checkContrast!(str(a['fg']), str(a['bg']), str(a['size'])),
    ),
    tool(
      {
        name: 'resolve_theme',
        description: 'ThemeResolver: accessible foregrounds for a brand palette + warnings/variants.',
        parameters: {
          type: 'object',
          properties: { color1: { type: 'string' }, color2: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } } },
          required: ['color1', 'color2'],
        },
      },
      'resolveTheme',
      (d, a) => d.resolveTheme!(str(a['color1']), str(a['color2']), (a['roles'] as string[]) ?? []),
    ),
    tool(
      {
        name: 'render_template',
        description: 'Fill one of the eight Canvas templates with slot content + resolved theme.',
        parameters: {
          type: 'object',
          properties: { type: { type: 'string' }, slots: { type: 'object' }, theme: { type: 'object' } },
          required: ['type', 'slots'],
        },
      },
      'renderTemplate',
      (d, a) => d.renderTemplate!(str(a['type']), (a['slots'] as Record<string, unknown>) ?? {}, a['theme']),
    ),
    tool(
      {
        name: 'ingest_document',
        description: 'Convert a user-supplied document (Docling) to structured content.',
        parameters: { type: 'object', properties: { fileRef: { type: 'string' } }, required: ['fileRef'] },
      },
      'ingestDocument',
      (d, a) => d.ingestDocument!(str(a['fileRef'])),
    ),
    tool(
      {
        name: 'describe_image',
        description: 'Draft alt text / a long description for a USER-SUPPLIED image (local vision). Never fetches.',
        parameters: {
          type: 'object',
          properties: { image: { type: 'string' }, prompt: { type: 'string' } },
          required: ['image', 'prompt'],
        },
      },
      'describeImage',
      (d, a) => d.describeImage!({ image: str(a['image']), prompt: str(a['prompt']) }),
    ),
    tool(
      {
        name: 'retrieve_kb',
        description: 'Lexical/structured knowledge retrieval (no embeddings in v1) for grounding + citation.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, packs: { type: 'array', items: { type: 'string' } } },
          required: ['query'],
        },
      },
      'retrieveKb',
      (d, a) => d.retrieveKb!(str(a['query']), a['packs'] as string[] | undefined),
    ),
  ];
  return factories.map((f) => f(deps));
}
