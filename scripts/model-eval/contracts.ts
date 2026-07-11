/**
 * Per-task prompts + output schemas, adapted from the remedy PDF harness to the
 * Canvas HTML domain.
 *
 * Porting principle: keep the remedy prompt's SHAPE (section order, phrasing,
 * the numbered element list, the inlined "Return ONLY valid JSON" block) and
 * swap only the domain vocabulary — "PDF page" → "Canvas LMS page", "PDF tags"
 * → "the page DOM". The adapters were trained on that shape; drifting from it
 * would measure prompt-drift rather than domain transfer.
 *
 * This port is cheap precisely because remedy's tag vocabulary is already
 * HTML-shaped: heading corrections are H1-H6/P/Span, tables are judged on TH
 * header cells, images on Figure-with-alt. A DOM element list is isomorphic to
 * the PDF structure tree those adapters read.
 *
 * FAIRNESS: every arm gets the schema inlined AND a grammar-constrained
 * `format`, at temperature 0. The adapters learned the schema during training;
 * the generalist never saw it. Withholding it would measure format memorization
 * instead of accessibility judgment, which is the thing under test.
 *
 * Source contracts (verbatim prompts, schemas, scoring):
 * `.frugal-fable/eval-spec/remedy-eval-contracts.md`
 */
import type { TaskKey } from './types.ts';

/** One DOM element, 1-based, tag rendered PDF-structure-style (`/H1`) so the
 *  adapters see the token shape they were trained on. */
export interface PageElement {
  index: number;
  tag: string;
  text: string;
}

/** One image on the page, with its current alt text. */
export interface PageFigure {
  index: number;
  /** null = the alt attribute is absent entirely (distinct from alt=""). */
  alt: string | null;
  /** [left, top, right, bottom] in CSS px; null when not laid out. */
  bbox: [number, number, number, number] | null;
}

export interface PageStructure {
  elements: PageElement[];
  figures: PageFigure[];
}

/** Appended to the heading prompt at inference time — remedy injects this
 *  programmatically (model_io.py:20-25), it is NOT in their stored JSONL. A
 *  port that skips it is not running the adapter's real prompt. */
const HEADING_DEPTH_HINT =
  '\n\nHeading-depth rule: when a visible heading begins with a dotted section ' +
  'number, infer nesting depth from the number of components. For example, 3 is ' +
  'higher than 3.3, 3.3 is higher than 3.3.7, and 3.3.7.1 is deeper than all of ' +
  'them. Preserve that depth in correct_tag.';

const formatElements = (els: PageElement[]): string =>
  els.map((e) => `  ${String(e.index).padStart(2)}. ${e.tag}  (text: ${JSON.stringify(e.text)})`).join('\n');

const formatFigures = (figs: PageFigure[]): string =>
  figs
    .map((f) => {
      const bbox = f.bbox ? `[${f.bbox.join(', ')}]` : 'unknown';
      const alt = f.alt === null ? '<no alt attribute>' : JSON.stringify(f.alt);
      return `${f.index}. bbox=${bbox}; current_alt_text=${alt}`;
    })
    .join('\n');

function altPrompt(s: PageStructure): string {
  return `You are verifying image alt text quality for one Canvas LMS page under WCAG 1.1.1.

Current images, approximate page locations, and alt text:
${formatFigures(s.figures)}

Bboxes are [left, top, right, bottom] coordinates on the rendered page. Use them to match each listed image to the visible image, chart, icon, logo, or decorative mark. Evaluate every listed image. Do not pass alt text just because it exists.

Fail an image when the current alt text is missing, generic, placeholder-like (e.g. a filename), too vague, swapped with another image, visually inaccurate, hallucinated, misleading, redundant ("image of...", "picture of..."), or too verbose to be useful. For informative images, suggested_alt_text must be accurate, specific, concise, and under 180 characters. For purely decorative images such as borders, spacers, flourishes, or background texture, return status=fail, decorative=true, issue_type="decorative", and suggested_alt_text="" so the fixer can mark it as decorative — UNLESS it is already correctly marked decorative (alt="" with role="presentation"), which passes.

Return ONLY valid JSON:
{
  "figures": [
    {"figure_index": 1, "status": "pass", "severity": "info", "decorative": false, "issue_type": "", "message": "", "suggested_alt_text": "", "confidence": 0.93}
  ]
}
Allowed issue_type values: missing, generic, vague, swapped, inaccurate, hallucinated, verbose, decorative, other. Use status=fail and severity=error only when the visual evidence is clear.`;
}

function contrastPrompt(_s: PageStructure): string {
  // remedy's contrast prompt is static (no interpolation) — the purest vision
  // task, and the one most likely to transfer across domains.
  return `Analyze this Canvas LMS page image for color contrast issues under WCAG AA.

Examine text, image-of-text, form affordances, icons, lines, fills, and borders.
Thresholds: normal text 4.5:1, large text (>=24px, or >=19px bold) 3.0:1, non-text graphics 3.0:1.

Report only real contrast failures. If every foreground/background pair meets its threshold, return an empty issues array.

Return ONLY valid JSON:
{
  "issues": [
    {"severity": "error", "description": "Body text contrast ratio is 2.38:1, below WCAG AA 4.5:1.", "ratio": 2.38, "text_rgb": [168, 168, 168], "bg_rgb": [255, 255, 255], "fix_rgb": [0, 0, 0]}
  ]
}`;
}

