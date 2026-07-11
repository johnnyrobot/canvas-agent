import { test } from 'node:test';
import assert from 'node:assert/strict';
import { altTextIssue } from './alt-text.js';
import type { ImageAlt } from './types.js';

const img = (alt: string | null, over: Partial<ImageAlt> = {}): ImageAlt => ({
  alt,
  src: 'https://example.instructure.com/courses/1/files/9/preview',
  presentation: false,
  ...over,
});

// ── not our job: axe already owns these ───────────────────────────────────────

test('missing alt is NOT reported here — axe image-alt already blocks it', () => {
  // Double-reporting would inflate the issue count and mis-attribute "fixed".
  assert.equal(altTextIssue(img(null)), null);
});

test('empty alt is the correct decorative marker — not an issue', () => {
  assert.equal(altTextIssue(img('')), null);
  assert.equal(altTextIssue(img('', { presentation: true })), null);
});

// ── filename-as-alt: the headline defect (WAVE misses this too) ───────────────

test('filename alt is an error — real failures found in shipped courses', () => {
  for (const alt of [
    'SPEED BUMP.jpg', // art103
    'giotto_ Chapel.jpg', // art103
    'ios-icon.png', // english-102-accessible-template (!)
    'DigitalLiteracy2.jpg', // digital-literacy-2016
    'Paul Burwick (1) (1).jpg', // cvc-oei
    "'The_Prophet',_woodcut_by_Emil_Nolde,_1912.jpg", // art103
    'banner_final_v2.PNG',
    'chart.jpeg',
    'diagram.svg',
    'photo.webp',
  ]) {
    const issue = altTextIssue(img(alt));
    assert.ok(issue, `expected an issue for ${alt}`);
    assert.equal(issue.id, 'alt-text-filename');
    assert.equal(issue.severity, 'error', 'must withhold the passed-checks badge');
    assert.ok(issue.message.includes(alt), 'message should quote the offending alt');
  }
});

test('a description that merely mentions a file extension is not a filename', () => {
  // Guards against a naive /\.\w{3}$/ rule firing on real prose.
  assert.equal(altTextIssue(img('Screenshot of the settings page, showing the Export Course Content button')), null);
  assert.equal(altTextIssue(img('The .png versus .jpg tradeoff, illustrated with two sample images')), null);
});

// ── placeholder / generic ─────────────────────────────────────────────────────

test('placeholder-word alt is an error', () => {
  for (const alt of ['image', 'Image', ' photo ', 'picture', 'untitled', 'placeholder', 'graphic', 'image1', 'Screenshot']) {
    const issue = altTextIssue(img(alt));
    assert.ok(issue, `expected an issue for "${alt}"`);
    assert.equal(issue.id, 'alt-text-placeholder');
    assert.equal(issue.severity, 'error');
  }
});

test('a URL as alt is an error', () => {
  const issue = altTextIssue(img('https://example.com/a/b'));
  assert.ok(issue);
  assert.equal(issue.id, 'alt-text-url');
  assert.equal(issue.severity, 'error');
});

// ── redundant phrasing: real defect, but the alt still carries meaning ────────

test('redundant "image of" prefix is a warning, not a badge-withholding error', () => {
  for (const alt of ['image of a picture of a cat', 'Picture of the Sphinx at Giza', 'photo showing the lab bench']) {
    const issue = altTextIssue(img(alt));
    assert.ok(issue, `expected an issue for "${alt}"`);
    assert.equal(issue.id, 'alt-text-redundant');
    assert.equal(issue.severity, 'warning');
  }
});

// ── too short: judgment, so route to human review ─────────────────────────────

test('very short alt is an alert (human review), not an error', () => {
  const issue = altTextIssue(img('Map'));
  assert.ok(issue);
  assert.equal(issue.id, 'alt-text-too-short');
  assert.equal(issue.severity, 'alert', 'short-but-valid alt exists (e.g. "CEO"); do not block on it');
});

// ── good alt passes ──────────────────────────────────────────────────────────

test('specific, descriptive alt passes', () => {
  for (const alt of [
    'Bar chart of BIO 101 enrollment rising each quarter, from about 70 students in Q1 to 160 in Q4.',
    'aerial view of football field during daytime', // real, from art103
    'Boldt Castle ~ Power House ~ 1000 Islands', // real, from art103
    'Stack of books in soft pastel colors.',
  ]) {
    assert.equal(altTextIssue(img(alt)), null, `expected no issue for "${alt}"`);
  }
});

test('every issue carries a category so the WAVE-style report can group it', () => {
  const issue = altTextIssue(img('logo.png'));
  assert.ok(issue);
  assert.equal(issue.category, 'alert');
});

// ── integration: the pass reaches the gate ───────────────────────────────────

test('the auditor folds alt-quality issues in after the contrast pass', async () => {
  const { createAuditor } = await import('./auditor.js');
  const runner = {
    run: async () => ({
      axe: { violations: [], incomplete: [] },
      textRuns: [],
      images: [
        { alt: 'SPEED BUMP.jpg', src: 'a.jpg', presentation: false },
        { alt: 'A speed bump on a residential street', src: 'b.jpg', presentation: false },
        { alt: '', src: 'divider.gif', presentation: true },
      ],
    }),
  };
  const { issues } = await createAuditor(runner)('<img>');
  assert.deepEqual(
    issues.map((i) => [i.id, i.severity]),
    [['alt-text-filename', 'error']],
    'only the junk alt is reported — good alt and decorative alt="" are silent',
  );
});

test('a filename alt withholds the passed-checks badge (the hole this closes)', async () => {
  const { createAuditor } = await import('./auditor.js');
  const { enforceGate } = await import('../../orchestrator/gate.js');
  const audit = createAuditor({
    run: async () => ({
      axe: { violations: [], incomplete: [] },
      textRuns: [],
      // What a small model might DRAFT via describe_image. Before this pass,
      // axe saw "alt is present" and the gate happily badged the page.
      images: [{ alt: 'ios-icon.png', src: 'ios-icon.png', presentation: false }],
    }),
  });
  const result = await enforceGate('<img src="ios-icon.png" alt="ios-icon.png">', {
    validateAllowlist: async (html) => ({ html, removedSemantic: [] }),
    audit,
  });
  assert.equal(result.conformance.passedChecks, false);
  assert.equal(result.badgeWithheld, true);
  assert.equal(result.conformance.blockers[0]?.id, 'alt-text-filename');
});
