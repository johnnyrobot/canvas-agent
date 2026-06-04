# theme — the accessible ThemeResolver

A single pure, **offline, dependency-free** module that implements the frozen
`ThemeResolver` port from `src/contracts/index.ts` (PRD §15.3, the `resolve_theme`
tool). Given a 2-color brand palette and a set of UI roles, it produces
contrast-safe color assignments and is consumed by the templates track (and wired
into `EngineCapabilities` by integration).

| Port | File | Contract type |
| --- | --- | --- |
| `resolveTheme` | `theme.ts` | `ThemeResolver` |

Re-exported from `src/theme/index.ts` — the single public surface. The only
cross-track dependency is engine-core's read-only `checkContrast` (the frozen
`ContrastChecker`): **WCAG math is never reimplemented here**, so theme and
engine-core can never drift apart.

## `resolveTheme(color1, color2, roles?)` — contrast-safe brand theming

```ts
const { colors, warnings } = await resolveTheme('#0b3d91', '#ffd700');
// colors: ResolvedColor[]  — one per role, every pair passes WCAG 2.2 AA
// warnings: string[]       — empty for a healthy palette
```

- `color1` / `color2` are the user's brand colors — **any** CSS color string the
  engine accepts (`#rgb`, `#rrggbb`, `#rgba`/`#rrggbbaa`, `rgb()/rgba()` with
  integer or `%` channels, and the 148 named colors).
- `roles` (default `['heading', 'accent', 'button', 'callout', 'link']`) name the
  slots a Canvas template will color.
- Returns `{ colors, warnings }`. Each `ResolvedColor` is
  `{ role, background, foreground, contrast }`, where
  `contrast === checkContrast(foreground, background)`.

### The core guarantee

**Every returned `{ foreground, background }` pair passes AA-normal (4.5:1).**
This is the whole point of the resolver, and the tests assert it for every role
of every palette.

## How it works

1. **Background mapping (documented, deterministic).** Role `i` is backed by the
   **primary** brand color (`color1`) when `i` is even and the **secondary**
   (`color2`) when `i` is odd — a stable alternation across the role list. With
   the default roles: `heading`→`color1`, `accent`→`color2`, `button`→`color1`,
   `callout`→`color2`, `link`→`color1`. Backgrounds are the **raw** brand colors,
   faithful to the user's brand (see the proof below for why no mutation is
   needed).

2. **Accessible foreground.** For each background we pick whichever of pure black
   or pure white gives the higher contrast ratio (ties → black). `contrast` is
   the engine's `checkContrast(foreground, background)` for that choice.

3. **Warnings.** A 2-color theme's one real accessibility risk is the brand pair
   being mutually indistinct (e.g. two pale pastels). We measure
   `checkContrast(color1, color2)` and warn when it falls below the WCAG non-text
   distinctness threshold (**3:1**, `WCAG.AA_LARGE`) — while still returning
   AA-safe pairs (black/white text instead of the naive, failing brand-on-brand
   pairing). That is the *"resolver fixed them"* behavior.

### Documented judgment calls (where the brief leaves room)

1. **Foreground is always pure black or white**, exactly as the brief specifies.
   The better of the two is **provably ≥ ~4.58:1 against any opaque sRGB color**:
   black-on-bg gives `20·L + 1` and white-on-bg gives `1.05 / (L + 0.05)`; these
   cross at background luminance `L ≈ 0.179`, where each equals ≈4.58, and only
   climb away from it. So the chosen foreground **always clears AA-normal (4.5)**
   — which is why the brief's "if neither black nor white reaches AA, adjust the
   background" branch is, for solid colors, **provably unreachable**. We therefore
   keep brand backgrounds un-mutated rather than ship a dead darken/lighten path.

2. **The warning is a palette-level distinctness signal**, not a per-pair text
   failure (there are none — see #1). Threshold is **3:1**, the WCAG 1.4.11
   non-text / large-text distinctness bar, which is the principled measure of
   "can a reader tell these two brand colors apart." Two pale pastels (mutual
   ≈1.0:1) warn; a dark+bright pair does not.

3. **Backgrounds are returned verbatim** as the caller's color strings (not
   normalized to hex), so `rgb(...)` or a named color round-trips unchanged. Each
   such string is still a valid CSS color for downstream Canvas-safe HTML.

4. **Roles are honored 1:1, in request order** — not de-duplicated or reordered.
   With a 2-color palette and total index mapping, every role always receives a
   background, so the brief's *"role couldn't be satisfied from the palette"*
   warning condition does not arise and is intentionally omitted.

5. **Invalid brand colors reject fail-safe.** `checkContrast` throws on anything
   it cannot parse (incl. `transparent`), so `resolveTheme` returns a rejected
   promise with a clear error rather than emitting an unsafe theme.

## Tests

`theme.test.ts`, run via `npm test` (`node:test` + `tsx`). Strict TDD; zero
runtime dependencies; no network or filesystem access. Coverage: default-role
selection, no-warning high-contrast palette with every pair AA, low-contrast
pastel pair that warns yet still passes AA, exact role coverage/order,
`contrast` equals an independent `checkContrast`, the black/white foreground
choice and its provable AA floor, deterministic output, and invalid-input
rejection.
