/**
 * End-to-end turn (offline): a scripted model → the REAL tools (engine
 * allowlist + contrast, theme, templates, knowledge) → the REAL unconditional
 * output gate. Only the model and the two sidecars are faked; the render-and-
 * scan auditor uses its REAL mapping core behind a fake `ScanRunner` (the
 * production auditor drives headless Chromium, which `npm test` must not).
 *
 * Run with: npx tsx --test "e2e" (kept out of the src unit glob; see README).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatResult } from '../src/llm/index.js';
import type { ChatRunner } from '../src/orchestrator/index.js';
import { validateAllowlist } from '../src/engine/index.js';
import { createAuditor } from '../src/engine/render/index.js';
import type { ScanResult, ScanRunner } from '../src/engine/render/index.js';
import { createAppApi } from '../src/runtime/index.js';

/** Scripted model: returns queued responses in order. */
class ScriptedRunner implements ChatRunner {
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedRunner exhausted');
    return next;
  }
}

const text = (content: string): ChatResult => ({ content, model: 'gemma4:31b', raw: {} });
const callTool = (name: string, args: Record<string, unknown>): ChatResult => ({
  content: '', model: 'gemma4:31b', raw: {}, toolCalls: [{ name, arguments: args }],
});

/** A clean render-and-scan: the REAL auditor mapping with no findings, no browser. */
const cleanScan: ScanRunner = { run: async (): Promise<ScanResult> => ({ axe: { violations: [] }, textRuns: [] }) };

const fakeLlm = { describeImage: async () => text('alt'), isHealthy: async () => true };
const fakeIngest = { convertPath: async () => ({ status: 'success', processingTimeMs: 1 }), isHealthy: async () => true };

function appWith(script: ChatResult[]) {
  return createAppApi({
    chatRunner: new ScriptedRunner(script),
    audit: createAuditor(cleanScan), // REAL auditor core, offline
    llm: fakeLlm,
    ingest: fakeIngest,
    // retriever defaults to the REAL bundled Knowledge Packs (offline).
  });
}

test('a full turn renders a template, audits it, and the gate passes with a clean badge', async () => {
  // Model: call render_template, then audit_html on the result, then answer.
  const app = appWith([
    callTool('render_template', {
      type: 'module-overview',
      slots: {
        title: 'Week 1: Foundations',
        objectives: ['Define accessibility', 'Identify WCAG 2.2 AA'],
        items: ['Read chapter 1', 'Submit reflection'],
      },
    }),
    callTool('audit_html', { html: '<section>…</section>' }),
    text('Your module overview is ready and passed the accessibility checks.'),
  ]);

  const view = await app.runTurn({ user: 'Build a Week 1 module overview page.' });

  assert.equal(view.iterations, 3);
  assert.ok(view.toolsUsed.includes('render_template'));
  assert.ok(view.toolsUsed.includes('audit_html'));

  // Exactly one emitted HTML fragment (from render_template), and it passes the gate.
  assert.equal(view.fragments.length, 1);
  const frag = view.fragments[0]!;
  assert.equal(frag.gate.conformance.passedChecks, true, 'badge granted');
  assert.equal(frag.gate.badgeWithheld, false);
  assert.equal(frag.gate.conformance.blockers.length, 0);
  assert.ok(frag.html.includes('Week 1: Foundations'));

  // The gated HTML is allowlist-clean: re-running the allowlist is a no-op and
  // removes no semantic elements.
  const re = await validateAllowlist(frag.html);
  assert.deepEqual(re.removedSemantic, []);
  assert.equal(re.html, frag.html);
});

test('a deliberately bad fragment makes the gate withhold the badge', async () => {
  // <figure>/<figcaption> are semantic elements OFF the Canvas allowlist, so the
  // REAL allowlist gate removes them — and removing a semantic element is itself
  // a blocker (PRD §8.6). The model emits the fragment as fenced HTML.
  const bad =
    'Here you go:\n\n```html\n' +
    '<figure><img src="https://ex.test/p.png" alt="A plotted curve"><figcaption>Figure 1</figcaption></figure>\n' +
    '```\n';
  const app = appWith([text(bad)]);

  const view = await app.runTurn({ user: 'Give me a figure as HTML.' });

  assert.equal(view.fragments.length, 1);
  const frag = view.fragments[0]!;
  assert.equal(frag.gate.badgeWithheld, true, 'badge withheld for a blocking fragment');
  assert.equal(frag.gate.conformance.passedChecks, false);
  assert.ok(
    frag.gate.conformance.blockers.some((b) => b.id === 'allowlist-removed-semantic'),
    'semantic-loss blocker present',
  );
  // The gated HTML is still safe to show (allowlist-repaired), just badge-less.
  assert.ok(!frag.html.includes('<figure'));
});
