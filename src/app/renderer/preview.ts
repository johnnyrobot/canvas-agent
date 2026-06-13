/**
 * Canvas-fidelity preview + export (brief §4).
 *
 * The preview renders gated HTML inside a SANDBOXED `<iframe>` — `sandbox` with
 * no `allow-scripts`, content delivered via `srcdoc`, never a remote URL. The
 * gated HTML is wrapped in the engine's shared `wrapInCanvasShell` — the SAME
 * document the auditor renders and scans — so what the user sees and exports here
 * is byte-for-byte what the audit saw (PRD §8.6 / review §9a). There is no
 * second, hand-maintained copy of the shell CSS to drift from the audit.
 *
 * SAFETY: the iframe is script-disabled and the document is an opaque origin. The
 * ONLY content placed in `srcdoc` is the already-gated HTML (allowlist + audit
 * safe). No model/user HTML is ever passed here ungated.
 */
import { copyText, el, later, setHidden, type El } from './ui.js';
import { wrapInCanvasShell } from '../../engine/render/canvas-shell.js';

/**
 * Wrap a Canvas-safe fragment in the shared Canvas shell for `srcdoc` — identical
 * to the document the auditor scans (see `engine/render/canvas-shell.ts`).
 */
export function previewSrcdoc(html: string): string {
  return wrapInCanvasShell(html);
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
