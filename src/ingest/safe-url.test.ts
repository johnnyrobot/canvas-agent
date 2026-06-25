import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeIngestUrl, IngestUrlError } from './safe-url.js';

test('allows ordinary public http(s) URLs', () => {
  for (const ok of [
    'https://example.com/syllabus.pdf',
    'http://example.org/a/b/c.docx',
    'https://files.example.edu:8443/x.pptx',
    'https://sub.domain.example.com/doc',
  ]) {
    assert.doesNotThrow(() => assertSafeIngestUrl(ok), `should allow ${ok}`);
  }
});

test('rejects non-http(s) schemes (file/gopher/data/ftp)', () => {
  for (const bad of [
    'file:///etc/passwd',
    'gopher://127.0.0.1/',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/x',
  ]) {
    assert.throws(() => assertSafeIngestUrl(bad), IngestUrlError, `should reject ${bad}`);
  }
});

test('rejects the cloud metadata endpoint (link-local 169.254.169.254)', () => {
  assert.throws(() => assertSafeIngestUrl('http://169.254.169.254/latest/meta-data/'), IngestUrlError);
});

test('rejects loopback in every spelling the URL parser canonicalizes', () => {
  for (const bad of [
    'http://127.0.0.1/',
    'http://127.1/', // shorthand → 127.0.0.1
    'http://localhost/',
    'http://2130706433/', // decimal integer → 127.0.0.1
    'http://0x7f000001/', // hex → 127.0.0.1
    'http://0177.0.0.1/', // octal → 127.0.0.1
    'http://[::1]/', // IPv6 loopback
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6 loopback
    'http://localhost./', // trailing root-label dot must not bypass the check
    'http://127.0.0.1./', // trailing-dot IPv4 must not bypass either
  ]) {
    assert.throws(() => assertSafeIngestUrl(bad), IngestUrlError, `should reject ${bad}`);
  }
});

test('error message does not leak credentials, path, or query tokens', () => {
  // The full userinfo (username AND password) must never appear in the message.
  assert.throws(
    () => assertSafeIngestUrl('http://user:s3cr3t@example.com/'),
    (e: unknown) =>
      e instanceof IngestUrlError && !/user/i.test(e.message) && !/s3cr3t/i.test(e.message) && !/@/.test(e.message),
    'full userinfo must not leak into the error',
  );
  // A blocked host carrying a signed-token query must not echo the token/path.
  assert.throws(
    () => assertSafeIngestUrl('http://169.254.169.254/latest/meta-data/?token=AKIASECRET'),
    (e: unknown) =>
      e instanceof IngestUrlError && !/AKIASECRET/.test(e.message) && !/meta-data/.test(e.message),
    'query token and path must not leak into the error',
  );
});

test('rejects private and reserved ranges (RFC1918, CGNAT, this-host, IPv6 ULA/link-local)', () => {
  for (const bad of [
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://100.64.0.1/', // CGNAT 100.64/10
    'http://0.0.0.0/', // "this host"
    'http://[fe80::1]/', // IPv6 link-local
    'http://[fd00::1]/', // IPv6 unique-local
  ]) {
    assert.throws(() => assertSafeIngestUrl(bad), IngestUrlError, `should reject ${bad}`);
  }
});

test('rejects malformed URLs and embedded credentials', () => {
  assert.throws(() => assertSafeIngestUrl('not a url'), IngestUrlError);
  assert.throws(() => assertSafeIngestUrl('http://user:pass@example.com/'), IngestUrlError);
});

test('does not block ordinary public IPs (172.15 / 172.32 are NOT private)', () => {
  assert.doesNotThrow(() => assertSafeIngestUrl('http://172.15.0.1/'));
  assert.doesNotThrow(() => assertSafeIngestUrl('http://172.32.0.1/'));
  assert.doesNotThrow(() => assertSafeIngestUrl('http://8.8.8.8/'));
});
