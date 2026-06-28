/**
 * First-run Docling model-download transport.
 *
 * The analogue of `OllamaClient.pullModel`, but Docling has no streaming HTTP
 * pull endpoint — so we drive the bundled CPython's `download_models()` via a
 * small NDJSON-emitting driver (`scripts/docling-download-models.py`, staged
 * into the sidecar bundle) and surface its per-model progress as an async
 * generator. Like the LLM pull this is a multi-minute, multi-hundred-MB download
 * that runs ONLINE (the caller clears HF offline flags); serving is offline.
 *
 * Injectable spawn + command resolver so it is unit-tested with no real process.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { resolveSidecarCommand } from '../runtime/bundled-resources.js';
import type { IngestPullProgress } from './types.js';

export type DownloadSpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class IngestDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestDownloadError';
  }
}

export interface DownloadModelsOptions {
  /** Persistent dir to write the models into (the app's per-user store). */
  modelsDir: string;
  /** Writable HF cache dir; defaults to `<modelsDir>/.hf-cache`. */
  hfHome?: string;
  /** Cancel the in-flight download (kills the child). */
  signal?: AbortSignal;
  /** Test seam: inject a fake spawn (defaults to `child_process.spawn`). */
  spawnImpl?: DownloadSpawnLike;
  /** Test seam: resolve the bundled `docling-serve` launcher (defaults to the real resolver). */
  resolveCommand?: (name: string) => string;
}

/**
 * Locate the bundled CPython interpreter and the download driver, derived from
 * the staged `docling-serve` launcher path. Returns `undefined` in dev/test
 * (no packaged resources) so callers can give a clear "packaged app only" error
 * rather than spawning a bare, wrong `python3` from PATH.
 */
export function resolveDownloadTooling(
  resolveCommand: (name: string) => string = resolveSidecarCommand,
): { python: string; driver: string } | undefined {
  const launcher = resolveCommand('docling-serve');
  // The real resolver returns the bare name as a fallback when not packaged; an
  // absolute path means we're inside the bundle and the python/driver are beside it.
  if (!path.isAbsolute(launcher)) return undefined;
  const dir = path.dirname(launcher);
  return {
    python: path.join(dir, 'python', 'bin', 'python3'),
    driver: path.join(dir, 'download-models.py'),
  };
}

/** Derive [0..100] percent from model COUNTS when both are known. */
export function normalizeIngestProgress(raw: {
  status?: string;
  model?: string;
  completed?: number;
  total?: number;
}): IngestPullProgress {
  const p: IngestPullProgress = { status: raw.status ?? 'working' };
  if (typeof raw.model === 'string') p.model = raw.model;
  if (typeof raw.completed === 'number') p.completed = raw.completed;
  if (typeof raw.total === 'number') p.total = raw.total;
  if (typeof raw.completed === 'number' && typeof raw.total === 'number' && raw.total > 0) {
    p.percent = Math.min(100, Math.max(0, Math.round((raw.completed / raw.total) * 100)));
  }
  return p;
}

/**
 * Download the Docling conversion models, yielding normalized progress per model.
 * Throws `IngestDownloadError` if run outside the packaged app (no bundled
 * Python), on a driver `{"error":…}` line, or on a non-zero exit.
 */
export async function* downloadModels(opts: DownloadModelsOptions): AsyncGenerator<IngestPullProgress> {
  const tooling = resolveDownloadTooling(opts.resolveCommand);
  if (!tooling) {
    throw new IngestDownloadError(
      'In-app model download requires the packaged app (the bundled Python runtime was not found).',
    );
  }
  const spawnImpl = opts.spawnImpl ?? spawn;
  const hfHome = opts.hfHome ?? path.join(opts.modelsDir, '.hf-cache');
  // Run ONLINE: explicitly clear any inherited offline flags so the download can
  // reach Hugging Face; point HF_HOME at a writable cache under the model store.
  const env: NodeJS.ProcessEnv = { ...process.env, HF_HOME: hfHome };
  delete env.HF_HUB_OFFLINE;
  delete env.TRANSFORMERS_OFFLINE;

  const spawnOptions: SpawnOptions = { env, stdio: ['ignore', 'pipe', 'pipe'] };
  if (opts.signal) spawnOptions.signal = opts.signal;
  const child = spawnImpl(tooling.python, [tooling.driver, opts.modelsDir], spawnOptions);

  let spawnErr: Error | undefined;
  child.on('error', (e: Error) => {
    spawnErr = e;
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const exit = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0)));

  const stdout = child.stdout;
  if (!stdout) throw new IngestDownloadError('Model download driver produced no stdout.');

  let buf = '';
  for await (const chunk of stdout) {
    buf += (chunk as Buffer).toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj: { error?: string; status?: string; model?: string; completed?: number; total?: number };
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // ignore any non-JSON noise the driver/libs might print
      }
      if (typeof obj.error === 'string' && obj.error !== '') {
        throw new IngestDownloadError(obj.error);
      }
      yield normalizeIngestProgress(obj);
    }
  }

  if (spawnErr) {
    throw new IngestDownloadError(`Failed to spawn model download driver: ${spawnErr.message}`);
  }
  const code = await exit;
  if (code !== 0) {
    throw new IngestDownloadError(`Model download exited ${code}: ${stderr.trim().slice(-500)}`);
  }
}
