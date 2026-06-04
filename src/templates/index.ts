/**
 * templates track — the public surface.
 *
 * Implements the frozen `TemplateRenderer` port (`src/contracts/index.ts`):
 * fill one of the eight canonical Canvas templates from slot content + an
 * optional resolved theme, emitting Canvas-allowlist-safe, accessible HTML
 * (PRD §15.3, the `render_template` tool).
 *
 * The fragment each renderer produces is wrapped in a single `<section>` with a
 * stable class hook. Every fragment is built so that engine-core's
 * `validateAllowlist` is a no-op on it (allowlist-stable, no semantic loss).
 */
import type { TemplateRenderer, TemplateType } from '../contracts/index.js';
import { el, txt } from './html.js';
import {
  type Renderer,
  renderAssignment,
  renderDiscussion,
  renderLectureNotes,
  renderModuleOverview,
  renderPageContent,
  renderRubric,
  renderStudyGuide,
  renderSyllabus,
} from './templates.js';

const RENDERERS: Record<TemplateType, Renderer> = {
  syllabus: renderSyllabus,
  'module-overview': renderModuleOverview,
  assignment: renderAssignment,
  discussion: renderDiscussion,
  'page-content': renderPageContent,
  'lecture-notes': renderLectureNotes,
  'study-guide': renderStudyGuide,
  rubric: renderRubric,
};

/**
 * Render one of the eight templates. Never throws on missing/odd slots: optional
 * gaps become warnings, a missing title falls back to a placeholder. An unknown
 * `type` (only reachable from an untyped caller) is reported as a warning rather
 * than crashing the output gate.
 */
export const renderTemplate: TemplateRenderer = async (type, slots, theme) => {
  const render = RENDERERS[type];
  if (!render) {
    const warning = `unknown template type "${String(type)}"; rendered a generic fragment`;
    const html = el(
      'section',
      { class: 'cdaa-template cdaa-unknown' },
      el('p', {}, txt(warning)),
    );
    return { html, type, warnings: [warning] };
  }

  const built = render(slots, theme);
  const html = el('section', { class: `cdaa-template cdaa-${type}` }, built.html);
  return { html, type, warnings: built.warnings };
};
