/**
 * Canvas HTML allowlist gate + safe repair (PRD section 8.4 / Appendix B; Stage-5 hard gate).
 *
 * A deterministic, dependency-free filter: any element, attribute, URL scheme, or
 * inline-style property not on the Appendix B allowlist is stripped or repaired
 * before the fragment is returned. Canvas applies an equivalent filter on save, so
 * anything off-allowlist would be silently lost in the RCE -- we never emit it.
 *
 * Implementation = a real HTML-fragment tokenizer -> forgiving tree builder ->
 * allowlist-driven repair -> stable re-serialization. No regex string-replacement
 * on raw HTML (that is how sanitizers get bypassed); we parse properly.
 *
 * `removedSemantic` reports only *semantic* elements that had to be removed
 * (e.g. <figure>, <figcaption>) -- downstream the gate turns each into a blocker.
 * Unwrapping a decorative wrapper (<center>, an off-list <div>, ...) is NOT
 * semantic loss and is not reported. See README for the documented assumptions.
 */
import type { AllowlistResult, AllowlistValidator } from '../contracts/index.js';

// --- Appendix B data ---------------------------------------------------------

/** B.1 HTML tags + B.2 MathML tags + B.3-only tags (font/source/abbr, allowed-but-discouraged). */
const ALLOWED_TAGS = new Set<string>([
  // B.1
  'a', 'acronym', 'address', 'area', 'article', 'aside', 'audio', 'b', 'bdo', 'big',
  'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del',
  'details', 'dfn', 'div', 'dl', 'dt', 'em', 'embed', 'footer', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'iframe', 'kbd', 'legend', 'li',
  'map', 'nav', 'object', 'ol', 'p', 'param', 'picture', 'pre', 'q', 'ruby', 'rp',
  'rt', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'track',
  'tt', 'u', 'ul', 'var', 'video',
  // B.3 attribute table but not B.1 -- treated as allowed-but-discouraged (see README)
  'font', 'source', 'abbr',
  // B.2 MathML
  'annotation', 'annotation-xml', 'maction', 'maligngroup', 'malignmark', 'math',
  'menclose', 'merror', 'mfenced', 'mfrac', 'mglyph', 'mi', 'mlabeledtr', 'mlongdiv',
  'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mprescripts', 'mroot',
  'mrow', 'ms', 'mscarries', 'mscarry', 'msgroup', 'msline', 'mspace', 'msqrt',
  'msrow', 'mstack', 'mstyle', 'msub', 'msubsup', 'msup', 'mtable', 'mtd', 'mtext',
  'mtr', 'munder', 'munderover', 'none', 'semantics', 'mark',
]);

/** B.3 global attributes allowed on every element. */
const GLOBAL_ATTRS = new Set<string>(['style', 'class', 'id', 'title', 'role', 'lang', 'dir']);

/** B.3 ARIA attributes allowed globally where semantically valid. */
const ARIA_ATTRS = new Set<string>([
  'aria-atomic', 'aria-busy', 'aria-controls', 'aria-describedby', 'aria-disabled',
  'aria-dropeffect', 'aria-flowto', 'aria-grabbed', 'aria-haspopup', 'aria-hidden',
  'aria-invalid', 'aria-label', 'aria-labelledby', 'aria-live', 'aria-owns',
  'aria-relevant', 'aria-autocomplete', 'aria-checked', 'aria-expanded', 'aria-level',
  'aria-multiline', 'aria-multiselectable', 'aria-orientation', 'aria-pressed',
  'aria-readonly', 'aria-required', 'aria-selected', 'aria-sort', 'aria-valuemax',
  'aria-valuemin', 'aria-valuenow', 'aria-valuetext',
]);

/** B.3 per-element attribute table. Globals + ARIA + data-* are added on top of these. */
const PER_ELEMENT_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'target', 'name']),
  abbr: new Set(['title']),
  area: new Set(['alt', 'coords', 'href', 'shape', 'target']),
  audio: new Set(['name', 'src', 'muted', 'controls']),
  blockquote: new Set(['cite']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  embed: new Set(['name', 'src', 'type', 'allowfullscreen', 'pluginspage', 'wmode', 'allowscriptaccess', 'width', 'height']),
  font: new Set(['face', 'color', 'size']),
  img: new Set(['align', 'alt', 'height', 'src', 'title', 'usemap', 'width']),
  iframe: new Set(['src', 'width', 'height', 'name', 'align', 'allowfullscreen']),
  map: new Set(['name']),
  object: new Set(['width', 'height', 'style', 'data', 'type', 'classid', 'codebase']),
  ol: new Set(['start', 'type']),
  param: new Set(['name', 'value']),
  q: new Set(['cite']),
  source: new Set(['height', 'media', 'sizes', 'src', 'srcset', 'type', 'width']),
  table: new Set(['summary', 'width', 'border', 'cellpadding', 'cellspacing', 'center', 'frame', 'rules']),
  tr: new Set(['align', 'valign', 'dir']),
  td: new Set(['abbr', 'axis', 'colspan', 'rowspan', 'width', 'align', 'valign', 'dir']),
  th: new Set(['abbr', 'axis', 'colspan', 'rowspan', 'width', 'align', 'valign', 'dir', 'scope']),
  ul: new Set(['type']),
  video: new Set(['name', 'src', 'allowfullscreen', 'muted', 'poster', 'width', 'height', 'controls', 'playsinline']),
};

