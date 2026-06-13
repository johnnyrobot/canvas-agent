import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveStagedPath, IngestPathError } from './safe-path.js';

const UP = '/app/uploads';

test('resolveStagedPath returns a contained absolute path for a simple name', () => {
  assert.equal(resolveStagedPath(UP, 'syllabus.docx'), join(UP, 'syllabus.docx'));
});

test('resolveStagedPath allows nested files within the uploads dir', () => {
  assert.equal(resolveStagedPath(UP, 'sub/dir/a.pdf'), join(UP, 'sub/dir/a.pdf'));
});

test('resolveStagedPath rejects an absolute path — prompt-injected arbitrary read (C6)', () => {
  assert.throws(() => resolveStagedPath(UP, '/Users/me/.ssh/id_rsa'), IngestPathError);
});

test('resolveStagedPath rejects parent-directory traversal (C6)', () => {
  assert.throws(() => resolveStagedPath(UP, '../../etc/passwd'), IngestPathError);
  assert.throws(() => resolveStagedPath(UP, '..'), IngestPathError);
});

test('resolveStagedPath rejects an empty or whitespace-only ref', () => {
  assert.throws(() => resolveStagedPath(UP, ''), IngestPathError);
  assert.throws(() => resolveStagedPath(UP, '   '), IngestPathError);
});

test('resolveStagedPath allows legitimate names that merely start with dots', () => {
  assert.equal(resolveStagedPath(UP, '.hidden.docx'), join(UP, '.hidden.docx'));
  assert.equal(resolveStagedPath(UP, '..foo.docx'), join(UP, '..foo.docx'));
});
