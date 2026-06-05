import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeIntent } from './router.js';
import type { ProductMode } from '../contracts/index.js';

test('an explicit override always wins with full confidence', () => {
  const modes: ProductMode[] = ['guidance', 'build', 'remediate'];
  for (const mode of modes) {
    // Use a message whose own signals would point elsewhere, to prove override wins.
    const d = routeIntent('please create a syllabus <table>', mode);
    assert.equal(d.mode, mode);
    assert.equal(d.confidence, 1);
    assert.equal(d.reason, 'explicit override');
  }
});

test('pasted HTML routes to remediate', () => {
  const d = routeIntent('Here is my page:\n<div><img src="x"><p>hello</p></div>');
  assert.equal(d.mode, 'remediate');
  assert.equal(d.reason, 'detected pasted HTML to repair');
  assert.ok(d.confidence > 0.5 && d.confidence <= 0.95);
});

test('HTML detection is case-insensitive', () => {
  assert.equal(routeIntent('<TABLE><TR><TD>x</TD></TR></TABLE>').mode, 'remediate');
});

test('remediation vocabulary (no HTML) routes to remediate', () => {
  for (const msg of [
    'can you fix the contrast on this?',
    'this page is broken for screen readers',
    'add alt text please',
    'make it WCAG compliant',
    'improve accessibility here',
  ]) {
    assert.equal(routeIntent(msg).mode, 'remediate', msg);
  }
});

test('build vocabulary routes to build', () => {
  for (const msg of [
    'create a new module overview',
    'build me a quiz',
    'draft a rubric for the essay',
    'generate an assignment page',
  ]) {
    assert.equal(routeIntent(msg).mode, 'build', msg);
  }
});

test('ambiguous input falls back to guidance', () => {
  const d = routeIntent('what does universal design for learning mean?');
  assert.equal(d.mode, 'guidance');
  assert.equal(d.confidence, 0.5);
});

test('strong remediation signal beats build signal (precedence)', () => {
  // "create" is a build word, but the strong repair intent should dominate.
  assert.equal(routeIntent('fix this page I want to create').mode, 'remediate');
});

test('an authoring verb beats weak a11y words (create an accessible page ⇒ build)', () => {
  // Regression: "accessible"/"contrast" alone must not hijack an authoring request.
  for (const msg of [
    'Create an accessible Canvas module-overview page titled "Photosynthesis"',
    'make an accessible syllabus with good contrast',
    'build a high-contrast quiz',
  ]) {
    assert.equal(routeIntent(msg).mode, 'build', msg);
  }
});

test('confidence rises with more matched signals', () => {
  const one = routeIntent('build a page');
  const more = routeIntent('build, create, and generate a quiz module');
  assert.ok(more.confidence >= one.confidence);
});

test('decisions are deterministic and pure', () => {
  const a = routeIntent('create a syllabus');
  const b = routeIntent('create a syllabus');
  assert.deepEqual(a, b);
});
