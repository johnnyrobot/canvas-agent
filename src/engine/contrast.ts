/**
 * WCAG 2.2 contrast math — pure, synchronous, deterministic (PRD §8.3, Appendix C.4).
 *
 * Implements `ContrastChecker` from the frozen contracts. No network, no DOM, no
 * dependencies: a CSS color string in, a `ContrastResult` out. Thresholds come
 * from the shared `WCAG` constants so engine-core and the theme track can never
 * drift apart.
 *
 * `transparent` has no defined background to measure against, so it is rejected
 * fail-safe (throws) rather than silently scored as passing.
 */
import { WCAG } from '../contracts/index.js';
import type { ContrastChecker, ContrastResult, TextSize } from '../contracts/index.js';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The 148 CSS named colors (CSS Color Module Level 4), plus grey aliases. */
const NAMED_COLORS: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4',
  azure: '#f0ffff', beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000',
  blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
  burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e',
  coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
  cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9', darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc',
  darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3',
  deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969',
  dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22',
  fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff', gold: '#ffd700',
  goldenrod: '#daa520', gray: '#808080', green: '#008000', greenyellow: '#adff2f',
  grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
  indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa',
  lavenderblush: '#fff0f5', lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6',
  lightcoral: '#f08080', lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3',
  lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
  lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32',
  linen: '#faf0e6', magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd', mediumorchid: '#ba55d3', mediumpurple: '#9370db', mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc', mediumvioletred: '#c71585',
  midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
  navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000',
  olivedrab: '#6b8e23', orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6',
  palegoldenrod: '#eee8aa', palegreen: '#98fb98', paleturquoise: '#afeeee', palevioletred: '#db7093',
  papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f', pink: '#ffc0cb',
  plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399',
  red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513',
  salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee',
  sienna: '#a0522d', silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd',
  slategray: '#708090', slategrey: '#708090', snow: '#fffafa', springgreen: '#00ff7f',
  steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8',
  tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3',
  white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32',
};

function clampChannel(n: number): number {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.round(n);
}

function parseHex(hex: string): Rgb {
  const h = hex.slice(1);
  if (!/^[0-9a-f]+$/.test(h)) throw new Error(`Invalid color: "${hex}" (non-hex digits)`);
  let r: string;
  let g: string;
  let b: string;
  if (h.length === 3 || h.length === 4) {
    r = h[0]! + h[0]!;
    g = h[1]! + h[1]!;
    b = h[2]! + h[2]!;
  } else if (h.length === 6 || h.length === 8) {
    r = h.slice(0, 2);
    g = h.slice(2, 4);
    b = h.slice(4, 6);
  } else {
    throw new Error(`Invalid color: "${hex}" (hex must be 3, 4, 6, or 8 digits)`);
  }
  return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16) };
}

function parseComponent(token: string): number {
  const t = token.trim();
  if (t.endsWith('%')) {
    const pct = Number(t.slice(0, -1));
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(`bad percentage "${token}"`);
    return clampChannel((pct / 100) * 255);
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 255) throw new Error(`bad channel "${token}"`);
  return clampChannel(n);
}

function parseRgb(input: string): Rgb {
  const m = /^rgba?\(([^)]*)\)$/.exec(input);
  if (!m) throw new Error(`Invalid color: "${input}"`);
  // Support both comma and modern slash/space separators for the alpha.
  const body = m[1]!.replace(/\//g, ' ').trim();
  const parts = body.includes(',') ? body.split(',') : body.split(/\s+/);
  const compTokens = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (compTokens.length !== 3 && compTokens.length !== 4) {
    throw new Error(`Invalid color: "${input}" (expected 3 or 4 components)`);
  }
  try {
    return {
      r: parseComponent(compTokens[0]!),
      g: parseComponent(compTokens[1]!),
      b: parseComponent(compTokens[2]!),
    };
  } catch (e) {
    throw new Error(`Invalid color: "${input}" (${(e as Error).message})`);
  }
}

/** Parse a CSS color string to sRGB 0–255. Alpha is ignored. Throws on anything invalid. */
export function parseColor(input: string): Rgb {
  if (typeof input !== 'string') throw new Error('Invalid color: expected a string');
  const raw = input.trim();
  if (raw === '') throw new Error('Invalid color: empty string');
  const lower = raw.toLowerCase();
  if (lower === 'transparent') {
    throw new Error('Invalid color: "transparent" has no defined contrast (rejected fail-safe)');
  }
  if (lower.startsWith('#')) return parseHex(lower);
  if (lower.startsWith('rgb')) return parseRgb(lower);
  const named = NAMED_COLORS[lower];
  if (named) return parseHex(named);
  throw new Error(`Invalid color: "${input}" (unrecognized format)`);
}

/** Linearize one 0–255 channel per the WCAG 2.x formula. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB color. */
function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const checkContrast: ContrastChecker = (fg, bg, size: TextSize = 'normal'): ContrastResult => {
  const l1 = relativeLuminance(parseColor(fg));
  const l2 = relativeLuminance(parseColor(bg));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  const rawRatio = (lighter + 0.05) / (darker + 0.05);

  const aa = size === 'large' ? WCAG.AA_LARGE : WCAG.AA_NORMAL;
  const aaa = size === 'large' ? WCAG.AAA_LARGE : WCAG.AAA_NORMAL;

  // Compare the RAW ratio to the thresholds (WCAG: do not round before comparing).
  const passesAA = rawRatio >= aa;
  const passesAAA = rawRatio >= aaa;
  const level: ContrastResult['level'] = passesAAA ? 'AAA' : passesAA ? 'AA' : 'fail';

  return { ratio: round2(rawRatio), level, passesAA, passesAAA, size };
};
