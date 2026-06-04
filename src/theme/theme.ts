/**
 * Accessible ThemeResolver — pure, synchronous-at-heart, offline, zero-dep.
 *
 * Implements `ThemeResolver` from the frozen contracts (PRD §15.3, `resolve_theme`):
 * given a 2-color brand palette and a set of UI roles, produce contrast-safe
 * color assignments. **Every returned `{ foreground, background }` pair passes
 * WCAG 2.2 AA** — that is the whole point of the resolver.
 *
 * WCAG math is NOT reimplemented here: every contrast number comes from
 * engine-core's `checkContrast` (the frozen `ContrastChecker`), so theme and
 * engine-core can never drift apart.
 */
import { checkContrast } from '../engine/index.js';
import { WCAG } from '../contracts/index.js';
import type { ContrastResult, ResolvedColor, ThemeRole, ThemeResolver } from '../contracts/index.js';

/**
 * The default role set a Canvas template colors (brief / PRD §15.3). Used when
 * the caller omits `roles`. Index parity drives the palette mapping below.
 */
export const DEFAULT_THEME_ROLES: ThemeRole[] = ['heading', 'accent', 'button', 'callout', 'link'];

const BLACK = '#000000';
const WHITE = '#ffffff';

export interface ForegroundChoice {
  /** Either pure black or pure white — whichever reads better on `background`. */
  foreground: string;
  /** `checkContrast(foreground, background)` — the canonical contract direction. */
  contrast: ContrastResult;
}

/**
 * Pick an accessible foreground (black or white) for a solid `background`.
 *
 * We choose whichever of black/white yields the higher contrast ratio. For any
 * opaque sRGB color the better of the two is **provably ≥ ~4.58:1**: the two
 * candidates cross over at background luminance ≈ 0.179, where each gives ≈4.58,
 * and they only climb from there. So this choice ALWAYS clears AA-normal (4.5)
 * — no brand color ever has to be mutated to make its text readable.
 *
 * Ties (only at the exact crossover) resolve to black: darker text is the safer,
 * more conventional default for body copy.
 */
export function accessibleForeground(background: string): ForegroundChoice {
  const onBlack = checkContrast(BLACK, background);
  const onWhite = checkContrast(WHITE, background);
  return onWhite.ratio > onBlack.ratio
    ? { foreground: WHITE, contrast: onWhite }
    : { foreground: BLACK, contrast: onBlack };
}

/**
 * Resolve accessible foregrounds for a 2-color brand palette across `roles`.
 *
 * Mapping (documented, deterministic): role `i` is backed by the **primary**
 * brand color (`color1`) when `i` is even and the **secondary** (`color2`) when
 * `i` is odd. Backgrounds are the raw brand colors — faithful to the user's
 * brand — because black/white text already guarantees AA on any solid color
 * (see `accessibleForeground`), so no darkening/lightening is required.
 *
 * Warning: a 2-color theme's one real accessibility risk is the brand pair being
 * mutually indistinct (e.g. two pale pastels). We surface that — using the
 * WCAG non-text distinctness threshold (3:1) on `checkContrast(color1, color2)`
 * — while STILL returning AA-safe pairs (black/white text rather than the naive,
 * failing brand-on-brand pairing). That is the "resolver fixed them" guarantee.
 *
 * Invalid brand colors are rejected fail-safe: `checkContrast` throws, so the
 * returned promise rejects with a clear error (consistent with engine-core).
 */
export const resolveTheme: ThemeResolver = async (color1, color2, roles = DEFAULT_THEME_ROLES) => {
  const warnings: string[] = [];

  // Validates both brand colors (throws on anything invalid) and measures their
  // mutual distinctness in one call.
  const pair = checkContrast(color1, color2);
  if (pair.ratio < WCAG.AA_LARGE) {
    warnings.push(
      `Brand colors "${color1}" and "${color2}" are low-contrast (ratio ${pair.ratio}:1, below the ` +
        `${WCAG.AA_LARGE}:1 distinctness threshold). Each role uses accessible black/white text and still ` +
        `passes AA, but the two brand colors may look similar.`,
    );
  }

  const colors: ResolvedColor[] = roles.map((role, i) => {
    const background = i % 2 === 0 ? color1 : color2;
    const { foreground, contrast } = accessibleForeground(background);
    return { role, background, foreground, contrast };
  });

  return { colors, warnings };
};
