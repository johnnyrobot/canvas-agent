import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAllowlist } from './allowlist.js';

// ── Clean, allowed markup passes through unchanged ───────────────────────────

test('allowed markup passes through unchanged', async () => {
  const inputs = [
    '<h2>Welcome</h2>',
    '<p class="lead">Hi <strong>there</strong>, see <em>this</em>.</p>',
    '<ul><li>one</li><li>two</li></ul>',
    '<a href="https://example.com" target="_blank">Course site</a>',
    '<table summary="grades"><caption>Grades</caption><thead><tr><th scope="col">Item</th></tr></thead><tbody><tr><td>HW1</td></tr></tbody></table>',
    '<p style="color: red; margin: 0">styled</p>',
  ];
  for (const html of inputs) {
    const r = await validateAllowlist(html);
    assert.equal(r.html, html, `expected unchanged for: ${html}`);
    assert.deepEqual(r.removedSemantic, []);
  }
});

// ── Dangerous elements are removed with their contents ───────────────────────

test('<script> is removed entirely, contents and all', async () => {
  const r = await validateAllowlist('<p>before</p><script>alert("x")</script><p>after</p>');
  assert.equal(r.html, '<p>before</p><p>after</p>');
  assert.ok(!r.html.includes('alert'));
  assert.deepEqual(r.removedSemantic, []); // script is not semantic content
});

test('<style> blocks are removed entirely (no inline CSS leaks as text)', async () => {
  const r = await validateAllowlist('<style>.x{color:red}</style><p>hi</p>');
  assert.equal(r.html, '<p>hi</p>');
  assert.ok(!r.html.includes('color:red'));
});

// ── RCDATA/RAWTEXT characterization (textarea/title/noscript/xmp/plaintext) ──
// These five tags are RCDATA/RAWTEXT/PLAINTEXT in the HTML spec, but the tokenizer
// models only script/style as raw-text, so their *contents* are parsed as markup
// (a known, latent fidelity gap). This PINS today's output so a future tokenizer
// change is caught — and asserts the load-bearing invariant regardless: no
// executable attribute or URL ever survives the allowlist for any of them.
test('RCDATA/RAWTEXT tags: output is pinned and no executable vector survives', async () => {
  const cases: { in: string; out: string; removed: string[] }[] = [
    { in: '<textarea onfocus="alert(1)"><script>alert(2)</script></textarea>', out: '', removed: ['textarea'] },
    { in: '<title>hi<img src=x onerror=alert(1)></title>', out: 'hi<img src="x">', removed: [] },
    { in: '<noscript><img src=x onerror=alert(1)></noscript>', out: '<img src="x">', removed: [] },
    { in: '<xmp><script>alert(1)</script></xmp>', out: '', removed: [] },
    { in: '<plaintext><script>alert(1)</script>', out: '', removed: [] },
  ];
  for (const c of cases) {
    const r = await validateAllowlist(c.in);
    assert.equal(r.html, c.out, `pinned output for: ${c.in}`);
    assert.deepEqual(r.removedSemantic, c.removed, `pinned removedSemantic for: ${c.in}`);
    // Invariant — must hold even if the pinned output above ever legitimately shifts:
    assert.ok(!/<script/i.test(r.html), `no <script> survives: ${c.in}`);
    assert.ok(!/\son\w+\s*=/i.test(r.html), `no inline event handler survives: ${c.in}`);
    assert.ok(!/javascript:/i.test(r.html), `no javascript: URL survives: ${c.in}`);
  }
});

test('a javascript: href is stripped even adjacent to a removed RCDATA tag', async () => {
  const r = await validateAllowlist('<textarea>x</textarea><a href="javascript:alert(1)">y</a>');
  assert.equal(r.html, 'x<a>y</a>');
  assert.ok(!/javascript:/i.test(r.html));
});

test('HTML comments and doctype declarations are dropped', async () => {
  const r = await validateAllowlist('<!DOCTYPE html><p>a<!-- secret -->b</p>');
  assert.equal(r.html, '<p>ab</p>');
});

// ── Attribute filtering ──────────────────────────────────────────────────────

test('on* event handlers are stripped', async () => {
  const r = await validateAllowlist('<a href="https://x.test" onclick="evil()" onmouseover="x()">y</a>');
  assert.equal(r.html, '<a href="https://x.test">y</a>');
});

