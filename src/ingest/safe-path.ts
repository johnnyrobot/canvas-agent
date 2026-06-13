/**
 * Containment guard for model-supplied document references (C6).
 *
 * `ingest_document` takes a `fileRef` chosen by the LLM, and a prompt-injected
 * document could ask to ingest `~/.ssh/id_rsa`, the app's SQLite DB, or
 * `../../etc/passwd`. To prevent arbitrary on-device file reads, every ref is
 * resolved STRICTLY inside the app's uploads/staging directory: absolute paths
 * and `..` traversal are rejected.
 *
 * Scope: this blocks absolute-path and parent-traversal escapes. Symlink escapes
 * that live *inside* the uploads dir are out of scope for this guard.
 */
import { isAbsolute, resolve, relative, sep } from 'node:path';

export class IngestPathError extends Error {
  constructor(fileRef: string) {
    super(
      `Refusing to ingest "${fileRef}": only files inside the uploads directory may be ingested.`,
    );
    this.name = 'IngestPathError';
  }
}

/**
 * Resolve `fileRef` to an absolute path guaranteed to be inside `uploadsDir`.
 * Throws `IngestPathError` if the ref is empty, absolute, or escapes the dir.
 */
export function resolveStagedPath(uploadsDir: string, fileRef: string): string {
  if (typeof fileRef !== 'string' || fileRef.trim() === '') throw new IngestPathError(String(fileRef));
  // An absolute ref would make `resolve` ignore the base entirely.
  if (isAbsolute(fileRef)) throw new IngestPathError(fileRef);

  const base = resolve(uploadsDir);
  const target = resolve(base, fileRef);
  const rel = relative(base, target);
  // Escape iff the relative path is empty (the dir itself), steps up (`..`), or
  // is absolute (a different drive root on Windows). `..foo` is NOT an escape.
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new IngestPathError(fileRef);
  }
  return target;
}
