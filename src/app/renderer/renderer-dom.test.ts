/**
 * Renderer DOM-harness tests (SHIP-READINESS recommendation #10).
 *
 * The renderer modules touch the DOM only through `ui.ts`, which reads the GLOBAL
 * `document`/`window` at call time. We install a tiny fake `document` here and
 * assert the two XSS-adjacent invariants that are correct but were unverified at
 * the DOM level:
 *   - `previewFrame` sets `sandbox=''` + `srcdoc = previewSrcdoc(html)` and NEVER
 *     writes `innerHTML`;
 *   - in the conversation, the remediate `before` (UNGATED source) is written via
 *     `textContent`, and the gate-approved `html` is the SOLE `innerHTML` sink.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { El } from './ui.js';
import type { GateResult, TurnView } from '../../contracts/index.js';

// ── Minimal DOM facade fake honoring ui.ts's `El` surface ────────────────────
class FakeEl {
  className = '';
  textContent: string | null = '';
  value = '';
  disabled = false;
  hidden = false;
  scrollTop = 0;
  readonly scrollHeight = 0;
  readonly tag: string;
  readonly attrs: Record<string, string> = {};
  children: (FakeEl | string)[] = [];
  /** Every value ever assigned to innerHTML (the audited sink we police). */
  readonly innerHTMLWrites: string[] = [];
  private _innerHTML = '';

  constructor(tag: string) {
    this.tag = tag;
  }
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(v: string) {
    this._innerHTML = v;
    this.innerHTMLWrites.push(v);
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  append(...nodes: (FakeEl | string)[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeEl | string)[]): void {
    this.children = [...nodes];
  }
  remove(): void {}
  click(): void {}
  focus(): void {}
  addEventListener(): void {}
}

/** Every element created since the last reset — so we can audit innerHTML writes. */
let created: FakeEl[] = [];
const doc = {
  readyState: 'complete',
  createElement: (tag: string): FakeEl => {
    const e = new FakeEl(tag);
    created.push(e);
    return e;
  },
  getElementById: (): FakeEl | null => null,
  addEventListener: (): void => {},
};
(globalThis as unknown as { document: unknown }).document = doc;
(globalThis as unknown as { window: unknown }).window = { canvasAgent: {}, navigator: {} };

beforeEach(() => {
  created = [];
});

// Imported AFTER the globals exist on globalThis (module load touches no DOM, but
// keep the ordering obvious). ui.ts reads the globals lazily, at call time.
const { previewFrame, previewSrcdoc } = await import('./preview.js');
const { createConversation } = await import('./conversation.js');
// The renderer's own module: `mount()` finds no '#app' in this fake document and
// returns without rendering, so importing it is inert.
const { healthStatus } = await import('./renderer.js');
const { startModelPull, advanceModelPull } = await import('./model-health.js');

/** Every element in the rendered subtree, self first. */
function descendants(node: FakeEl): FakeEl[] {
  const out = [node];
  for (const child of node.children) if (child instanceof FakeEl) out.push(...descendants(child));
  return out;
}

/** All rendered text in the subtree, in document order. */
function renderedText(node: FakeEl): string {
  const own = node.textContent ?? '';
  const kids = node.children.map((c) => (c instanceof FakeEl ? renderedText(c) : c));
  return [own, ...kids].filter((s) => s !== '').join(' ');
}

const byTestId = (node: FakeEl, id: string): FakeEl | undefined =>
  descendants(node).find((e) => e.attrs['data-testid'] === id);
const progressBars = (node: FakeEl): FakeEl[] =>
  descendants(node).filter((e) => e.attrs.role === 'progressbar');

const missingModel = (tag: string) => ({ tag, available: false, installCommand: `ollama pull ${tag}` });

const healthView = (over: Partial<Parameters<typeof healthStatus>[0]> = {}): Parameters<typeof healthStatus>[0] => ({
  health: 'degraded',
  healthText: 'Models not installed (granite4.1:8b, vision:2b)',
  modelsMissing: [missingModel('granite4.1:8b'), missingModel('vision:2b')],
  modelPull: undefined,
  ingestModelMissing: false,
  ingestPull: undefined,
  onDownloadModel: () => {},
  onDownloadIngestModel: () => {},
  ...over,
});

