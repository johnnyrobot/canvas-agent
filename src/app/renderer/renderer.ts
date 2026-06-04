/**
 * Renderer — the minimal vanilla-TS UI. Runs in the sandboxed browser context.
 *
 * All decision logic is delegated to the PURE, unit-tested `turnViewToVm`
 * (`../view.ts`); this file only does DOM work: read the prompt, call
 * `window.canvasAgent.runTurn`, and paint the transcript. It is NOT unit-tested
 * (no DOM under `node:test`); it's covered by the manual `npm run app` smoke.
 *
 * DOM typing: we deliberately do NOT pull in the full `dom` lib. A global
 * `/// <reference lib="dom" />` would redefine shared globals (e.g.
 * `ReadableStream`) for the WHOLE program and break sibling modules typed
 * against Node's lib. Instead this file declares a small, module-scoped DOM
 * facade covering exactly the surface the renderer touches — isolated, with no
 * effect on any other track's types.
 *
 * Safety: assistant/user text is written via `textContent` (never interpolated
 * as HTML). The ONLY `innerHTML` sink is each fragment's `gate.html`, which has
 * already passed the unconditional allowlist + audit gate and is therefore
 * Canvas-safe to render.
 */
import type { AppApi } from '../../contracts/index.js';
import { turnViewToVm, type FragmentVm, type TurnVm } from '../view.js';

// ── Module-local DOM facade (see header) ─────────────────────────────────────
interface DomEvent {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
}
interface El {
  className: string;
  textContent: string | null;
  innerHTML: string;
  value: string;
  disabled: boolean;
  scrollTop: number;
  readonly scrollHeight: number;
  setAttribute(name: string, value: string): void;
  append(...nodes: (El | string)[]): void;
  addEventListener(type: string, handler: (event: DomEvent) => void): void;
}
interface Doc {
  readonly readyState: string;
  createElement(tag: string): El;
  getElementById(id: string): El | null;
  addEventListener(type: string, handler: () => void): void;
}
declare const document: Doc;
declare const window: { canvasAgent: AppApi };

// ── DOM helpers ──────────────────────────────────────────────────────────────
function el(tag: string, attrs: Record<string, string> = {}, ...children: (El | string)[]): El {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function renderFragment(fragment: FragmentVm): El {
  const badge = el(
    'span',
    { class: `badge badge--${fragment.badge.kind}`, role: 'status' },
    fragment.badge.label,
  );

  const card = el('article', { class: 'fragment' }, badge);

  // The gated HTML is the trusted output of `enforceGate` — safe to inject.
  const body = el('div', { class: 'fragment__html' });
  body.innerHTML = fragment.html;
  card.append(body);

  if (fragment.blockers.length > 0) {
    const list = el('ul', { class: 'fragment__blockers' });
    for (const message of fragment.blockers) list.append(el('li', {}, message));
    card.append(el('p', { class: 'fragment__blockers-label' }, 'Blocking issues:'), list);
  }

  if (fragment.needsReview.length > 0) {
    const list = el('ul', { class: 'fragment__review' });
    for (const message of fragment.needsReview) list.append(el('li', {}, message));
    card.append(el('p', { class: 'fragment__review-label' }, 'Needs human review:'), list);
  }

  return card;
}

function renderTurn(vm: TurnVm): El {
  const turn = el('section', { class: 'turn turn--assistant' });

  if (vm.text) turn.append(el('p', { class: 'turn__text' }, vm.text));

  for (const fragment of vm.fragments) turn.append(renderFragment(fragment));

  if (vm.toolsUsed.length > 0) {
    turn.append(
      el(
        'p',
        { class: 'turn__tools' },
        `Tools used: ${vm.toolsUsed.join(', ')} · ${vm.iterations} iteration(s)`,
      ),
    );
  }

  return turn;
}

function renderUserMessage(text: string): El {
  return el('section', { class: 'turn turn--user' }, el('p', { class: 'turn__text' }, text));
}

function mount(): void {
  const promptEl = document.getElementById('prompt');
  const submitEl = document.getElementById('submit');
  const transcriptEl = document.getElementById('transcript');
  const healthEl = document.getElementById('health');
  if (!promptEl || !submitEl || !transcriptEl || !healthEl) return;

  void refreshHealth(healthEl);

  async function submit(): Promise<void> {
    const user = promptEl!.value.trim();
    if (!user) return;

    transcriptEl!.append(renderUserMessage(user));
    promptEl!.value = '';
    submitEl!.disabled = true;

    try {
      const view = await window.canvasAgent.runTurn({ user });
      transcriptEl!.append(renderTurn(turnViewToVm(view)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      transcriptEl!.append(
        el('section', { class: 'turn turn--error' }, el('p', {}, `Error: ${message}`)),
      );
    } finally {
      submitEl!.disabled = false;
      transcriptEl!.scrollTop = transcriptEl!.scrollHeight;
    }
  }

  submitEl.addEventListener('click', () => void submit());
  promptEl.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
  });
}

async function refreshHealth(healthEl: El): Promise<void> {
  try {
    const health = await window.canvasAgent.health();
    const ok = health.llm && health.ingest;
    healthEl.textContent = ok
      ? 'Local runtime: ready'
      : `Local runtime: llm ${health.llm ? 'up' : 'down'}, ingest ${health.ingest ? 'up' : 'down'}`;
    healthEl.className = ok ? 'health health--ok' : 'health health--degraded';
  } catch {
    healthEl.textContent = 'Local runtime: unavailable';
    healthEl.className = 'health health--degraded';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
