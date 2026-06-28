/**
 * Local file layout for the single-user macOS desktop app (PRD v1.6 §3, §16).
 *
 * `resolveAppPaths` is a PURE resolver — it never touches the filesystem. Use
 * the separate `ensureAppDirs` when you actually want the directories created.
 */
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AppPaths } from '../contracts/index.js';

/** Default app-data root: ~/Library/Application Support/CanvasAgent. */
function defaultDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'CanvasAgent');
}

/** Derive the full layout from a (resolved, absolute) data directory. */
function deriveFrom(dataDir: string): AppPaths {
  return {
    dataDir,
    dbPath: join(dataDir, 'canvas-agent.sqlite'),
    uploadsDir: join(dataDir, 'uploads'),
    exportsDir: join(dataDir, 'exports'),
    modelsDir: join(dataDir, 'docling-models'),
  };
}

/**
 * Resolve the app's file layout. With no argument, returns the macOS default
 * layout. An `override` merges field-by-field: overriding `dataDir` re-bases
 * the derived paths under it, while an explicit `dbPath`/`uploadsDir`/
 * `exportsDir` wins over the derived value. All returned paths are absolute.
 */
export function resolveAppPaths(override?: Partial<AppPaths>): AppPaths {
  const dataDir = resolve(override?.dataDir ?? defaultDataDir());
  const derived = deriveFrom(dataDir);
  const merged: AppPaths = {
    dataDir,
    dbPath: override?.dbPath ? resolve(override.dbPath) : derived.dbPath,
    uploadsDir: override?.uploadsDir ? resolve(override.uploadsDir) : derived.uploadsDir,
    exportsDir: override?.exportsDir ? resolve(override.exportsDir) : derived.exportsDir,
    modelsDir: override?.modelsDir ? resolve(override.modelsDir) : derived.modelsDir,
  };
  return merged;
}

/**
 * Create the app's directories on disk (idempotent). Not called by the pure
 * resolver — invoke explicitly at app startup. `dbPath`'s parent is `dataDir`,
 * so creating these three dirs is sufficient.
 */
export async function ensureAppDirs(paths: AppPaths): Promise<void> {
  for (const dir of [paths.dataDir, paths.uploadsDir, paths.exportsDir, paths.modelsDir]) {
    if (!isAbsolute(dir)) throw new Error(`ensureAppDirs requires absolute paths, got: ${dir}`);
    await mkdir(dir, { recursive: true });
  }
}
