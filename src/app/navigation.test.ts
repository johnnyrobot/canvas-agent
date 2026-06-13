import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInAppUrl, externalOpenTarget } from './navigation.js';

const APP = 'file:///app/renderer/index.html';

test('isInAppUrl allows the app page itself and in-page anchors', () => {
  assert.equal(isInAppUrl(APP, APP), true);
  assert.equal(isInAppUrl(APP + '#section', APP), true);
  assert.equal(isInAppUrl(APP + '?q=1', APP), true);
});

test('isInAppUrl blocks navigating the privileged window off-app (C8)', () => {
  assert.equal(isInAppUrl('file:///etc/passwd', APP), false);
  assert.equal(isInAppUrl('https://evil.example', APP), false);
  assert.equal(isInAppUrl('http://evil.example', APP), false);
  assert.equal(isInAppUrl('javascript:alert(1)', APP), false);
  assert.equal(isInAppUrl('not a url', APP), false);
});

test('externalOpenTarget returns http(s) URLs to hand to the OS browser', () => {
  assert.equal(externalOpenTarget('https://canvas.example/page'), 'https://canvas.example/page');
  assert.equal(externalOpenTarget('http://x.test/'), 'http://x.test/');
});

test('externalOpenTarget denies non-web schemes — no in-app open either (C8)', () => {
  assert.equal(externalOpenTarget('javascript:alert(1)'), null);
  assert.equal(externalOpenTarget('file:///etc/passwd'), null);
  assert.equal(externalOpenTarget('data:text/html,<script>x</script>'), null);
  assert.equal(externalOpenTarget('not a url'), null);
});
