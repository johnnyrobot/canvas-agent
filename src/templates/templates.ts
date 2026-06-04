/**
 * The eight canonical Canvas template renderers (PRD §15.3).
 *
 * Each renderer turns loosely-typed `TemplateSlots` into a semantic, accessible
 * HTML fragment plus a list of non-fatal `warnings`. The contract:
 *  - one top heading per fragment (`<h2>` — `<h1>` is rewritten by the gate, so
 *    `<h2>` is the real top level), with `<h3>`/`<h4>` nesting below it;
 *  - missing OPTIONAL slot → omit that section + push a warning (never throw);
 *  - missing REQUIRED title → warn + use a placeholder heading;
 *  - all dynamic content escaped; all markup on the Canvas allowlist.
 *
 * Slot shapes are inferred from the brief and documented in README.md.
 */
import type { TemplateSlots, TemplateType, ThemeResult } from '../contracts/index.js';
import { el, styleValue, txt } from './html.js';
import { calloutStyle, headingBandStyle } from './theme.js';

/** A rendered fragment body (the outer `<section>` is added by the dispatcher). */
export interface Built {
  html: string;
  warnings: string[];
}

/** A single renderer: slots (+ optional resolved theme) → built fragment. */
export type Renderer = (slots: TemplateSlots, theme?: ThemeResult) => Built;

// ── Slot coercion ────────────────────────────────────────────────────────────

/** A non-empty string, or a finite number stringified; otherwise `undefined`. */
function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Coerce a slot into a list of non-empty strings (non-arrays → empty list). */
function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = str(item);
    if (s !== undefined) out.push(s);
  }
  return out;
}

/** Coerce a slot into a list of plain objects (non-objects/arrays dropped). */
function recList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x),
  );
}

// ── Shared markup helpers ────────────────────────────────────────────────────

const DEFAULT_TITLES: Record<TemplateType, string> = {
  syllabus: 'Untitled Syllabus',
  'module-overview': 'Untitled Module',
  assignment: 'Untitled Assignment',
  discussion: 'Discussion',
  'page-content': 'Untitled Page',
  'lecture-notes': 'Untitled Lecture Notes',
  'study-guide': 'Untitled Study Guide',
  rubric: 'Untitled Rubric',
};

/** Resolve the (required) title, warning + falling back to a placeholder. */
function resolveTitle(slots: TemplateSlots, warnings: string[], type: TemplateType): string {
  const title = str(slots.title);
  if (title !== undefined) return title;
  warnings.push('no "title" slot provided; used a placeholder heading');
  return DEFAULT_TITLES[type];
}

/** The themed top heading (`<h2>`); unstyled when no theme/role matches. */
function topHeading(text: string, theme?: ThemeResult): string {
  return el('h2', { style: styleValue(headingBandStyle(theme)) }, txt(text));
}

function subHeading(text: string): string {
  return el('h3', {}, txt(text));
}

function paragraph(text: string): string {
  return el('p', {}, txt(text));
}

/** A bold-labelled line: `<p><strong>Label: </strong>value</p>`. */
function labeled(label: string, value: string): string {
  return el('p', {}, el('strong', {}, txt(`${label}: `)) + txt(value));
}

function bullets(items: readonly string[], ordered = false): string {
  return el(
    ordered ? 'ol' : 'ul',
    {},
    items.map((item) => el('li', {}, txt(item))),
  );
}

/** A themed callout box (accent pair) wrapping pre-built inner HTML. */
function callout(inner: string, theme?: ThemeResult): string {
  return el('div', { class: 'cdaa-callout', style: styleValue(calloutStyle(theme)) }, inner);
}

// ── The eight renderers ──────────────────────────────────────────────────────

export const renderSyllabus: Renderer = (slots, theme) => {
  const warnings: string[] = [];
  const parts: string[] = [topHeading(resolveTitle(slots, warnings, 'syllabus'), theme)];

  const instructor = str(slots.instructor);
  if (instructor !== undefined) parts.push(labeled('Instructor', instructor));
  else warnings.push('no "instructor" slot provided; omitted the instructor line');

  const description = str(slots.description);
  if (description !== undefined) parts.push(paragraph(description));
  else warnings.push('no "description" slot provided; omitted the course description');

  const schedule = strList(slots.schedule);
  if (schedule.length > 0) parts.push(subHeading('Course Schedule'), bullets(schedule));
  else warnings.push('no "schedule" slot provided; omitted the schedule');

  const policies = strList(slots.policies);
  if (policies.length > 0) parts.push(subHeading('Policies'), bullets(policies));
  else warnings.push('no "policies" slot provided; omitted the policies');

  return { html: parts.join(''), warnings };
};

