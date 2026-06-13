/**
 * Unit tests for `createAuditor` — the pure mapping core (axe results + computed
 * contrast pairs → IssueSet). Driven entirely by a FAKE ScanRunner, so these run
 * fully offline with NO browser. This is the bulk of the track's coverage.
 * Strict TDD: written before the implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuditor } from './auditor.js';
import type { AxeImpact, AxeResult, AxeResults, ScanRunner, TextRun } from './types.js';

// ── Fake runner helpers ──────────────────────────────────────────────────────

function fakeRunner(axe: Partial<AxeResults>, textRuns: TextRun[] = []): ScanRunner {
  const base: AxeResults = { violations: [], incomplete: [], passes: [], inapplicable: [] };
  return { run: async () => ({ axe: { ...base, ...axe }, textRuns }) };
}

/** Build a solid-background text run (the common case in these tests). */
function solid(fg: string, bg: string, size: 'normal' | 'large' = 'normal'): TextRun {
  return { fg, size, background: { kind: 'layers', layers: [bg] } };
}

function violation(id: string, impact: AxeImpact, description = `desc:${id}`): AxeResult {
  return { id, impact, description, help: `help:${id}`, nodes: [] };
}

const audit = (axe: Partial<AxeResults>, runs?: TextRun[]) =>
  createAuditor(fakeRunner(axe, runs))('<p>x</p>');

// ── axe impact → severity ────────────────────────────────────────────────────

test('axe critical/serious/moderate/minor → blocker/error/warning/advisory', async () => {
  const { issues } = await audit({
    violations: [
      violation('vc', 'critical'),
      violation('vs', 'serious'),
      violation('vm', 'moderate'),
      violation('vn', 'minor'),
    ],
  });
  assert.deepEqual(
    issues.map((i) => [i.id, i.severity]),
    [
      ['vc', 'blocker'],
      ['vs', 'error'],
      ['vm', 'warning'],
      ['vn', 'advisory'],
    ],
  );
});

test('a violation with null/omitted impact maps to the default severity (error)', async () => {
  const { issues } = await audit({
    violations: [
      { id: 'noimpact-null', impact: null, description: 'd', nodes: [] },
      { id: 'noimpact-omit', description: 'd', nodes: [] },
    ],
  });
  assert.deepEqual(issues.map((i) => i.severity), ['error', 'error']);
});

// ── incomplete / needs-review → alert ────────────────────────────────────────

