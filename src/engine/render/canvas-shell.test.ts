import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapInCanvasShell, CANVAS_SHELL_CSS } from './canvas-shell.js';
import { previewSrcdoc } from '../../app/renderer/preview.js';

test('the audited Canvas shell carries the full Canvas content CSS, not a bare body (§9a)', () => {
  // The audit must render with the SAME element styling the user sees, so contrast
  // is checked against the real link/table/button/blockquote colors — not a bare page.
  const css = CANVAS_SHELL_CSS;
  // bare-shell baseline (already audited before)
  assert.match(css, /background:#ffffff/);
  assert.match(css, /color:#2d3b45/);
  // element styling that previously ONLY the preview applied (the §9a gap)
  assert.match(css, /a\{color:#0374b5/);
  assert.match(css, /th\{background:#f5f5f5/);
  assert.match(css, /button[^}]*background:#0374b5/);
  assert.match(css, /blockquote\{[^}]*color:#54616a/);
});

test('preview/export renders the byte-identical shell the auditor scans (§9a parity)', () => {
  const frag = '<h2>Title</h2><a href="#">link</a><table><tr><th>H</th></tr></table><blockquote>q</blockquote>';
  assert.equal(previewSrcdoc(frag), wrapInCanvasShell(frag));
});

test('the shell wraps the fragment in the audit document structure (#content)', () => {
  const doc = wrapInCanvasShell('<p>hi</p>');
  assert.match(doc, /^<!DOCTYPE html><html lang="en">/);
  assert.match(doc, /<div id="content"><p>hi<\/p><\/div>/);
});