const A_HREF_SCHEMES = new Set(['ftp', 'http', 'https', 'mailto', 'skype']);
const HTTP_SCHEMES = new Set(['http', 'https']);

/** B.4 URL-bearing attributes per element -> the schemes permitted on them. */
const URL_ATTRS: Readonly<Record<string, Readonly<Record<string, ReadonlySet<string>>>>> = {
  a: { href: A_HREF_SCHEMES },
  area: { href: A_HREF_SCHEMES },
  img: { src: HTTP_SCHEMES },
  iframe: { src: HTTP_SCHEMES },
  embed: { src: HTTP_SCHEMES, pluginspage: HTTP_SCHEMES },
  audio: { src: HTTP_SCHEMES },
  video: { src: HTTP_SCHEMES, poster: HTTP_SCHEMES },
  source: { src: HTTP_SCHEMES, srcset: HTTP_SCHEMES },
  track: { src: HTTP_SCHEMES },
  object: { data: HTTP_SCHEMES, codebase: HTTP_SCHEMES, classid: HTTP_SCHEMES },
  blockquote: { cite: HTTP_SCHEMES },
  q: { cite: HTTP_SCHEMES },
};

/** B.5 inline-style properties (exact tokens). */
const STYLE_PROPS_EXACT = new Set<string>([
  'background', 'border', 'border-radius', 'clear', 'color', 'cursor', 'direction',
  'display', 'flex', 'float', 'font', 'grid', 'height', 'left', 'line-height',
  'list-style', 'margin', 'max-height', 'max-width', 'min-height', 'min-width',
  'overflow', 'overflow-x', 'overflow-y', 'padding', 'position', 'right', 'text-align',
  'table-layout', 'text-decoration', 'text-indent', 'top', 'vertical-align',
  'visibility', 'white-space', 'width', 'z-index', 'zoom',
]);

/** B.5 note: the allowed shorthands "may expand to their longhands" -- so allow them. */
const STYLE_SHORTHAND_ROOTS = ['background', 'border', 'font', 'margin', 'padding', 'list-style', 'grid', 'flex', 'overflow'];