test('attributes not on the per-element allowlist are stripped (incl. rel on <a>)', async () => {
  const r = await validateAllowlist('<a href="https://x.test" target="_blank" rel="noopener" data-bogus="1" foo="bar">y</a>');
  // href + target are allowed; rel/foo are not. data-* is kept (Canvas-safe, see README).
  assert.equal(r.html, '<a href="https://x.test" target="_blank" data-bogus="1">y</a>');
});

test('global + ARIA attributes are preserved', async () => {
  const html = '<div class="c" id="i" title="t" role="note" lang="en" dir="ltr" aria-label="hello" aria-hidden="true">x</div>';
  const r = await validateAllowlist(html);
  assert.equal(r.html, html);
});

test('data-* attributes (e.g. Canvas equation images) are preserved', async () => {
  const html = '<img src="https://canvas.test/eq.png" alt="LaTeX: x" data-equation-content="x" data-ignore-a11y-check="">';
  const r = await validateAllowlist(html);
  assert.ok(r.html.includes('data-equation-content="x"'));
  assert.ok(r.html.includes('data-ignore-a11y-check'));
});

// ── URL protocol gating (B.4) ────────────────────────────────────────────────

test('disallowed URL schemes are stripped from href/src', async () => {
  assert.equal((await validateAllowlist('<a href="javascript:alert(1)">y</a>')).html, '<a>y</a>');
  assert.equal((await validateAllowlist('<a href="vbscript:x">y</a>')).html, '<a>y</a>');
  assert.equal((await validateAllowlist('<img src="data:image/png;base64,AAAA" alt="">')).html, '<img alt="">');
  assert.equal((await validateAllowlist('<img src="file:///etc/passwd" alt="">')).html, '<img alt="">');
});

test('entity-obfuscated and whitespace-obfuscated javascript: is still stripped', async () => {
  assert.equal((await validateAllowlist('<a href="javascript&#58;alert(1)">y</a>')).html, '<a>y</a>');
  assert.equal((await validateAllowlist('<a href="  java\tscript:alert(1)">y</a>')).html, '<a>y</a>');
  assert.equal((await validateAllowlist('<a href="JavaScript:alert(1)">y</a>')).html, '<a>y</a>');
});

test('allowed schemes and relative URLs survive', async () => {
  assert.ok((await validateAllowlist('<a href="https://x.test">y</a>')).html.includes('href="https://x.test"'));
  assert.ok((await validateAllowlist('<a href="mailto:a@b.test">y</a>')).html.includes('mailto:'));
  assert.ok((await validateAllowlist('<a href="ftp://x.test/f">y</a>')).html.includes('ftp://'));
  assert.ok((await validateAllowlist('<a href="/courses/1/pages/x">y</a>')).html.includes('href="/courses/1/pages/x"'));
  assert.ok((await validateAllowlist('<a href="#section">y</a>')).html.includes('href="#section"'));
});

// ── Inline style property filtering (B.5) ────────────────────────────────────

test('disallowed style properties are dropped, allowed ones (and longhands) kept', async () => {
  const r = await validateAllowlist('<p style="color: red; box-shadow: 0 0 5px #000; background-color: blue; transform: scale(2)">x</p>');
  assert.ok(r.html.includes('color: red'));
  assert.ok(r.html.includes('background-color: blue')); // longhand of allowed `background`
  assert.ok(!r.html.includes('box-shadow'));
  assert.ok(!r.html.includes('transform'));
});

test('a style attribute with only disallowed props is removed entirely', async () => {
  const r = await validateAllowlist('<p style="box-shadow: 0 0 1px #000">y</p>');
  assert.equal(r.html, '<p>y</p>');
});

test('url() inside a style value is scheme-checked', async () => {
  const ok = await validateAllowlist('<div style="background: url(https://x.test/bg.png)">x</div>');
  assert.ok(ok.html.includes('url(https://x.test/bg.png)'));
  const bad = await validateAllowlist('<div style="background: url(javascript:alert(1))">x</div>');
  assert.equal(bad.html, '<div>x</div>');
});

// ── h1 remap (B.6.2) ─────────────────────────────────────────────────────────

