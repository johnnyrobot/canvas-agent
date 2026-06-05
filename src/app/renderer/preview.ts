/**
 * Canvas-fidelity preview + export (brief §4).
 *
 * The preview renders gated HTML inside a SANDBOXED `<iframe>` — `sandbox` with
 * no `allow-scripts`, content delivered via `srcdoc`, never a remote URL. The
 * gated HTML is wrapped in a stylesheet that mirrors the engine's
 * `playwright-runner` `canvasShell` (white bg, #2d3b45 text, Helvetica
 * Neue/Arial 16px/1.5, 16px padding) plus basic heading/list/table/button
 * styling, so what the user sees here matches what the audit saw.
 *
 * SAFETY: the iframe is script-disabled and the document is an opaque origin. The
 * ONLY content placed in `srcdoc` is the already-gated HTML (allowlist + audit
 * safe). No model/user HTML is ever passed here ungated.
 */
import { copyText, el, later, setHidden, type El } from './ui.js';

/**
 * Canvas-fidelity CSS, inlined into the preview `srcdoc`. The first two rules
 * are the engine's `canvasShell`; the rest add the headings/lists/tables/buttons
 * the canonical templates produce so the preview reads like a real Canvas page.
 */
const CANVAS_CSS = [
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

/** Wrap a Canvas-safe fragment in the fidelity shell for `srcdoc`. */
export function previewSrcdoc(html: string): string {
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    `<style>${CANVAS_CSS}</style></head>` +
    `<body><div id="content">${html}</div></body></html>`
  );
}

/**
 * A script-disabled, sandboxed preview frame showing `html` with Canvas
 * fidelity. Reused by the brand-kit live template preview (§6).
 */
export function previewFrame(html: string, label = 'Canvas-fidelity preview'): El {
  const frame = el('iframe', { class: 'preview__frame', title: label });
  // Empty `sandbox` = maximally restricted: no scripts, opaque origin.
  frame.setAttribute('sandbox', '');
  frame.setAttribute('srcdoc', previewSrcdoc(html));
  return frame;
}

/** Build a `data:` URL that downloads the gated HTML as a standalone file. */
function downloadHref(html: string): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(previewSrcdoc(html));
}

/**
 * The reusable artifacts strip for one piece of gated HTML: Preview toggle,
 * Copy HTML, Download, and Show code (brief §4). `html` MUST be `gate.html`.
 */
export function fragmentArtifacts(html: string): El {
  const container = el('div', { class: 'artifacts' });

  const previewBtn = el('button', { type: 'button', class: 'artifacts__btn', 'aria-pressed': 'false' }, 'Preview');
  const copyBtn = el('button', { type: 'button', class: 'artifacts__btn' }, 'Copy HTML');
  const downloadBtn = el('button', { type: 'button', class: 'artifacts__btn' }, 'Download');
  const codeBtn = el('button', { type: 'button', class: 'artifacts__btn', 'aria-pressed': 'false' }, 'Show code');
  const toolbar = el('div', { class: 'artifacts__bar' }, previewBtn, copyBtn, downloadBtn, codeBtn);
  container.append(toolbar);

  // Preview frame (lazily filled, hidden until toggled).
  const frame = previewFrame(html);
  const previewWrap = el('div', { class: 'artifacts__preview' }, frame);
  setHidden(previewWrap, true);

  // Raw code view (text only — never innerHTML).
  const codeEl = el('code');
  codeEl.textContent = html;
  const pre = el('pre', { class: 'artifacts__code' }, codeEl);
  setHidden(pre, true);

  container.append(previewWrap, pre);

  let previewing = false;
  previewBtn.addEventListener('click', () => {
    previewing = !previewing;
    setHidden(previewWrap, !previewing);
    previewBtn.setAttribute('aria-pressed', String(previewing));
    previewBtn.className = previewing ? 'artifacts__btn artifacts__btn--on' : 'artifacts__btn';
  });

  let showingCode = false;
  codeBtn.addEventListener('click', () => {
    showingCode = !showingCode;
    setHidden(pre, !showingCode);
    codeBtn.textContent = showingCode ? 'Hide code' : 'Show code';
    codeBtn.setAttribute('aria-pressed', String(showingCode));
    codeBtn.className = showingCode ? 'artifacts__btn artifacts__btn--on' : 'artifacts__btn';
  });

  copyBtn.addEventListener('click', () => {
    void copyText(html).then((ok) => {
      copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      later(() => {
        copyBtn.textContent = 'Copy HTML';
      }, 1400);
    });
  });

  // Download via a transient `data:text/html` anchor.
  downloadBtn.addEventListener('click', () => {
    const a = el('a', { href: downloadHref(html), download: 'fragment.html' });
    setHidden(a, true);
    container.append(a);
    a.click();
    a.remove();
  });

  return container;
}
