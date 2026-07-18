/**
 * Ensure a writable catalog `--home` exists with the seed DB in place. The CLI
 * opens its DB read-write, so the read-only bundled seed cannot be used in place;
 * we copy it once into userData. Idempotent — never overwrites an existing DB
 * (which may have been refreshed by a later `sync`). Copy is atomic via temp+rename,
 * so a partial copy (e.g. from process kill during the ~898 MB seed transfer) is
 * never observable as the real DB. Pure + injectable for tests.
 */
import { existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export interface EnsureCatalogHomeOptions {
  seedDbPath: string;
  homeDir: string;
  exists?: (p: string) => boolean;
  mkdir?: (p: string) => void;
  copyFile?: (src: string, dst: string) => void;
  rename?: (src: string, dst: string) => void;
}

export function ensureCatalogHome(opts: EnsureCatalogHomeOptions): string {
  const exists = opts.exists ?? existsSync;
  const mkdir = opts.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const copyFile = opts.copyFile ?? copyFileSync;
  const rename = opts.rename ?? renameSync;

  const dataDir = path.join(opts.homeDir, 'data');
  const dbPath = path.join(dataDir, 'data.db');
  if (!exists(dbPath)) {
    mkdir(dataDir);
    const tmp = dbPath + '.tmp';
    copyFile(opts.seedDbPath, tmp);
    rename(tmp, dbPath); // atomic on the same filesystem — a partial copy is never observable as data.db
  }
  return opts.homeDir;
}
