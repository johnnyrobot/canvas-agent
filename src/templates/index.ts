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
import type { TemplateRenderer, TemplateType, ThemeResult } from '../contracts/index.js';
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
 * A `ThemeResult` carries its colors in a `colors` ARRAY, and the renderers read
 * it as one. `render_template` is called by a model, though, and it composed the
 * shape it found natural — `{ heading: {...}, body: {...} }` — instead of
 * forwarding what `resolve_theme` had just returned it. `pick()` then read
 * `.colors.find` off `undefined`, so a page that was otherwise ready came back
 * to the model as a raw TypeError, and the turn spent one of its five
 * iterations on a reply it could not learn anything from.
 *
 * The theme is the DRESSING. Losing it costs colour; it must never cost the
 * page, so an unusable one is dropped and named in the warnings.
 */
function usableTheme(theme: unknown): theme is ThemeResult {
  return (
    typeof theme === 'object' &&
    theme !== null &&
    Array.isArray((theme as { colors?: unknown }).colors)
  );
}

/**
 * Render one of the eight templates. Never throws on missing/odd slots or an
 * unusable theme: optional gaps become warnings, a missing title falls back to a
 * placeholder. An unknown `type` (only reachable from an untyped caller) is
 * reported as a warning rather than crashing the output gate.
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

  const themeWarnings: string[] = [];
  let applied = theme;
  if (theme !== undefined && !usableTheme(theme)) {
    applied = undefined;
    themeWarnings.push(
      'the "theme" was not resolve_theme\'s result ({ colors: [...] }); rendered unthemed — pass resolve_theme\'s output through unchanged',
    );
  }

  const built = render(slots, applied);
  const html = el('section', { class: `cdaa-template cdaa-${type}` }, built.html);
  return { html, type, warnings: [...themeWarnings, ...built.warnings] };
};
