# templates — the eight canonical Canvas templates

Implements the frozen `TemplateRenderer` port from `src/contracts/index.ts` and
backs the `render_template` tool (PRD §15.3). Given a `TemplateType`, a bag of
slot content, and an optional resolved `ThemeResult`, it emits a **semantic,
accessible, Canvas-allowlist-safe** HTML fragment plus non-fatal `warnings`.

```ts
import { renderTemplate } from './index.js';
const { html, type, warnings } = await renderTemplate('syllabus', slots, theme?);
```

Public surface (`src/templates/index.ts`):

```ts
export const renderTemplate: TemplateRenderer;
```

Zero runtime dependencies. Imports **types only** from `../contracts`. The
engine's `validateAllowlist` is used in the tests (not at runtime) to prove the
output is allowlist-stable.

## Design guarantees

- **Allowlist-stable by construction.** Every fragment is built in the exact
  canonical serialized form that engine-core's `validateAllowlist` produces, so
  the gate is a no-op on it: `validateAllowlist(html).html === html` with an
  empty `removedSemantic`. The `html.ts` builder mirrors the engine serializer's
  invariants — text escaping is `& < >`, attribute escaping is `& " < >`, inline
  styles serialize as `prop: val; prop: val` (lowercase prop, no trailing `;`),
  empty `style` attributes are dropped, and no whitespace is inserted between
  elements. (Tests assert the round-trip for all eight types.)
- **Accessibility-first markup.** One top heading per fragment (`<h2>` — Canvas
  rewrites `<h1>`, so `<h2>` is the real top level), `<h3>` subsections below it,
  semantic lists (`<ul>`/`<ol>`), a definition list (`<dl>`/`<dt>`/`<dd>`) for
  key terms, and a real `<table>` with `<caption>`, `<thead>`, and scoped
  `<th scope="col">` / `<th scope="row">` headers for the rubric. The whole
  fragment is wrapped in a single `<section class="cdaa-template cdaa-<type>">`.
- **Never an inaccessible color.** A `ResolvedColor` from the theme is a
  contrast-safe `{ background, foreground }` PAIR. We only ever use it as a pair
  (set `color` and `background` together — a heading band, a callout box), never
  a lone `color:` against an assumed page background. With **no theme** we emit
  **no color** (safe default: black on white). See `theme.ts`.
- **Never throws on slots.** A missing optional slot omits that section and adds
  a warning. A missing required `title` warns and uses a placeholder heading. An
  unknown template type (only reachable from an untyped caller) is reported as a
  warning, not thrown — so it can never crash the output gate.

## Slot shapes

All slots are optional unless noted. Unknown/oddly-typed values are coerced
(strings trimmed; whitespace-only treated as missing; finite numbers stringified;
non-arrays → empty lists) and otherwise ignored.

| Type | Slots |
| --- | --- |
| `syllabus` | `title`*, `instructor`, `description`, `schedule: string[]`, `policies: string[]` |
| `module-overview` | `title`*, `objectives: string[]`, `items: string[]` |
| `assignment` | `title`*, `overview`, `instructions: string[]`, `dueDate`, `points`, `rubricRef` |
| `discussion` | `title` (defaults to "Discussion"), `prompt`, `guidelines: string[]`, `expectations` |
| `page-content` | `title`*, `sections: { heading, body }[]` |
| `lecture-notes` | `title`*, `topics: { heading, points: string[] }[]` |
| `study-guide` | `title`*, `keyTerms: { term, definition }[]`, `questions: string[]` |
| `rubric` | `title`*, `criteria: { name, levels: { label, points, descriptor }[] }[]` |

\* `title` is the one required slot; when absent it falls back to a placeholder
(`"Untitled <Type>"`) and a warning. `rubricRef` is explicitly optional and does
**not** warn when absent.

### Theme roles

The heading band is dressed by the first present of
`heading → h2 → title → header → primary → accent`; callout/accent boxes
(the assignment due-date/points meta, the discussion expectations) by the first
present of `callout → accent → note → highlight → secondary → primary`. Roles a
theme doesn't define are simply skipped (unstyled, still accessible).

### Rubric table layout

Rows are criteria; columns are the **union** of performance-level labels across
all criteria (in first-appearance order). Each cell shows the matching level's
descriptor and `(N pts)`; a criterion missing a column's level renders an empty
cell. Criteria with no labelled levels collapse to a single `Details` column.

## Files

| File | Responsibility |
| --- | --- |
| `index.ts` | The `renderTemplate` port: dispatch by type + `<section>` wrapper |
| `templates.ts` | The eight renderers + slot coercion + shared markup helpers |
| `theme.ts` | Resolve theme roles into contrast-safe fg+bg style pairs |
| `html.ts` | Canonical, allowlist-stable HTML-fragment builder + escaping |

## Tests

`html.test.ts` covers the builder (escaping, canonical styles, attr order, void
elements). `render.test.ts` covers the contract: all eight types render
non-empty and allowlist-stable, exactly one `<h2>` and no `<h1>`, the rubric
table with scoped headers, theme colors appearing in output (and staying
stable), unthemed output emitting no color, missing-slot warnings, the
placeholder title, content escaping, and the unknown-type fallback.