test('<h1> is remapped to <h2> and is NOT reported as removed-semantic', async () => {
  const r = await validateAllowlist('<h1>Page Title</h1><p>body</p>');
  assert.equal(r.html, '<h2>Page Title</h2><p>body</p>');
  assert.deepEqual(r.removedSemantic, []);
});

// ── Unwrap vs. semantic removal ──────────────────────────────────────────────

test('a disallowed decorative wrapper is unwrapped (children kept), not flagged', async () => {
  const r = await validateAllowlist('<center><p>keep me</p></center>');
  assert.equal(r.html, '<p>keep me</p>');
  assert.deepEqual(r.removedSemantic, []);
});

test('disallowed semantic elements are unwrapped AND reported in removedSemantic', async () => {
  // <figure>/<figcaption> are semantic but NOT on the Canvas allowlist (App. B.1).
  const r = await validateAllowlist('<figure><img src="https://x.test/p.png" alt="A chart"><figcaption>Fig 1</figcaption></figure>');
  assert.ok(r.html.includes('<img src="https://x.test/p.png" alt="A chart">'));
  assert.ok(r.html.includes('Fig 1')); // caption text preserved as content
  assert.ok(r.removedSemantic.includes('figure'));
  assert.ok(r.removedSemantic.includes('figcaption'));
});

test('removedSemantic lists each semantic tag once (deduped, first-seen order)', async () => {
  const r = await validateAllowlist('<figure>a</figure><figure>b</figure>');
  assert.deepEqual(r.removedSemantic, ['figure']);
});

// ── Malformed / nested edge cases ────────────────────────────────────────────

test('mismatched and stray tags are repaired', async () => {
  assert.equal((await validateAllowlist('<b><i>x</b></i>')).html, '<b><i>x</i></b>');
  assert.equal((await validateAllowlist('</div>hello')).html, 'hello');
  assert.equal((await validateAllowlist('<strong>unclosed')).html, '<strong>unclosed</strong>');
});

test('void elements serialize stably (self-closing slash normalized away)', async () => {
  assert.equal((await validateAllowlist('<img src="https://x.test/a.png" alt="A" />')).html, '<img src="https://x.test/a.png" alt="A">');
  assert.equal((await validateAllowlist('<p>a<br/>b</p>')).html, '<p>a<br>b</p>');
});

test('boolean attributes survive without being given a value', async () => {
  const r = await validateAllowlist('<video src="https://x.test/v.mp4" controls muted></video>');
  assert.ok(r.html.includes('controls'));
  assert.ok(r.html.includes('muted'));
  assert.ok(!r.html.includes('controls="'));
});

// ── Idempotence ──────────────────────────────────────────────────────────────

test('repair is idempotent: running twice equals running once', async () => {
  const messy = '<h1>T</h1><center><figure><img src="javascript:x" alt="" onclick="e()"><figcaption>c</figcaption></figure></center><script>bad()</script><p style="box-shadow:0 0 1px #000;color:red">ok</p>';
  const once = await validateAllowlist(messy);
  const twice = await validateAllowlist(once.html);
  assert.equal(twice.html, once.html);
});

test('text entities round-trip without double-escaping', async () => {
  const r = await validateAllowlist('<p>a &amp; b &lt; c</p>');
  const r2 = await validateAllowlist(r.html);
  assert.equal(r.html, r2.html);
  assert.ok(r.html.includes('&amp;'));
  assert.ok(r.html.includes('&lt;'));
});

// ── C13: deep nesting must not overflow the stack (iterative traversal) ───────

test('deeply nested HTML does not overflow the stack and round-trips (C13)', async () => {
  // Remediate feeds arbitrary external HTML (converted PDFs/Office docs, pastes)
  // through the gate synchronously; per-depth recursion in transform()/serialize()
  // threw RangeError on legitimately deep documents, so the gate could never
  // process them. Traversal must be iterative.
  const depth = 20000;
  const html = '<div>'.repeat(depth) + 'x' + '</div>'.repeat(depth);
  const r = await validateAllowlist(html);
  assert.equal(r.html, html); // byte-for-byte round-trip
  assert.deepEqual(r.removedSemantic, []); // div is not semantic
});