/** HTML void elements (no children, no end tag). */
const VOID_TAGS = new Set<string>([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose entire subtree (incl. raw text) is discarded, not unwrapped. */
const DROP_SUBTREE_TAGS = new Set<string>(['script', 'style']);

/** Raw-text elements: their content is consumed verbatim, never parsed as markup. */
const RAW_TEXT_TAGS = new Set<string>(['script', 'style']);

/**
 * Tags whose *removal* is genuine semantic loss (a blocker downstream). Most of
 * these are on the allowlist and so are never removed; the ones that actually
 * trigger under Appendix B are the semantic elements it omits (figure,
 * figcaption, main, ...). Decorative/inline-format wrappers (span, div, font, b,
 * i, center, ...) are deliberately NOT here.
 */
const SEMANTIC_TAGS = new Set<string>([
  'main', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'col', 'colgroup',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'q', 'cite',
  'a', 'img', 'area', 'map',
  'audio', 'video', 'track', 'iframe', 'embed', 'object', 'source', 'picture',
  'nav', 'header', 'footer', 'section', 'article', 'aside', 'address',
  'details', 'summary',
  'abbr', 'acronym', 'dfn', 'time', 'del', 'ins', 'ruby', 'rp', 'rt', 'mark', 'legend',
  // Interactive form controls. Canvas's Appendix B strips all of these, so they are
  // unwrapped here — but losing a control is genuine semantic/interactive loss, so
  // their removal must be flagged as a blocker, not silently flattened (C15).
  // (`legend` above is on the allowlist and is therefore never removed.)
  'form', 'fieldset', 'label', 'button', 'input', 'select', 'textarea', 'optgroup', 'option', 'output', 'datalist',
]);

/** Heading tag -> its level (1..6). Used by the structure-preserving heading shift (C15). */
const HEADING_LEVELS: Readonly<Record<string, number>> = {
  h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
};

// --- Entity decoding / escaping ----------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  deg: '°', plusmn: '±', times: '×', divide: '÷',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Tokenizer ---------------------------------------------------------------

interface Attr {
  name: string;
  value: string | null;
}

type Token =
  | { kind: 'open'; tag: string; attrs: Attr[]; selfClose: boolean }
  | { kind: 'close'; tag: string }
  | { kind: 'text'; text: string };

const NAME_RE = /[a-zA-Z][a-zA-Z0-9:-]*/y;
const WS_RE = /\s/;

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = html.length;

  const pushText = (text: string) => {
    if (text.length > 0) tokens.push({ kind: 'text', text });
  };

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    i = lt;

    // Comment
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    // Declaration / doctype / processing instruction -> drop
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i + 1);
      i = end === -1 ? len : end + 1;
      continue;
    }
    // End tag
    if (html[i + 1] === '/') {
      NAME_RE.lastIndex = i + 2;
      const m = NAME_RE.exec(html);
      if (m && m.index === i + 2) {
        const end = html.indexOf('>', NAME_RE.lastIndex);
        tokens.push({ kind: 'close', tag: m[0].toLowerCase() });
        i = end === -1 ? len : end + 1;
        continue;
      }
      pushText('<');
      i += 1;
      continue;
    }
    // Start tag
    NAME_RE.lastIndex = i + 1;
    const nameMatch = NAME_RE.exec(html);
    if (!nameMatch || nameMatch.index !== i + 1) {
      pushText('<');
      i += 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    let j = NAME_RE.lastIndex;
    const attrs: Attr[] = [];
    let selfClose = false;

    while (j < len) {
      const ch = html[j]!;
      if (WS_RE.test(ch)) {
        j += 1;
        continue;
      }
      if (ch === '>') {
        j += 1;
        break;
      }
      if (ch === '/') {
        if (html[j + 1] === '>') {
          selfClose = true;
          j += 2;
          break;
        }
        j += 1;
        continue;
      }
      // Attribute name
      let name = '';
      while (j < len) {
        const c = html[j]!;
        if (WS_RE.test(c) || c === '=' || c === '>' || c === '/') break;
        name += c;
        j += 1;
      }
      if (name === '') {
        j += 1; // unparseable char inside the tag -- skip to avoid stalling
        continue;
      }
      while (j < len && WS_RE.test(html[j]!)) j += 1;
      let value: string | null = null;
      if (html[j] === '=') {
        j += 1;
        while (j < len && WS_RE.test(html[j]!)) j += 1;
        const q = html[j];
        if (q === '"' || q === "'") {
          const close = html.indexOf(q, j + 1);
          if (close === -1) {
            value = html.slice(j + 1);
            j = len;
          } else {
            value = html.slice(j + 1, close);
            j = close + 1;
          }
        } else {
          let v = '';
          while (j < len) {
            const c = html[j]!;
            if (WS_RE.test(c) || c === '>') break;
            v += c;
            j += 1;
          }
          value = v;
        }
      }
      attrs.push({ name: name.toLowerCase(), value: value === null ? null : decodeEntities(value) });
    }

    tokens.push({ kind: 'open', tag, attrs, selfClose });
    i = j;

    // Raw-text elements: consume content verbatim up to the matching close tag.
    if (RAW_TEXT_TAGS.has(tag) && !selfClose) {
      // Match `</tag` followed by an end-tag delimiter (whitespace, `/`, or `>`)
      // then any bogus attributes up to `>`, so `</script foo>` closes the element
      // instead of being missed and the rest of the document swallowed to EOF (L1).
      // The delimiter lookahead means `</scriptfoo>` does NOT close `<script>`.
      const closeRe = new RegExp(`</${tag}(?=[\\s/>])[^>]*>`, 'i');
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      if (m) {
        pushText(rest.slice(0, m.index));
        tokens.push({ kind: 'close', tag });
        i += m.index + m[0].length;
      } else {
        pushText(rest);
        tokens.push({ kind: 'close', tag });
        i = len;
      }
    }
  }
  return tokens;
}

// --- Tree builder ------------------------------------------------------------

interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Attr[];
  children: Node[];
}
interface TextNode {
  type: 'text';
  text: string;
}
type Node = ElementNode | TextNode;

