# engine-core — the deterministic engine's pure core

Two pure, synchronous-at-heart, **dependency-free, offline** modules that form
the heart of the Accessibility Engine. They implement the frozen ports declared
in `src/contracts/index.ts` and are consumed by the orchestrator's unconditional
output gate (`src/orchestrator/gate.ts`) plus the theme/templates tracks.

| Port | File | Contract type |
| --- | --- | --- |
| `checkContrast` | `contrast.ts` | `ContrastChecker` |
| `validateAllowlist` | `allowlist.ts` | `AllowlistValidator` |

Both are re-exported from `src/engine/index.ts` — the single public surface.

## `checkContrast(fg, bg, size?)` — WCAG 2.2 contrast (PRD §8.3)

Pure and synchronous. Parses two CSS colors, computes the WCAG-2 relative-
luminance ratio, and returns `{ ratio, level, passesAA, passesAAA, size }`.

- **Color formats:** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` (alpha ignored
  for the ratio), `rgb()`/`rgba()` with integer **or** percentage channels
  (and tolerant of the modern space/slash separator), and the 148 CSS named
  colors (case-insensitive, incl. `grey` aliases and `rebeccapurple`).
- **Thresholds** come from the shared `WCAG` constants (never hardcoded here):
  AA = 4.5 normal / 3.0 large; AAA = 7.0 normal / 4.5 large. `level` is the
  highest band satisfied at the given `size` (default `'normal'`).
- **Ratio** is rounded to 2 dp. Black-on-white = `21`, identical colors = `1`.
- **Invalid input throws** a clear `Error`. `transparent` has no defined
  background to measure, so it is **rejected fail-safe** (throws) rather than
  being silently scored as passing.

## `validateAllowlist(html)` — Canvas allowlist gate + safe repair (Appendix B)

Async port (the contract types it `=> Promise<AllowlistResult>`); the heavy
lifting is a synchronous `repairAllowlist` core. Returns
`{ html, removedSemantic }`.

Pipeline: **tokenize → forgiving tree-build → allowlist repair → stable
re-serialize**. It is a real fragment tokenizer (start/end/void/self-closing
tags, single/double/unquoted attribute values, comments, doctype, raw-text
`<script>`/`<style>`, and HTML entities), **not** regex string-replacement.

Repair rules (Appendix B.6):

- **Allowed** elements/attributes/protocols/style-props are kept; everything
  else is stripped or repaired.
- `<h1>` is **remapped to `<h2>`** (content preserved; not a semantic removal).
- `<script>` / `<style>` subtrees are **dropped entirely** (content and all).
- A disallowed **wrapper** is **unwrapped** — its children are kept.
- Attributes: `on*` handlers always stripped; URL attrs scheme-checked against
  B.4 (entity- and whitespace-obfuscated `javascript:` etc. are decoded first,
  then rejected); inline `style` filtered per B.5 (incl. `url(...)` schemes).
- `removedSemantic` lists, **deduplicated in first-seen order**, the *semantic*
  tags that had to be removed (e.g. `figure`, `figcaption`, `main`). Removing
  one is a downstream **blocker** (the gate turns each into a blocker). Removing
  a purely decorative wrapper (`div`, `span`, `font`, `center`, …) is **not**
  semantic loss and is not listed.
- **Idempotent:** `validateAllowlist(validateAllowlist(x).html).html` equals
  `validateAllowlist(x).html`.

### Documented assumptions (where Appendix B is silent or self-conflicting)

The contract permits a "sensible Canvas-safe default, noted here" when the PRD
is ambiguous. The judgment calls:

1. **`figure` / `figcaption` are not on B.1** and so are treated as disallowed
   semantic elements: unwrapped (children kept) **and** reported in
   `removedSemantic`. This is why the realistic semantic-removal cases are
   `figure`/`figcaption`/`main` rather than allowlisted tags like `table`/`h2`
   (which pass through untouched).
2. **`font`, `source`, `abbr`** appear in the B.3 attribute table but not the
   B.1 tag list. Per the appendix's own source-cleaning note (font/source are
   "allowed-but-discouraged"), all three are **allowed**; `abbr` is included for
   the same reason and because dropping it would be an accessibility regression.
3. **`data-*` attributes are allowed** globally. B.3 does not enumerate them,
   but Appendix C.6's canonical equation-image pattern requires
   `data-equation-content` / `data-ignore-a11y-check`. `data-*` are inert and
   Canvas-safe, so they are preserved.
4. **Inline-style longhands of allowed shorthands are allowed** (e.g.
   `background-color`, `font-size`, `border-color`). B.5 lists the shorthands
   and notes they "may expand to their longhands"; stripping the longhands would
   break theming/contrast. Anything outside an allowed property/shorthand family
   (e.g. `box-shadow`, `transform`, `filter`, `gap`) is dropped.
5. **`rel` is stripped from `<a>`** — it is not in the B.3 attribute table for
   `a` (only `href`, `target`, `name`). The generator's `rel="noopener"`
   convention (Appendix C.3) is a generator concern; modern browsers force
   noopener on `target=_blank` regardless, so this is not a security regression.
6. **HTML comments and doctype/PI declarations are dropped** (inert, never part
   of a Canvas content fragment; `<!DOCTYPE>` is explicitly off-allowlist).
7. **MathML** tags (B.2) are allowed, but only global + ARIA + `data-*`
   attributes are kept on them (B.3 enumerates no MathML-specific attributes).
   MathML is the advanced/opt-in path; the LaTeX-image convention is preferred.

## Tests

`contrast.test.ts` + `allowlist.test.ts`, run via `npm test` (`node:test` + tsx).
Strict TDD; zero runtime dependencies; no network or filesystem access.
