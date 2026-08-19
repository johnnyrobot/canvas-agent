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
import { TEMPLATE_SLOTS, TEMPLATE_SLOT_SHAPES, TEMPLATE_TYPES } from '../contracts/index.js';
import type { Tool, ToolContext } from './types.js';
import { KB_PACKS_BY_MODE } from './modes.js';

/**
 * Every pack id retrieval can legitimately be scoped to. Derived from the
 * per-mode table rather than restated: an id that exists only here would be
 * advertised to the model and then return nothing.
 */
const KNOWN_PACK_IDS = [...new Set(Object.values(KB_PACKS_BY_MODE).flat())];

/**
 * `render_template`'s slot contract, rendered for the model.
 *
 * `slots` is a free-form object — it has to be, the shapes differ per template —
 * so the description is the only place the model can learn which names are read.
 * Without it granite invented `dates_or_rhythm` / `learner_tasks` /
 * `official_course_outcomes` for `module-overview` (which reads `title`,
 * `objectives`, `items`), every value was dropped, and the fragment came back as
 * a bare heading. Built from `TEMPLATE_SLOTS`, which is itself held to what the
 * renderers actually read.
 */
const SLOT_GUIDE = TEMPLATE_TYPES.map(
  (t) => `${t}: ${TEMPLATE_SLOTS[t].map((s) => `${s}${TEMPLATE_SLOT_SHAPES[s] ?? ''}`).join(', ')}`,
).join('; ');

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
        description:
          'Fill one of the eight Canvas templates with slot content + resolved theme. ' +
          `Each template reads only its own slots — ${SLOT_GUIDE}. ` +
          'Slots you invent are ignored, so use these names exactly.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...TEMPLATE_TYPES] },
            slots: { type: 'object' },
            theme: { type: 'object' },
          },
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
        description:
          'Lexical/structured knowledge retrieval (no embeddings in v1) for grounding + citation. ' +
          `Omit "packs" to search everything; an unknown pack matches nothing. Known packs: ${KNOWN_PACK_IDS.join(', ')}.`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            packs: { type: 'array', items: { type: 'string', enum: KNOWN_PACK_IDS } },
          },
          required: ['query'],
        },
      },
      'retrieveKb',
      (d, a) => d.retrieveKb!(str(a['query']), a['packs'] as string[] | undefined),
    ),
  ];
  return factories.map((f) => f(deps));
}