function buildTree(tokens: Token[]): Node[] {
  const root: ElementNode = { type: 'element', tag: '#root', attrs: [], children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1]!;

  for (const tok of tokens) {
    if (tok.kind === 'text') {
      top().children.push({ type: 'text', text: decodeEntities(tok.text) });
    } else if (tok.kind === 'open') {
      const node: ElementNode = { type: 'element', tag: tok.tag, attrs: tok.attrs, children: [] };
      top().children.push(node);
      if (!VOID_TAGS.has(tok.tag) && !tok.selfClose) stack.push(node);
    } else {
      let k = -1;
      for (let s = stack.length - 1; s >= 1; s -= 1) {
        if (stack[s]!.tag === tok.tag) {
          k = s;
          break;
        }
      }
      if (k !== -1) stack.length = k; // auto-close intervening unclosed tags
    }
  }
  return root.children;
}

// --- Repair transform --------------------------------------------------------

function isStylePropAllowed(prop: string): boolean {
  if (STYLE_PROPS_EXACT.has(prop)) return true;
  return STYLE_SHORTHAND_ROOTS.some((root) => prop.startsWith(`${root}-`));
}

/** True if a URL value's scheme is permitted (relative/fragment URLs always pass). */
function isSchemeAllowed(value: string, allowed: ReadonlySet<string>): boolean {
  const cleaned = value.replace(/[\u0000-\u0020]/g, ''); // strip control chars + whitespace
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (!m) return true; // no scheme -> relative / fragment / protocol-relative
  return allowed.has(m[1]!.toLowerCase());
}

/**
 * Split an inline-style value into declarations on top-level `;` only — a `;`
 * inside `url(...)` or a quoted string is part of the value, not a separator, so
 * a naive `value.split(';')` would truncate e.g. `url(...;...)` (L3).
 */
