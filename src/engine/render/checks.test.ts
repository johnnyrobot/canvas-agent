/**
 * Tests for the check registry (ADR-0003).
 *
 * What matters here is the REGISTRY MECHANISM — that the auditor iterates a
 * list rather than hardcoding one numbered pass per rule, that each check sees
 * the whole `ScanResult`, and that a check needing page data nobody collects
 * yet can add an OPTIONAL `ScanResult` field without breaking every existing
 * fixture. The rules themselves are tested in `run-contrast.test.ts`,
 * `alt-text.test.ts` and `auditor.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditIssue } from '../../contracts/index.js';
import { createAuditor } from './auditor.js';
import {
  CHECKS,
  altTextQuality,
  axeIncomplete,
  axeViolations,
  computedContrast,
  type Check,
} from './checks.js';
import type { ScanResult, ScanRunner } from './types.js';

const EMPTY: ScanResult = { axe: { violations: [] }, textRuns: [] };

const runnerFor = (scan: Partial<ScanResult> = {}): ScanRunner => ({
  run: async () => ({ ...EMPTY, ...scan }),
});

test('the registry is the single place a check is registered', () => {
  // The ADR's whole claim is "edit one place, not seven". Pinning the contents
  // by identity is what makes a check that gets dropped, duplicated, or
  // reordered fail here rather than silently stop running.
  assert.deepEqual(
    [...CHECKS],
    [axeViolations, axeIncomplete, computedContrast, altTextQuality],
    'the registry holds exactly the four deterministic checks, in reporting order',
  );
});

test('the auditor runs every registered check and concatenates their issues', async () => {
  const issueFrom =
    (id: string): Check =>
    () => [{ id, severity: 'warning', message: id, category: 'alert' }];
  const audit = createAuditor(runnerFor(), { checks: [issueFrom('one'), issueFrom('two')] });

  const { issues } = await audit('<p>x</p>');

  assert.deepEqual(
    issues.map((i) => i.id),
    ['one', 'two'],
    'both checks ran, in registration order',
  );
});

test('a check receives the WHOLE ScanResult, not a hand-picked slice', async () => {
  let seen: ScanResult | undefined;
  const spy: Check = (scan) => {
    seen = scan;
    return [];
  };
  const scan: ScanResult = {
    axe: { violations: [{ id: 'region', impact: 'moderate' }] },
    textRuns: [{ fg: '#000', size: 'normal', background: { kind: 'layers', layers: ['#fff'] } }],
    images: [{ alt: 'ok', src: 'a.png', presentation: false }],
  };
  const audit = createAuditor(runnerFor(scan), { checks: [spy] });

  await audit('<p>x</p>');

  assert.deepEqual(seen, scan, 'the check can reach any field it needs, present or future');
});

test('a check can read an OPTIONAL field a fixture never set (the ADR-0003 rule)', async () => {
  // This is the property that makes adding a check cheap: the new field is
  // optional, so every existing fake keeps compiling and keeps passing.
  const usesNewData: Check = (scan) =>
    (scan.images ?? []).map((i) => ({
      id: 'saw-image',
      severity: 'alert' as const,
      message: i.src,
      category: 'alert' as const,
    }));

  const withoutImages = createAuditor(runnerFor(), { checks: [usesNewData] });
  assert.deepEqual((await withoutImages('<p>x</p>')).issues, [], 'absent field → no issues, no crash');

  const withImages = createAuditor(
    runnerFor({ images: [{ alt: '', src: 'x.png', presentation: false }] }),
    { checks: [usesNewData] },
  );
  assert.deepEqual((await withImages('<p>x</p>')).issues.map((i) => i.message), ['x.png']);
});

test('a scan with NO images field still runs the real alt-text check safely', async () => {
  // `ScanResult.images` was retrofitted to optional in this lane; the real
  // registry must not assume it is there.
  const audit = createAuditor(runnerFor());
  const { issues } = await audit('<p>x</p>');
  assert.deepEqual(issues, [], 'a bare scan audits clean rather than throwing');
});

test('the registered checks still produce the same issues as the hardcoded passes did', async () => {
  // Characterization across the whole default registry: one axe violation, one
  // axe incomplete, one failing contrast run, one junk alt — the four things
  // the numbered passes used to do, in the same order.
  const audit = createAuditor(
    runnerFor({
      axe: {
        violations: [{ id: 'image-alt', impact: 'critical' }],
        incomplete: [{ id: 'color-contrast', impact: 'serious' }],
      },
      textRuns: [{ fg: '#999999', size: 'normal', background: { kind: 'layers', layers: ['#ffffff'] } }],
      images: [{ alt: 'SPEED BUMP.jpg', src: 'SPEED BUMP.jpg', presentation: false }],
    }),
  );

  const { issues } = await audit('<p>x</p>');

  // Asserted as an exact SEQUENCE, not a set: the registry defines reporting
  // order, so a reordered `CHECKS` has to fail here rather than pass on
  // presence alone.
  assert.deepEqual(
    issues.map((i: AuditIssue) => [i.id, i.category, i.severity]),
    [
      ['image-alt', 'error', 'blocker'], // [1] axe violations
      ['color-contrast', 'contrast', 'alert'], // [2] axe incompletes
      ['contrast', 'contrast', 'blocker'], // [3] computed contrast
      ['alt-text-filename', 'error', 'error'], // [4] alt-text quality
    ],
  );
});
