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