const allInnerHtmlWrites = (): string[] => created.flatMap((e) => e.innerHTMLWrites);
const gate = (html: string, withheld = false, blockerMsg?: string): GateResult => ({
  html,
  conformance: {
    passedChecks: !withheld,
    blockers: blockerMsg ? [{ id: 'b', severity: 'blocker', message: blockerMsg }] : [],
    warnings: [],
    needsHumanReview: [],
  },
  badgeWithheld: withheld,
});

test('previewFrame: sandbox="" + srcdoc=previewSrcdoc, and never writes innerHTML', () => {
  const html = '<h2>Hi</h2><p>body</p>';
  const frame = previewFrame(html) as unknown as FakeEl;
  assert.equal(frame.attrs.sandbox, '', 'maximally-restricted sandbox');
  assert.equal(frame.attrs.srcdoc, previewSrcdoc(html), 'srcdoc is the byte-identical shell');
  assert.equal(frame.innerHTMLWrites.length, 0, 'preview must never use innerHTML');
});

test('conversation: a gated fragment is the sole innerHTML sink', () => {
  const transcript = new FakeEl('main') as unknown as El;
  const convo = createConversation({ transcript });
  const view: TurnView = {
    text: 'Built it.',
    mode: 'build',
    toolsUsed: ['render_template'],
    iterations: 1,
    fragments: [{ html: '<p>GATED-HTML</p>', gate: gate('<p>GATED-HTML</p>') }],
  };
  convo.beginAssistantTurn().finalize(view);
  assert.deepEqual(allInnerHtmlWrites(), ['<p>GATED-HTML</p>'], 'only the gate-approved html hits innerHTML');
});

test('conversation remediate: before is textContent; only the gated after hits innerHTML', () => {
  const transcript = new FakeEl('main') as unknown as El;
  const convo = createConversation({ transcript });
  const view: TurnView = {
    text: 'Repaired.',
    mode: 'remediate',
    toolsUsed: [],
    iterations: 1,
    fragments: [
      {
        html: '<p>AFTER-GATED</p>',
        gate: gate('<p>AFTER-GATED</p>'),
        remediateResult: {
          before: '<script>BEFORE-UNGATED</script>',
          after: '<p>AFTER-GATED</p>',
          issueDiffs: [],
          gate: gate('<p>AFTER-GATED</p>'),
        },
      },
    ],
  };
  convo.beginAssistantTurn().finalize(view);

  const writes = allInnerHtmlWrites();
  assert.deepEqual(writes, ['<p>AFTER-GATED</p>'], 'only the gated after is rendered via innerHTML');
  assert.ok(
    !writes.some((w) => w.includes('BEFORE-UNGATED')),
    'the ungated source must NEVER reach an innerHTML sink',
  );
  assert.ok(
    created.some((e) => e.textContent === '<script>BEFORE-UNGATED</script>'),
    'the ungated source is rendered as inert textContent',
  );
});

test('conversation: streamed assistant text is written via textContent, never innerHTML', () => {
  const transcript = new FakeEl('main') as unknown as El;
  const convo = createConversation({ transcript });
  const turn = convo.beginAssistantTurn();
  turn.onChunk({ type: 'text', delta: '<b>not markup</b>' });
  assert.deepEqual(allInnerHtmlWrites(), [], 'streamed text must not use innerHTML');
  assert.ok(
    created.some((e) => e.textContent === '<b>not markup</b>'),
    'streamed text is set as textContent (inert)',
  );
});

test('conversation: a withheld-badge fragment surfaces blocker messages as text, html still gated', () => {
  const transcript = new FakeEl('main') as unknown as El;
  const convo = createConversation({ transcript });
  const view: TurnView = {
    text: '',
    mode: 'build',
    toolsUsed: [],
    iterations: 1,
    fragments: [{ html: '<p>X</p>', gate: gate('<p>X</p>', true, 'Removed semantic <figure>') }],
  };
  convo.beginAssistantTurn().finalize(view);
  const writes = allInnerHtmlWrites();
  assert.deepEqual(writes, ['<p>X</p>'], 'only the gated html hits innerHTML even when the badge is withheld');
  assert.ok(
    !writes.some((w) => w.includes('figure')),
    'the blocker message must never reach an innerHTML sink',
  );
  // Blocker messages are appended as inert string children (list items), not innerHTML.
  assert.ok(
    created.some((e) => e.children.includes('Removed semantic <figure>')),
    'blocker messages are surfaced as inert text children',
  );
});