export const renderModuleOverview: Renderer = (slots, theme) => {
  const warnings: string[] = [];
  const parts: string[] = [topHeading(resolveTitle(slots, warnings, 'module-overview'), theme)];

  const objectives = strList(slots.objectives);
  if (objectives.length > 0) parts.push(subHeading('Learning Objectives'), bullets(objectives));
  else warnings.push('no "objectives" slot provided; omitted the learning objectives');

  const items = strList(slots.items);
  if (items.length > 0) parts.push(subHeading('In This Module'), bullets(items));
  else warnings.push('no "items" slot provided; omitted the module checklist');

  return { html: parts.join(''), warnings };
};

export const renderAssignment: Renderer = (slots, theme) => {
  const warnings: string[] = [];
  const parts: string[] = [topHeading(resolveTitle(slots, warnings, 'assignment'), theme)];

  const overview = str(slots.overview);
  if (overview !== undefined) parts.push(paragraph(overview));
  else warnings.push('no "overview" slot provided; omitted the overview');

  const meta: string[] = [];
  const dueDate = str(slots.dueDate);
  if (dueDate !== undefined) meta.push(labeled('Due', dueDate));
  else warnings.push('no "dueDate" slot provided; omitted the due date');

  const points = str(slots.points);
  if (points !== undefined) meta.push(labeled('Points', points));
  else warnings.push('no "points" slot provided; omitted the point value');

  if (meta.length > 0) parts.push(callout(meta.join(''), theme));

  const instructions = strList(slots.instructions);
  if (instructions.length > 0) parts.push(subHeading('Instructions'), bullets(instructions, true));
  else warnings.push('no "instructions" slot provided; omitted the instructions');

  // rubricRef is explicitly optional (no warning when absent).
  const rubricRef = str(slots.rubricRef);
  if (rubricRef !== undefined) parts.push(labeled('Grading rubric', rubricRef));

  return { html: parts.join(''), warnings };
};

export const renderDiscussion: Renderer = (slots, theme) => {
  const warnings: string[] = [];
  const parts: string[] = [topHeading(resolveTitle(slots, warnings, 'discussion'), theme)];

  const prompt = str(slots.prompt);
  if (prompt !== undefined) {
    parts.push(el('blockquote', {}, paragraph(prompt)));
  } else {
    warnings.push('no "prompt" slot provided; used a placeholder prompt');
    parts.push(el('blockquote', {}, paragraph('(Discussion prompt to be provided.)')));
  }

  const guidelines = strList(slots.guidelines);
  if (guidelines.length > 0) parts.push(subHeading('Guidelines'), bullets(guidelines));
  else warnings.push('no "guidelines" slot provided; omitted the guidelines');

  const expectations = str(slots.expectations);
  if (expectations !== undefined) {
    parts.push(subHeading('Expectations'), callout(paragraph(expectations), theme));
  } else {
    warnings.push('no "expectations" slot provided; omitted the expectations');
  }

  return { html: parts.join(''), warnings };
};

export const renderPageContent: Renderer = (slots, theme) => {
  const warnings: string[] = [];
  const parts: string[] = [topHeading(resolveTitle(slots, warnings, 'page-content'), theme)];

  const sections = recList(slots.sections);
  if (sections.length > 0) {
    for (const section of sections) {
      const heading = str(section.heading);
      const body = str(section.body);
      if (heading !== undefined) parts.push(subHeading(heading));
      if (body !== undefined) parts.push(paragraph(body));
      if (heading === undefined && body === undefined) {
        warnings.push('a "sections" entry had no heading or body; skipped it');
      }
    }
  } else {
    warnings.push('no "sections" slot provided; omitted the page sections');
  }

  return { html: parts.join(''), warnings };
};

