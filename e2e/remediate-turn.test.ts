/**
 * Offline remediation E2E: scripted model → real runtime remediation loop →
 * injected deterministic gate. This complements `full-turn.test.ts` by proving
 * before/after diffs and residual-blocker behavior without launching Electron.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatResult } from '../src/llm/index.js';
import type { ChatRunner } from '../src/orchestrator/index.js';
import { createAppApi } from '../src/runtime/index.js';
import type { AuditIssue, GateDeps } from '../src/contracts/index.js';

class ScriptedRunner implements ChatRunner {
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedRunner exhausted');
    return next;
  }
}

const text = (content: string): ChatResult => ({ content, model: 'gemma4:31b', raw: {} });
const html = (body: string): ChatResult => text(`\`\`\`html\n${body}\n\`\`\``);
const fakeLlm = { describeImage: async () => text('alt'), isHealthy: async () => true };
const fakeIngest = { convertPath: async () => ({ status: 'success', processingTimeMs: 1 }), isHealthy: async () => true };

function blocker(id: string): AuditIssue {
  return { id, severity: 'blocker', message: `Blocking issue ${id}`, category: 'error' };
}

function exactGate(): GateDeps {
  return {
    validateAllowlist: async (input) => ({ html: input, removedSemantic: [] }),
    audit: async (input) => ({
      issues: input.includes('bad') ? [blocker('image-alt'), blocker('contrast')] : [],
    }),
  };
}

function xGate(): GateDeps {
  return {
    validateAllowlist: async (input) => ({ html: input, removedSemantic: [] }),
    audit: async (input) => {
      const count = (input.match(/X/g) ?? []).length;
      return { issues: Array.from({ length: count }, (_v, i) => blocker(`x-${i}`)) };
    },
  };
}

test('remediate fully fixed: before issues disappear and issueDiffs are fixed', async () => {
  const app = createAppApi({
    chatRunner: new ScriptedRunner([html('<h2>Good</h2><p>Readable fixed content.</p>')]),
    gate: exactGate(),
    llm: fakeLlm,
    ingest: fakeIngest,
  });

  const view = await app.runTurn({
    user: 'Fix this page.',
    mode: 'remediate',
    remediateInput: { sourceHtml: '<h2>bad</h2><img src="x.png">' },
  });

  const frag = view.fragments[0]!;
  assert.equal(view.mode, 'remediate');
  assert.equal(frag.gate.badgeWithheld, false);
  assert.ok(frag.remediateResult);
  assert.equal(frag.remediateResult.before.includes('bad'), true);
  assert.equal(frag.remediateResult.after.includes('Good'), true);
  assert.deepEqual(frag.remediateResult.issueDiffs.map((d) => d.fixed), [true, true]);
});

test('remediate residual blocker: bounded re-audit stops with badge withheld', async () => {
  const app = createAppApi({
    chatRunner: new ScriptedRunner([
      html('<p>XXXXXX</p>'),
      html('<p>XXXXX</p>'),
      html('<p>XXXX</p>'),
      html('<p>XXX</p>'),
    ]),
    gate: xGate(),
    llm: fakeLlm,
    ingest: fakeIngest,
  });

  const view = await app.runTurn({
    user: 'Fix this page.',
    mode: 'remediate',
    remediateInput: { sourceHtml: '<p>XXXXXXX</p>' },
  });

  const frag = view.fragments[0]!;
  assert.equal(view.iterations, 4);
  assert.equal(frag.gate.badgeWithheld, true);
  assert.equal(frag.gate.conformance.blockers.length, 3);
  assert.equal(frag.remediateResult?.after, '<p>XXX</p>');
});