function headingPrompt(s: PageStructure): string {
  return `You are a Canvas LMS accessibility expert verifying heading hierarchy.

Current DOM reading order. Element numbers are 1-based and must be used for corrections:
${formatElements(s.elements)}

Use the rendered page image, not just the existing tag sequence. A structurally valid H1/H2/H3 sequence can still be wrong when visual hierarchy disagrees with the tags.

Flag clear problems including:
- The page title or title-like prominent text is tagged as P/Span instead of H1/H2.
- A visible section/subsection heading has the wrong level for its visual prominence or nesting.
- Heading levels skip a level (e.g. H1 followed directly by H4), or are semantically out of order for the visual page structure.
- Body text, schedule rows, table rows, labels, or fine print are tagged as H1-H6.
- A subtitle/byline/field label is over-promoted as a heading.

Be conservative: only use severity=error when the rendered page and current tag make the correction clear. Use warning for ambiguous visual hierarchy.

Return ONLY valid JSON:
{
  "status": "pass" | "fail",
  "findings": [
    {"severity": "error", "element_index": 4, "current_tag": "H4", "visible_text": "Week 1", "message": "Heading level skips from H1 to H4", "correct_tag": "H2", "suggested_fix": "Retag as H2"}
  ]
}
When a specific element can be safely corrected, include element_index and correct_tag as one of H1, H2, H3, H4, H5, H6, P, or Span.${HEADING_DEPTH_HINT}`;
}

function tablePrompt(s: PageStructure): string {
  return `You are verifying a data table on a Canvas LMS page for WCAG 1.3.1.

Current table structure from the page DOM:
${formatElements(s.elements)}

Tasks:
1. Does the visual table have proper header cells (TH) for every column/row header?
2. Is the table structure regular (consistent row/column counts)?
3. Do header associations make sense for the data (scope, or headers/id)?

A data table whose first row is visually a header but is marked up with TD instead of TH is a failure.

Return ONLY valid JSON:
{
  "status": "pass",
  "confidence": 0.85,
  "findings": []
}
Each finding: {"issue_id": "...", "severity": "error|warning", "message": "...", "fixer": "fix_table_headers"}`;
}

export const PROMPTS: Record<TaskKey, (s: PageStructure) => string> = {
  alt: altPrompt,
  contrast: contrastPrompt,
  heading: headingPrompt,
  table: tablePrompt,
};

/** Ollama `format` schemas — grammar-constrain every arm identically, so the
 *  eval measures judgment, not JSON-emitting ability. Shapes mirror the gold
 *  schemas in the remedy spec (§1.3, §2.3, §3.3, §4.3). */
export const SCHEMAS: Record<TaskKey, Record<string, unknown>> = {
  alt: {
    type: 'object',
    properties: {
      figures: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            figure_index: { type: 'integer' },
            status: { type: 'string', enum: ['pass', 'fail'] },
            severity: { type: 'string', enum: ['info', 'warning', 'error'] },
            decorative: { type: 'boolean' },
            issue_type: { type: 'string' },
            message: { type: 'string' },
            suggested_alt_text: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['figure_index', 'status'],
        },
      },
    },
    required: ['figures'],
  },
  contrast: {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['error', 'warning'] },
            description: { type: 'string' },
            ratio: { type: 'number' },
            text_rgb: { type: 'array', items: { type: 'integer' } },
            bg_rgb: { type: 'array', items: { type: 'integer' } },
            fix_rgb: { type: 'array', items: { type: 'integer' } },
          },
          required: ['severity', 'description', 'ratio'],
        },
      },
    },
    required: ['issues'],
  },
  heading: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pass', 'fail'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['error', 'warning'] },
            element_index: { type: 'integer' },
            current_tag: { type: 'string' },
            visible_text: { type: 'string' },
            message: { type: 'string' },
            correct_tag: { type: 'string', enum: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'Span'] },
            suggested_fix: { type: 'string' },
          },
          required: ['severity', 'message'],
        },
      },
    },
    required: ['status', 'findings'],
  },
  table: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pass', 'fail'] },
      confidence: { type: 'number' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            issue_id: { type: 'string' },
            severity: { type: 'string', enum: ['error', 'warning'] },
            message: { type: 'string' },
            fixer: { type: 'string' },
          },
          required: ['issue_id', 'severity', 'message'],
        },
      },
    },
    required: ['status', 'findings'],
  },
};

/** Token budget per task. heading needs 1024 — remedy's serve default, because
 *  384 truncates mid-JSON on multi-finding pages and the truncation reads as an
 *  "invalid JSON" failure (spec §4.6). */
export const MAX_TOKENS: Record<TaskKey, number> = {
  alt: 768,
  contrast: 768,
  heading: 1024,
  table: 768,
};

/** The task-tuned remedy adapter serving each task (registered in Ollama from
 *  the GGUFs in remedy's packaging spike). */
export const ADAPTER_MODEL: Record<TaskKey, string> = {
  alt: 'remedy-alt-v1',
  contrast: 'remedy-contrast-v1',
  heading: 'remedy-heading-v1',
  table: 'remedy-table-v1',
};
