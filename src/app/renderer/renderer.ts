/**
 * Renderer shell — the vanilla-TS UI that wires the three-mode product surface.
 *
 * Pure decision logic lives in `../view.ts` (unit-tested); all the DOM work is
 * split across small modules under this directory: `ui.ts` (DOM facade + helpers,
 * the ONLY module touching `document`/`window`), `conversation.ts` (streaming
 * transcript + gated fragment cards + remediate diff), `sessions.ts`,
 * `brandkit.ts`, `alignment.ts`, and `preview.ts` (Canvas-fidelity preview +
 * export). This shell owns app state — selected mode and active session — and
 * threads it into every `runTurn`.
 *
 * Not unit-tested (no DOM under `node:test`); covered by the manual `npm run app`
 * smoke. Safety invariants live in the modules: the only `innerHTML` sink is
 * gated HTML; everything else is `textContent`; the preview iframe is
 * script-disabled `srcdoc`.
 */
import { api, byId, el, errorMessage, onReady, setHidden, type El } from './ui.js';
import { createConversation, type Conversation } from './conversation.js';
import { createSessions } from './sessions.js';
import { createBrandKit } from './brandkit.js';
import { composeAlignmentPrompt, createAlignment } from './alignment.js';
import type { ProductMode, TurnRequest } from '../../contracts/index.js';

type ModeChoice = 'auto' | ProductMode;

const MODES: ReadonlyArray<{ id: ModeChoice; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'guidance', label: 'Guidance' },
  { id: 'build', label: 'Build' },
  { id: 'remediate', label: 'Remediate' },
];

function mount(): void {
  const modeBar = byId('mode-bar');
  const sidebar = byId('sidebar');
  const transcript = byId('transcript');
  const remediateWrap = byId('remediate-wrap');
  const remediateSource = byId('remediate-source');
  const promptEl = byId('prompt');
  const submitEl = byId('submit');
  const panelHost = byId('panel-host');
  const toggleBrand = byId('toggle-brand');
  const toggleAlign = byId('toggle-align');
  const healthEl = byId('health');
  if (
    !modeBar || !sidebar || !transcript || !remediateWrap || !remediateSource ||
    !promptEl || !submitEl || !panelHost || !toggleBrand || !toggleAlign || !healthEl
  ) {
    return;
  }

  // ── App state ──
  let currentMode: ModeChoice = 'auto';
  let currentSessionId: string | undefined;
  let inFlight = false;

  void refreshHealth(healthEl);

  // ── Conversation (transcript) ──
  const conversation: Conversation = createConversation({
    transcript,
    onCheckAlignment: (html) => runGuidance(composeAlignmentPrompt({ content: html })),
  });

  // ── Mode selector (§1) ──
  const modeButtons: El[] = MODES.map((m) => {
    const btn = el('button', { type: 'button', class: 'mode', 'data-mode': m.id }, m.label);
    btn.addEventListener('click', () => setMode(m.id));
    return btn;
  });
  modeBar.replaceChildren(...modeButtons);

  function setMode(mode: ModeChoice): void {
    currentMode = mode;
    MODES.forEach((m, i) => {
      const btn = modeButtons[i];
      if (btn) btn.className = m.id === mode ? 'mode mode--on' : 'mode';
    });
    setHidden(remediateWrap!, mode !== 'remediate');
  }
  setMode('auto');

  // ── Sessions (§2) ──
  const sessions = createSessions({
    getMode: () => (currentMode === 'auto' ? 'guidance' : currentMode),
    onActivate: (state) => {
      currentSessionId = state.session.id;
      conversation.repaint(state.messages);
      sessions.setActive(currentSessionId);
    },
    onDeleted: (id) => {
      if (currentSessionId === id) {
        currentSessionId = undefined;
        conversation.clear();
      }
    },
    onError: (m) => conversation.appendError(m),
  });
  sidebar.replaceChildren(sessions.element);
  void sessions.refresh();

  // ── Panels: brand kit (§6) + alignment coach (§7) ──
  const brand = createBrandKit({ onError: (m) => conversation.appendError(m) });
  const alignment = createAlignment({ onCheck: (prompt) => runGuidance(prompt) });
  panelHost.append(brand.element, alignment.element);
  setHidden(brand.element, true);
  setHidden(alignment.element, true);
  setHidden(panelHost, true);

  type PanelName = 'brand' | 'align' | null;
  let openPanel: PanelName = null;
  function showPanel(name: PanelName): void {
    openPanel = name;
    setHidden(brand.element, name !== 'brand');
    setHidden(alignment.element, name !== 'align');
    setHidden(panelHost!, name === null);
    toggleBrand!.className = name === 'brand' ? 'toggle toggle--on' : 'toggle';
    toggleAlign!.className = name === 'align' ? 'toggle toggle--on' : 'toggle';
    if (name === 'brand') void brand.refresh();
  }
  toggleBrand.addEventListener('click', () => showPanel(openPanel === 'brand' ? null : 'brand'));
  toggleAlign.addEventListener('click', () => showPanel(openPanel === 'align' ? null : 'align'));

  // ── Turn execution (streaming, shared by submit + composed guidance) ──
  async function runTurnReq(req: TurnRequest): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    submitEl!.disabled = true;
    conversation.appendUser(req.user);
    const turn = conversation.beginAssistantTurn();
    try {
      const view = await api().runTurn(req, (chunk) => turn.onChunk(chunk));
      turn.finalize(view);
      if (currentSessionId) void sessions.refresh();
    } catch (err) {
      turn.fail(errorMessage(err));
    } finally {
      inFlight = false;
      submitEl!.disabled = false;
    }
  }

  function submit(): void {
    const user = promptEl!.value.trim();
    if (!user) return;
    const req: TurnRequest = { user };
    if (currentMode !== 'auto') req.mode = currentMode;
    if (currentSessionId) req.sessionId = currentSessionId;
    if (currentMode === 'remediate') {
      req.remediateInput = { sourceHtml: remediateSource!.value };
    }
    promptEl!.value = '';
    void runTurnReq(req);
  }

  function runGuidance(prompt: string): void {
    const req: TurnRequest = { user: prompt, mode: 'guidance' };
    if (currentSessionId) req.sessionId = currentSessionId;
    void runTurnReq(req);
  }

  submitEl.addEventListener('click', () => submit());
  promptEl.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit();
  });
}

async function refreshHealth(healthEl: El): Promise<void> {
  try {
    const health = await api().health();
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

onReady(mount);