test('incomplete (needs-review) results map to severity alert', async () => {
  const { issues } = await audit({
    incomplete: [{ id: 'maybe', impact: 'serious', description: 'review me', nodes: [] }],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'alert');
  // severity is alert regardless of the (serious) impact.
});

test('an unclassified incomplete result gets category alert; a classified one keeps its category', async () => {
  const { issues } = await audit({
    incomplete: [
      { id: 'opaque-rule', impact: 'minor', description: 'd', nodes: [] },
      { id: 'color-contrast', impact: 'serious', description: 'd', nodes: [] },
    ],
  });
  assert.equal(issues[0]?.category, 'alert');
  assert.equal(issues[0]?.severity, 'alert');
  assert.equal(issues[1]?.category, 'contrast');
  assert.equal(issues[1]?.severity, 'alert');
});

// ── category mapping for representative rules ────────────────────────────────

test('category mapping (contrast/aria/structure/error) for representative violations', async () => {
  const { issues } = await audit({
    violations: [
      violation('color-contrast', 'serious'),
      violation('aria-required-children', 'critical'),
      violation('heading-order', 'moderate'),
      violation('image-alt', 'critical'),
    ],
  });
  assert.deepEqual(
    issues.map((i) => [i.id, i.category]),
    [
      ['color-contrast', 'contrast'],
      ['aria-required-children', 'aria'],
      ['heading-order', 'structure'],
      ['image-alt', 'error'],
    ],
  );
});

// ── message extraction ───────────────────────────────────────────────────────

test('message is the axe human description', async () => {
  const { issues } = await audit({
    violations: [{ id: 'image-alt', impact: 'critical', description: 'Images must have alternate text', nodes: [] }],
  });
  assert.equal(issues[0]?.message, 'Images must have alternate text');
});

test('message falls back to help, then to the rule id, when description is absent', async () => {
  const { issues } = await audit({
    violations: [
      { id: 'only-help', impact: 'minor', help: 'help text', nodes: [] },
      { id: 'bare-rule', impact: 'minor', nodes: [] },
    ],
  });
  assert.equal(issues[0]?.message, 'help text');
  assert.equal(issues[1]?.message, 'bare-rule');
});

// ── computed contrast pass ───────────────────────────────────────────────────

test('a solid pair that fails AA yields a blocking contrast issue by default', async () => {
  const { issues } = await audit({}, [solid('#999999', '#ffffff')]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.id, 'contrast');
  assert.equal(issues[0]?.category, 'contrast');
  assert.equal(issues[0]?.severity, 'blocker');
  assert.match(issues[0]?.message ?? '', /2\.85/);
});

test('a solid pair that passes AA yields no contrast issue', async () => {
  const { issues } = await audit({}, [solid('#666666', '#ffffff'), solid('#000000', '#ffffff')]);
  assert.deepEqual(issues, []);
});

test('contrast verdict is size-driven (large passes where normal fails)', async () => {
  assert.deepEqual((await audit({}, [solid('#808080', '#ffffff', 'large')])).issues, []);
  const normal = await audit({}, [solid('#808080', '#ffffff', 'normal')]);
  assert.equal(normal.issues.length, 1);
  assert.equal(normal.issues[0]?.category, 'contrast');
});

test('an unresolvable run becomes a needs-review alert, never a silent pass', async () => {
  const { issues } = await audit({}, [{ fg: '#000000', size: 'normal', background: { kind: 'unresolvable', reason: 'css filter' } }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'alert');
  assert.equal(issues[0]?.category, 'contrast');
});

test('a failing gradient run blocks; a failing image run only warns (severity by certainty)', async () => {
  const grad = await audit({}, [{ fg: '#000000', size: 'normal', background: { kind: 'gradient', css: 'linear-gradient(90deg, #ffffff, #222222)' } }]);
  assert.equal(grad.issues[0]?.severity, 'blocker');

  const image = await audit({}, [{ fg: '#ffffff', size: 'normal', background: { kind: 'image', swatches: ['rgb(240, 240, 240)'] } }]);
  assert.equal(image.issues[0]?.severity, 'warning');
});

test('contrastFailSeverity overrides the deterministic blocking default', async () => {
  const auditor = createAuditor(fakeRunner({}, [solid('#999999', '#ffffff')]), { contrastFailSeverity: 'error' });
  const { issues } = await auditor('<p>x</p>');
  assert.equal(issues[0]?.severity, 'error');
});

// ── empty / combined ─────────────────────────────────────────────────────────

test('clean input → { issues: [] }', async () => {
  const { issues } = await audit({});
  assert.deepEqual(issues, []);
});

test('violations, incompletes and contrast failures combine in a stable order', async () => {
  const { issues } = await audit(
    {
      violations: [violation('image-alt', 'critical')],
      incomplete: [{ id: 'color-contrast', impact: 'serious', description: 'd', nodes: [] }],
    },
    [solid('#999999', '#ffffff')],
  );
  assert.deepEqual(
    issues.map((i) => [i.id, i.severity]),
    [
      ['image-alt', 'blocker'], // violations first
      ['color-contrast', 'alert'], // then incompletes
      ['contrast', 'blocker'], // then computed contrast
    ],
  );
});

test('the auditor satisfies the frozen Auditor port shape', async () => {
  const result = await createAuditor(fakeRunner({}))('<p>ok</p>');
  assert.ok(Array.isArray(result.issues));
});
