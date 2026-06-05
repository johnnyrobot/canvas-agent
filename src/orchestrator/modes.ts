/**
 * Per-mode configuration for the three product modes (Guidance / Build /
 * Remediate): the system prompt, the canonical tools the model may see, and the
 * Knowledge Packs retrieval is scoped to.
 *
 * The mode prompts share one hard-rule preamble (the spirit of the runtime's
 * `DEFAULT_SYSTEM_PROMPT`): only Canvas-allowlist-safe HTML, aim for WCAG 2.2 AA,
 * **never self-certify — the server-side gate decides**, use tools instead of
 * guessing, never fetch remote resources, and ground claims in the retrieved
 * Knowledge-Pack sources and cite them. Each mode then adds its own specialty.
 *
 * Pure data + pure helpers; no I/O. The runtime (T4) owns *choosing* the prompt
 * per turn — this module only supplies the catalog.
 */
import type { ProductMode } from '../contracts/index.js';
import type { ToolDefinition } from '../llm/index.js';

/** The hard rules every mode inherits verbatim (PRD §15). */
const HARD_RULES = [
  'You are the Canvas Course Design & Accessibility Assistant, running fully on-device.',
  'Hard rules (never violate):',
  '- Produce only Canvas-allowlist-safe HTML and aim for WCAG 2.2 AA; the server-side',
  '  output gate re-checks every fragment, so never claim something "passes" yourself.',
  '- Use the provided tools instead of guessing.',
  '- Never fetch remote resources; only describe user-supplied images.',
  '- Ground claims in the retrieved Knowledge-Pack sources and cite them.',
].join('\n');

const GUIDANCE_SPECIALTY = [
  'Mode: GUIDANCE. Explain and answer the user\'s question directly and concisely,',
  'citing the Knowledge-Pack sources you rely on. Prefer prose; include HTML only when',
  'a small illustrative snippet genuinely helps the explanation, and keep any HTML minimal.',
].join('\n');

const BUILD_SPECIALTY = [
  'Mode: BUILD. Produce templated, Canvas-safe HTML for the requested artifact',
  '(page, module, syllabus, quiz, rubric, assignment, etc.). Prefer render_template and',
  'resolve_theme to assemble the fragment, then verify it with audit_html and',
  'validate_allowlist before presenting it.',
].join('\n');

const REMEDIATE_SPECIALTY = [
  'Mode: REMEDIATE. Repair the HTML the user supplied: correct accessibility issues',
  '(contrast, missing alt text, heading structure, tables, links) and any Canvas',
  'allowlist violations, then return the corrected HTML. Preserve the author\'s content',
  'and intent — change only what is needed to make it conformant.',
].join('\n');

function compose(specialty: string): string {
  return `${HARD_RULES}\n\n${specialty}`;
}

/** The full system prompt advertised for each mode. */
export const SYSTEM_PROMPT_BY_MODE: Record<ProductMode, string> = {
  guidance: compose(GUIDANCE_SPECIALTY),
  build: compose(BUILD_SPECIALTY),
  remediate: compose(REMEDIATE_SPECIALTY),
};

/** Allowed canonical tool NAMES per mode (filtered against the registry). */
export const TOOLS_BY_MODE: Record<ProductMode, readonly string[]> = {
  guidance: ['retrieve_kb', 'check_contrast', 'audit_html', 'describe_image'],
  build: [
    'audit_html',
    'validate_allowlist',
    'check_contrast',
    'resolve_theme',
    'render_template',
    'ingest_document',
    'describe_image',
    'retrieve_kb',
  ],
  remediate: ['audit_html', 'validate_allowlist', 'check_contrast', 'resolve_theme', 'retrieve_kb', 'describe_image'],
};

/** Knowledge-Pack ids retrieval is scoped to per mode. */
export const KB_PACKS_BY_MODE: Record<ProductMode, readonly string[]> = {
  guidance: ['wcag-basics', 'rubric-criteria'],
  build: ['canvas-templates', 'wcag-basics'],
  remediate: ['wcag-basics'],
};

/** The system prompt for `mode`. */
export function systemPromptForMode(mode: ProductMode): string {
  return SYSTEM_PROMPT_BY_MODE[mode];
}

/** Filter `all` tool definitions down to the ones `mode` allows (by name). */
export function toolsForMode(mode: ProductMode, all: ToolDefinition[]): ToolDefinition[] {
  const allowed = new Set(TOOLS_BY_MODE[mode]);
  return all.filter((t) => allowed.has(t.name));
}

/** The Knowledge-Pack ids `mode` retrieves from (a fresh mutable copy). */
export function packsForMode(mode: ProductMode): string[] {
  return [...KB_PACKS_BY_MODE[mode]];
}