// ── First-run model provisioning, at the DOM level (issue #32) ───────────────

test('first run states the total download size BEFORE the download starts', () => {
  const status = healthStatus(healthView()) as unknown as FakeEl;
  const size = byTestId(status, 'download-size');
  assert.ok(size, 'the size must be visible next to the affordance, not only in the aria-label');
  // granite4.1:8b (5.3 GB) is declared; the fixture vision tag is not, so the
  // stated total is honestly a floor rather than an invented number.
  assert.match(renderedText(size), /5\.3 GB/);
  assert.equal(progressBars(status).length, 0, 'no bar before a download exists');
  assert.ok(byTestId(status, 'download-model'), 'the affordance is offered');
});

test('one progress bar spans both models and names the one transferring', () => {
  let pull = startModelPull(['granite4.1:8b', 'vision:2b']);
  pull = advanceModelPull(pull, { status: 'success', model: 'granite4.1:8b' });
  pull = advanceModelPull(pull, { status: 'downloading', model: 'vision:2b', percent: 50 });

  const status = healthStatus(healthView({ modelPull: pull })) as unknown as FakeEl;
  const bars = progressBars(status);
  assert.equal(bars.length, 1, 'ONE bar across the set — a second bar is a second download');
  assert.equal(bars[0]!.attrs['aria-valuenow'], '75', 'aggregate, not the current model’s own percent');
  assert.match(renderedText(status), /vision:2b/, 'the model transferring is named');
  assert.equal(byTestId(status, 'download-model'), undefined, 'no re-download while one runs');
  // The health text is the condition the pull is fixing, so beside a running bar
  // it contradicts it. The bar's own status line replaces it.
  assert.doesNotMatch(renderedText(status), /not installed/, '"not installed" beside a 75% bar');
});

test('the status region is a pure function of screen state, holding nothing between renders', () => {
  // The renderer replaces its whole DOM subtree on every progress line, so the
  // download state has to be rebuildable from `state` alone. This asserts the
  // weaker half of that — the render keeps nothing between calls — because
  // `healthStatus` takes the state as a parameter and so CANNOT express a
  // download whose state lives in the DOM. The criterion itself ("an in-flight
  // download survives a re-render") is proved end to end by `M25` in
  // `e2e/ui-guided.test.ts`, which samples the real bar across real re-renders.
  const pull = advanceModelPull(startModelPull(['granite4.1:8b', 'vision:2b']), {
    status: 'downloading',
    model: 'granite4.1:8b',
    percent: 40,
  });
  const view = healthView({ modelPull: pull });
  const first = healthStatus(view) as unknown as FakeEl;
  const second = healthStatus(view) as unknown as FakeEl;

  assert.notEqual(first, second, 'a re-render builds new elements');
  assert.equal(progressBars(first)[0]!.attrs['aria-valuenow'], '20');
  assert.equal(
    progressBars(second)[0]!.attrs['aria-valuenow'],
    progressBars(first)[0]!.attrs['aria-valuenow'],
  );
  assert.equal(renderedText(second), renderedText(first));
});

test('an instructor who already has both models is offered no download', () => {
  const status = healthStatus(
    healthView({ health: 'ready', healthText: 'Local runtime ready - granite4.1:8b', modelsMissing: [] }),
  ) as unknown as FakeEl;
  assert.equal(byTestId(status, 'download-model'), undefined, 'no re-download of several gigabytes');
  assert.equal(byTestId(status, 'download-size'), undefined, 'and no size to warn about');
  assert.equal(progressBars(status).length, 0);
});

test('the document-model download stays a separate, independently-offered affordance', () => {
  // Docling models are NOT part of the required set: they gate PDF conversion
  // only, so they must never be folded into the two-model bar.
  const status = healthStatus(
    healthView({ modelsMissing: [], ingestModelMissing: true }),
  ) as unknown as FakeEl;
  assert.ok(byTestId(status, 'download-ingest-model'));
  assert.equal(byTestId(status, 'download-model'), undefined);
});
