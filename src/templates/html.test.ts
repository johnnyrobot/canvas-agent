import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeText, escapeAttr, styleValue, el, txt } from './html.js';

test('escapeText escapes &, <, > but leaves quotes alone (matches engine serializer)', () => {
  assert.equal(escapeText('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d "e"');
  // Idempotent-shaped: a bare ampersand always becomes a single &amp;.
  assert.equal(escapeText('AT&T'), 'AT&amp;T');
});

test('escapeAttr escapes &, <, > and double quotes', () => {
  assert.equal(escapeAttr('x"&<>'), 'x&quot;&amp;&lt;&gt;');
});

test('styleValue builds canonical "prop: val; prop: val" declarations', () => {
  assert.equal(
    styleValue([['color', '#fff'], ['Background', '#000']]),
    'color: #fff; background: #000',
  );
});

test('styleValue lowercases properties, trims values, and drops empties', () => {
  assert.equal(styleValue([['color', '  #abc  '], ['padding', '']]), 'color: #abc');
  assert.equal(styleValue([]), '');
});

test('el omits null/undefined attrs and an empty style, and escapes attr values', () => {
  assert.equal(
    el('p', { id: 'x', class: null, style: '', title: 'a "b"' }, txt('hi')),
    '<p id="x" title="a &quot;b&quot;">hi</p>',
  );
});

test('el preserves attribute insertion order', () => {
  assert.equal(el('th', { scope: 'col', class: 'c' }, txt('H')), '<th scope="col" class="c">H</th>');
});

test('el renders void elements with no closing tag', () => {
  assert.equal(el('hr', {}), '<hr>');
});

test('el joins array children with no separator (compact, no whitespace)', () => {
  assert.equal(
    el('ul', {}, [el('li', {}, txt('a')), el('li', {}, txt('b'))]),
    '<ul><li>a</li><li>b</li></ul>',
  );
});

test('txt escapes its input', () => {
  assert.equal(txt('1 < 2 & 3'), '1 &lt; 2 &amp; 3');
});