function splitStyleDeclarations(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      if (depth > 0) depth -= 1;
    } else if (c === ';' && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function filterStyle(value: string): string {
  const kept: string[] = [];
  for (const decl of splitStyleDeclarations(value)) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (prop === '' || val === '') continue;
    if (!isStylePropAllowed(prop)) continue;
    // Scheme-check EVERY url() in the declaration (a value can hold more than one,
    // e.g. image-set/cross-fade) — drop the declaration if any scheme is off-list.
    const urlRe = /url\(\s*['"]?\s*([a-zA-Z][a-zA-Z0-9+.-]*):/gi;
    let badScheme = false;
    for (let m = urlRe.exec(val); m !== null; m = urlRe.exec(val)) {
      if (!HTTP_SCHEMES.has(m[1]!.toLowerCase())) {
        badScheme = true;
        break;
      }
    }
    if (badScheme) continue;
    kept.push(`${prop}: ${val}`);
  }
  return kept.join('; ');
}

function filterAttrs(tag: string, attrs: Attr[]): Attr[] {
  const perElement = PER_ELEMENT_ATTRS[tag];
  const urlAttrs = URL_ATTRS[tag];
  const out: Attr[] = [];
  const seen = new Set<string>();

  for (const { name, value } of attrs) {
    if (seen.has(name)) continue;
    if (name.startsWith('on')) continue; // event handlers, always
    const allowed =
      name.startsWith('data-') ||
      GLOBAL_ATTRS.has(name) ||
      ARIA_ATTRS.has(name) ||
      (perElement?.has(name) ?? false);
    if (!allowed) continue;

    if (name === 'style') {
      if (value === null) continue;
      const filtered = filterStyle(value);
      if (filtered === '') continue;
      out.push({ name, value: filtered });
      seen.add(name);
      continue;
    }

    const schemeSet = urlAttrs?.[name];
    if (schemeSet && value !== null && !isSchemeAllowed(value, schemeSet)) continue;

    out.push({ name, value });
    seen.add(name);
  }
  return out;
}

/**
 * Finalize one element into its parent's output list, given its already-transformed
 * children. Split out from the traversal so the walk can be iterative (explicit
 * stack) instead of recursive — deeply nested HTML must not overflow the call
 * stack (C13). Allowed tags are kept (attrs filtered); headings are shifted down a
 * level when the document has a content <h1> (`shiftHeadings`, see C15); and a
 * disallowed tag is unwrapped, flagged as semantic loss the first time it is seen.
 */
function finalizeElement(
  node: ElementNode,
  kids: Node[],
  out: Node[],
  removed: string[],
  removedSet: Set<string>,
  shiftHeadings: boolean,
): void {
  const tag = node.tag;
  // When the document has a content <h1>, demote EVERY heading by one level
  // (clamped at h6) so the relative hierarchy — and thus heading order — is
  // preserved. Demoting only <h1> would orphan subsections and could manufacture
  // the very heading-order violations the auditor then blocks (C15).
  const headingLevel = HEADING_LEVELS[tag];
  if (headingLevel !== undefined && shiftHeadings) {
    const shiftedTag = `h${Math.min(6, headingLevel + 1)}`;
    out.push({ type: 'element', tag: shiftedTag, attrs: filterAttrs(shiftedTag, node.attrs), children: kids });
    return;
  }
  if (ALLOWED_TAGS.has(tag)) {
    out.push({ type: 'element', tag, attrs: filterAttrs(tag, node.attrs), children: kids });
    return;
  }
  // Disallowed -> unwrap (keep children); flag if it was semantic.
  if (SEMANTIC_TAGS.has(tag) && !removedSet.has(tag)) {
    removedSet.add(tag);
    removed.push(tag);
  }
  for (const k of kids) out.push(k);
}

interface TransformFrame {
  nodes: Node[];
  index: number;
  /** Output list this frame's own children accumulate into. */
  kids: Node[];
  /** The element being transformed (null only for the synthetic root frame). */
  node: ElementNode | null;
  /** Where this element's finalized output is appended (its parent's `kids`). */
  parentOut: Node[];
}

/**
 * Iterative, allowlist-driven repair of the parsed tree. Uses an explicit stack
 * (not recursion) so arbitrarily deep documents are handled without a stack
 * overflow. Each element is finalized AFTER its children (post-order), so
 * `removedSemantic` records inner tags before outer — identical to the recursion
 * it replaced.
 */
function transform(nodes: Node[], removed: string[], removedSet: Set<string>, shiftHeadings: boolean): Node[] {
  const result: Node[] = [];
  const stack: TransformFrame[] = [{ nodes, index: 0, kids: result, node: null, parentOut: result }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.nodes.length) {
      stack.pop();
      if (frame.node !== null) {
        finalizeElement(frame.node, frame.kids, frame.parentOut, removed, removedSet, shiftHeadings);
      }
      continue;
    }
    const node = frame.nodes[frame.index]!;
    frame.index += 1;
    if (node.type === 'text') {
      frame.kids.push(node);
      continue;
    }
    if (DROP_SUBTREE_TAGS.has(node.tag)) continue; // discard element + contents
    stack.push({ nodes: node.children, index: 0, kids: [], node, parentOut: frame.kids });
  }
  return result;
}

// --- Serializer --------------------------------------------------------------

type SerItem = { str: string } | { node: Node };

/** Iterative serializer (explicit stack) — no per-depth recursion (C13). */
function serialize(nodes: Node[]): string {
  let out = '';
  const stack: SerItem[] = [];
  for (let k = nodes.length - 1; k >= 0; k -= 1) stack.push({ node: nodes[k]! });
  while (stack.length > 0) {
    const item = stack.pop()!;
    if ('str' in item) {
      out += item.str;
      continue;
    }
    const node = item.node;
    if (node.type === 'text') {
      out += escapeText(node.text);
      continue;
    }
    let attrsStr = '';
    for (const { name, value } of node.attrs) {
      attrsStr += value === null ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`;
    }
    if (VOID_TAGS.has(node.tag)) {
      out += `<${node.tag}${attrsStr}>`;
      continue;
    }
    // Emit `<tag …>` then children (in order) then `</tag>`: push close first,
    // children reversed, open last, so they pop in document order.
    stack.push({ str: `</${node.tag}>` });
    for (let k = node.children.length - 1; k >= 0; k -= 1) stack.push({ node: node.children[k]! });
    stack.push({ str: `<${node.tag}${attrsStr}>` });
  }
  return out;
}

// --- Public port -------------------------------------------------------------

/** Synchronous core of the gate; `validateAllowlist` is the contract's async port. */
export function repairAllowlist(html: string): AllowlistResult {
  const tokens = tokenize(html);
  // A content <h1> would duplicate the Canvas page-title <h1>. When one is present,
  // the whole heading hierarchy is shifted down a level (clamped at h6) — computed
  // here from the flat token stream so the decision is document-global and does not
  // depend on traversal/sibling state (C15).
  const shiftHeadings = tokens.some((t) => t.kind === 'open' && t.tag === 'h1');
  const tree = buildTree(tokens);
  const removed: string[] = [];
  const repaired = transform(tree, removed, new Set<string>(), shiftHeadings);
  return { html: serialize(repaired), removedSemantic: removed };
}

export const validateAllowlist: AllowlistValidator = async (html: string): Promise<AllowlistResult> =>
  repairAllowlist(html);