export const renderLectureNotes: Renderer = (slots, theme) => {
  const warnings: string[] = [];
  const parts: string[] = [topHeading(resolveTitle(slots, warnings, 'lecture-notes'), theme)];

  const topics = recList(slots.topics);
  if (topics.length > 0) {
    for (const topic of topics) {
      const heading = str(topic.heading);
      const points = strList(topic.points);
      if (heading !== undefined) parts.push(subHeading(heading));
      if (points.length > 0) parts.push(bullets(points));
      if (heading === undefined && points.length === 0) {
        warnings.push('a "topics" entry had no heading or points; skipped it');
      }
    }
  } else {
    warnings.push('no "topics" slot provided; omitted the lecture topics');
  }

  return { html: parts.join(''), warnings };
};

export const renderStudyGuide: Renderer = (slots, theme) => {
  const warnings: string[] = [];
  const parts: string[] = [topHeading(resolveTitle(slots, warnings, 'study-guide'), theme)];

  const keyTerms = recList(slots.keyTerms);
  if (keyTerms.length > 0) {
    parts.push(subHeading('Key Terms'));
    const items = keyTerms
      .map((entry) => {
        const term = str(entry.term);
        const definition = str(entry.definition);
        if (term === undefined && definition === undefined) return '';
        return el('dt', {}, txt(term ?? '(term)')) + el('dd', {}, txt(definition ?? ''));
      })
      .join('');
    parts.push(el('dl', {}, items));
  } else {
    warnings.push('no "keyTerms" slot provided; omitted the key terms');
  }

  const questions = strList(slots.questions);
  if (questions.length > 0) parts.push(subHeading('Review Questions'), bullets(questions, true));
  else warnings.push('no "questions" slot provided; omitted the review questions');

  return { html: parts.join(''), warnings };
};

interface RubricLevel {
  label: string;
  points: string | undefined;
  descriptor: string;
}

export const renderRubric: Renderer = (slots, theme) => {
  const warnings: string[] = [];
  const parts: string[] = [topHeading(resolveTitle(slots, warnings, 'rubric'), theme)];

  const criteria = recList(slots.criteria);
  if (criteria.length === 0) {
    warnings.push('no "criteria" slot provided; omitted the rubric table');
    parts.push(paragraph('No rubric criteria were provided.'));
    return { html: parts.join(''), warnings };
  }

  // Column labels = union of level labels, in order of first appearance.
  const columns: string[] = [];
  const rows = criteria.map((criterion) => {
    const name = str(criterion.name) ?? '(unnamed criterion)';
    const levels: RubricLevel[] = recList(criterion.levels).map((level) => ({
      label: str(level.label) ?? '',
      points: str(level.points),
      descriptor: str(level.descriptor) ?? '',
    }));
    for (const level of levels) {
      if (level.label !== '' && !columns.includes(level.label)) columns.push(level.label);
    }
    return { name, levels };
  });

  // Degenerate case: criteria without labelled levels → a single "Details" column.
  if (columns.length === 0) {
    columns.push('Details');
    for (const row of rows) {
      const descriptor = row.levels.map((l) => l.descriptor).filter((d) => d !== '').join('; ');
      row.levels = [{ label: 'Details', points: undefined, descriptor }];
    }
  }

  const headerCells =
    el('th', { scope: 'col' }, txt('Criteria')) +
    columns.map((col) => el('th', { scope: 'col' }, txt(col))).join('');
  const thead = el('thead', {}, el('tr', {}, headerCells));

  const bodyRows = rows
    .map((row) => {
      const cells = columns
        .map((col) => {
          const level = row.levels.find((l) => l.label === col);
          if (!level) return el('td', {}, '');
          const pts = level.points !== undefined ? ` (${level.points} pts)` : '';
          return el('td', {}, txt(level.descriptor + pts));
        })
        .join('');
      return el('tr', {}, el('th', { scope: 'row' }, txt(row.name)) + cells);
    })
    .join('');
  const tbody = el('tbody', {}, bodyRows);

  parts.push(el('table', {}, el('caption', {}, txt('Grading rubric')) + thead + tbody));
  return { html: parts.join(''), warnings };
};