test('iterative transform preserves post-order removedSemantic for nested semantic tags (C13)', async () => {
  // The recursive baseline records inner-tag-before-outer (children transformed
  // first). The iterative rewrite must keep that exact order — a pre-order rewrite
  // would silently change output and the diff semantics downstream.
  assert.deepEqual(
    (await validateAllowlist('<main><figure>x</figure></main>')).removedSemantic,
    ['figure', 'main'],
  );
  assert.deepEqual(
    (await validateAllowlist('<figure><figcaption>x</figcaption></figure>')).removedSemantic,
    ['figcaption', 'figure'],
  );
});

// ── C15: repair must not degrade structure ───────────────────────────────────

test('demoting a content h1 shifts the WHOLE heading hierarchy, preserving subordination (C15)', async () => {
  // Canvas renders the page title as the <h1>, so a content <h1> is demoted. Demoting
  // ONLY <h1> (h1,h2 -> h2,h2) orphaned subsections and could manufacture heading-order
  // violations the auditor then blocks; the whole hierarchy must shift together.
  const r = await validateAllowlist('<h1>Title</h1><h2>Section</h2><h3>Sub</h3>');
  assert.equal(r.html, '<h2>Title</h2><h3>Section</h3><h4>Sub</h4>');
});

test('heading levels are left unchanged when the document has no h1 (C15)', async () => {
  const r = await validateAllowlist('<h2>A</h2><h3>B</h3>');
  assert.equal(r.html, '<h2>A</h2><h3>B</h3>');
});

test('heading shift clamps at h6, never emitting an illegal h7 (C15)', async () => {
  const r = await validateAllowlist('<h1>A</h1><h5>B</h5><h6>C</h6>');
  assert.equal(r.html, '<h2>A</h2><h6>B</h6><h6>C</h6>');
});

test('flattening a form control is reported as semantic loss (a blocker) (C15)', async () => {
  // Canvas strips form controls; unwrapping them silently dropped the
  // "removing a semantic element is a blocker" guarantee. They must be flagged.
  const r = await validateAllowlist(
    '<form><fieldset><label>Name <input></label><button>Go</button></fieldset></form>',
  );
  for (const tag of ['form', 'fieldset', 'label', 'input', 'button']) {
    assert.ok(r.removedSemantic.includes(tag), `expected ${tag} in removedSemantic`);
  }
});

// ── Lower-severity allowlist hardening (L1 / L2 / L3) ────────────────────────

test('raw-text close tag with trailing junk closes the element, not EOF (L1)', async () => {
  // `</script foo>` is a valid (if bogus) end tag — content after it must survive,
  // not be swallowed to EOF as raw text.
  const r = await validateAllowlist('<p>before</p><script>x</script foo><p>after</p>');
  assert.equal(r.html, '<p>before</p><p>after</p>');
  // …but a different name like `</scriptfoo>` must NOT close <script> early.
  const guard = await validateAllowlist('<p>a</p><script>var s="</scriptfoo>"; y</script><p>b</p>');
  assert.equal(guard.html, '<p>a</p><p>b</p>');
});

test('object codebase/classid and embed pluginspage are URL-scheme-gated (L2)', async () => {
  assert.equal(
    (await validateAllowlist('<embed src="https://x.test" pluginspage="javascript:alert(1)">')).html,
    '<embed src="https://x.test">',
  );
  assert.equal(
    (await validateAllowlist('<object data="https://x.test" codebase="javascript:alert(1)"></object>')).html,
    '<object data="https://x.test"></object>',
  );
  assert.equal(
    (await validateAllowlist('<object data="https://x.test" classid="data:text/html,evil"></object>')).html,
    '<object data="https://x.test"></object>',
  );
});

test('a ";" inside a url() style value is preserved, not truncated (L3)', async () => {
  const r = await validateAllowlist('<div style="background: url(https://x.test/a;v=2.png); color: red">x</div>');
  assert.ok(r.html.includes('url(https://x.test/a;v=2.png)'), `url truncated: ${r.html}`);
  assert.ok(r.html.includes('color: red'));
});

test('a non-http scheme in ANY url() of a declaration drops it (L3 multi-url)', async () => {
  const r = await validateAllowlist(
    '<div style="background: image-set(url(https://x.test/a.png), url(javascript:alert(1)))">x</div>',
  );
  assert.ok(!r.html.includes('javascript:'), `javascript: leaked: ${r.html}`);
});
