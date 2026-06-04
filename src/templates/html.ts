/**
 * A tiny, canonical HTML-fragment builder.
 *
 * The whole point of this module is to emit markup that is ALREADY in the exact
 * serialized form that engine-core's `validateAllowlist` produces, so a fragment
 * we build is a fixed point of the allowlist gate: `validateAllowlist(html).html
 * === html` with an empty `removedSemantic`. To guarantee that we mirror the
 * engine serializer's three invariants exactly:
 *
 *  1. Text escaping is `& < >` only (NOT quotes) — see `escapeText`.
 *  2. Attribute escaping is `& " < >` — see `escapeAttr`.
 *  3. Inline styles are serialized as `prop: val; prop: val` (lowercase prop,
 *     a single space after the colon, `; ` between, no trailing `;`) and an
 *     empty style attribute is dropped — see `styleValue` + `el`.
 *
 * We also never insert whitespace between elements (the serializer concatenates
 * children with no separator), so output is single-line and compact.
 *
 * Zero runtime dependencies; pure string functions.
 */

/** Escape text content exactly like the engine serializer (`& < >`, not quotes). */
export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape an attribute value exactly like the engine serializer (`& " < >`). */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A list of `[property, value]` inline-style declarations. */
export type StyleDecls = ReadonlyArray<readonly [string, string]>;

/**
 * Serialize style declarations into the canonical form the allowlist gate emits.
 * Properties are lowercased, values trimmed, empty declarations dropped. Returns
 * `''` when nothing survives (callers/`el` then omit the attribute entirely).
 */
export function styleValue(decls: StyleDecls): string {
  return decls
    .filter(([prop, val]) => prop !== '' && val.trim() !== '')
    .map(([prop, val]) => `${prop.toLowerCase()}: ${val.trim()}`)
    .join('; ');
}

/** Permitted attribute value kinds. `null`/`undefined` → attribute omitted. */
export type AttrValue = string | number | null | undefined;

/** HTML void elements (no children, no closing tag) — matches the engine. */
const VOID_TAGS = new Set<string>([
  'area', 'br', 'col', 'embed', 'hr', 'img', 'param', 'source', 'track',
]);

/**
 * Build one element. `attrs` are emitted in insertion order (the gate preserves
 * order, so this round-trips). `null`/`undefined` attrs are skipped, and an
 * empty `style` is skipped (an empty style would be dropped by the gate, which
 * would otherwise break stability). Children are already-serialized HTML strings.
 */
export function el(
  tag: string,
  attrs: Record<string, AttrValue>,
  children: string | readonly string[] = [],
): string {
  let attrStr = '';
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    const str = String(value);
    if (name === 'style' && str === '') continue;
    attrStr += ` ${name}="${escapeAttr(str)}"`;
  }
  if (VOID_TAGS.has(tag)) return `<${tag}${attrStr}>`;
  const inner = typeof children === 'string' ? children : children.join('');
  return `<${tag}${attrStr}>${inner}</${tag}>`;
}

/** Escape a plain-text string into an HTML text node. */
export function txt(s: string): string {
  return escapeText(s);
}
