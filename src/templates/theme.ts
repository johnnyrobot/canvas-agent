/**
 * Theme application for templates.
 *
 * A `ThemeResult` carries `ResolvedColor`s — each one a `{ background, foreground }`
 * PAIR that engine-core's theme resolver has already guaranteed is contrast-safe
 * (AA) at the pair's `contrast` level. The brief's hard rule is: never emit a
 * color pair that fails AA. The safe way to honor that without re-checking
 * contrast ourselves is to only ever use a resolved color as a pair — i.e. set
 * BOTH `color: foreground` and `background: background` together. We never set a
 * lone `color:` against an assumed page background (that would not be guaranteed
 * accessible). With no theme we emit no color at all (safe default: black-on-white).
 *
 * Role names are free-form strings (`ThemeRole = string`), so we resolve by a
 * small priority list and use the first role the theme actually provides.
 */
import type { ResolvedColor, ThemeResult } from '../contracts/index.js';
import type { StyleDecls } from './html.js';

/** Roles, in priority order, that can dress the top heading band. */
const HEADING_ROLES = ['heading', 'h2', 'title', 'header', 'primary', 'accent'];

/** Roles, in priority order, that can dress a callout / accent block. */
const CALLOUT_ROLES = ['callout', 'accent', 'note', 'highlight', 'secondary', 'primary'];

function pick(theme: ThemeResult | undefined, roles: readonly string[]): ResolvedColor | undefined {
  if (!theme) return undefined;
  for (const role of roles) {
    const found = theme.colors.find((c) => c.role.toLowerCase() === role);
    if (found) return found;
  }
  return undefined;
}

/**
 * Inline-style declarations for the top heading band, or `[]` when no theme /
 * no matching role (callers then emit an unstyled heading). Always a fg+bg pair.
 */
export function headingBandStyle(theme?: ThemeResult): StyleDecls {
  const color = pick(theme, HEADING_ROLES);
  if (!color) return [];
  return [
    ['color', color.foreground],
    ['background', color.background],
    ['padding', '0.15em 0.4em'],
    ['border-radius', '0.15em'],
  ];
}

/**
 * Inline-style declarations for a callout / accent block, or `[]` when no theme /
 * no matching role. Always a fg+bg pair, so the box is guaranteed AA.
 */
export function calloutStyle(theme?: ThemeResult): StyleDecls {
  const color = pick(theme, CALLOUT_ROLES);
  if (!color) return [];
  return [
    ['color', color.foreground],
    ['background', color.background],
    ['padding', '0.5em 0.75em'],
    ['border-radius', '0.25em'],
  ];
}
