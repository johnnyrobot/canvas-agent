/**
 * Single source of truth for the "Canvas-like" shell that wraps a gated HTML
 * fragment. Used by BOTH sides that must agree (PRD §8.6 / review §9a):
 *   1. the deterministic AUDIT — `playwright-runner` renders this exact document
 *      and scans it; and
 *   2. the PREVIEW / EXPORT — the renderer's sandboxed iframe `srcdoc` and the
 *      downloaded standalone file.
 *
 * Keeping ONE definition is what makes "what you see matches what was audited"
 * literally true. When the preview applied richer styling than the audit (its own
 * link/table/button/blockquote colors), contrast and structure could read fine in
 * the preview yet differ from the page the auditor actually scanned — so the audit
 * is the authority and the preview now mirrors it byte-for-byte.
 *
 * PURE: no imports, no DOM, no Node APIs — so the browser renderer can import this
 * module exactly as safely as the engine does.
 *
 * The CSS approximates Canvas's content styling that the canonical templates emit
 * (headings, links, tables, buttons, blockquotes): white page, #2d3b45 body text,
 * Helvetica Neue/Arial 16px/1.5, Canvas's link/heading/table/button colors.
 * Animations/transitions are disabled for deterministic, reproducible scans.
 */
export const CANVAS_SHELL_CSS = [
  '*,*::before,*::after{animation:none !important;transition:none !important;}',
  'body{margin:0;padding:16px;background:#ffffff;color:#2d3b45;',
  'font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;}',
  'h1,h2,h3,h4,h5,h6{color:#2d3b45;line-height:1.25;margin:1.2em 0 .4em;font-weight:700;}',
  'h1{font-size:1.75em;}h2{font-size:1.4em;}h3{font-size:1.2em;}h4{font-size:1.05em;}',
  'p{margin:0 0 1em;}',
  'a{color:#0374b5;text-decoration:underline;}',
  'ul,ol{margin:0 0 1em 1.6em;padding:0;}li{margin:.25em 0;}',
  'table{border-collapse:collapse;width:100%;margin:0 0 1em;}',
  'caption{text-align:left;font-weight:700;padding:.25em 0;}',
  'th,td{border:1px solid #c7cdd1;padding:8px 12px;text-align:left;vertical-align:top;}',
  'th{background:#f5f5f5;font-weight:600;}',
  'button,.btn,.Button{background:#0374b5;color:#ffffff;border:0;border-radius:4px;',
  'padding:8px 14px;font:inherit;cursor:pointer;}',
  'blockquote{margin:0 0 1em;padding:.5em 1em;border-left:4px solid #c7cdd1;color:#54616a;}',
  'img{max-width:100%;height:auto;}',
  'code,pre{font-family:ui-monospace,"SFMono-Regular",Consolas,Menlo,monospace;}',
  'hr{border:0;border-top:1px solid #c7cdd1;margin:1.5em 0;}',
].join('');

/**
 * Wrap a Canvas-safe fragment in the shared shell as a full HTML document. The
 * fragment is placed inside `#content` exactly as both the auditor's `setContent`
 * and the preview iframe's `srcdoc` consume it.
 */
export function wrapInCanvasShell(fragment: string): string {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    // A non-empty <title> is REQUIRED: the auditor scans this exact document, and
    // WCAG 2.4.2 (axe `document-title`, impact serious → a badge-WITHHOLDING `error`
    // in the gate) fires on a title-less document — which would otherwise withhold
    // the badge on EVERY rendered fragment. The exported standalone file needs one too.
    '<title>Canvas content</title>' +
    `<style>${CANVAS_SHELL_CSS}</style></head>` +
    `<body><div id="content">${fragment}</div></body></html>`
  );
}
