/**
 * Opt-in Canvas publish adapter around the locally installed `canvas-pp-cli`
 * binary (PRD §17: the in-app client stays GET-only; ALL writes shell out to
 * this EXTERNAL, separately installed and separately authenticated tool).
 *
 * Mirrors `src/catalog/client.ts`'s discipline:
 *   - always spawns via an ARG ARRAY, never a shell string;
 *   - page HTML travels over STDIN (`--stdin`), never argv;
 *   - course/page ids are validated before they reach argv;
 *   - every failure maps to a typed `PublishError`;
 *   - each call is timeout-bounded.
 *
 * Safety preflight: `publishPage` first resolves the CLI's configured Canvas
 * host (`doctor --agent` → `base_url`) and refuses on a mismatch with the
 * app-side base URL the page was imported from — a stale app setting can never
 * push to a different Canvas. The caller (runtime app-api) is responsible for
 * the accessibility-gate re-check; this module is transport only.
 */
import { spawn } from 'node:child_process';

export type PublishErrorKind =
  | 'unavailable'
  | 'timeout'
  | 'hostMismatch'
  | 'invalidId'
  | 'parse'
  | 'cliError';

export class PublishError extends Error {
  readonly kind: PublishErrorKind;
  constructor(kind: PublishErrorKind, message: string) {
    super(message);
    this.name = 'PublishError';
    this.kind = kind;
  }
}

/** One CLI invocation's captured output. */
export interface PublishExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The slice of process-spawning we depend on (injected as a fake in tests —
 * the test suite never spawns a real process). Rejects only on spawn-level
 * failures (ENOENT, timeout kill); a non-zero exit RESOLVES with `exitCode`.
 */
export type ExecLike = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer: number; stdinData?: string },
) => Promise<PublishExecResult>;

/** Default transport: `spawn` with stdin support and a kill-on-timeout budget. */
export const defaultExec: ExecLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args as string[], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const err = new Error(`timed out after ${options.timeoutMs}ms`) as Error & { killed: boolean };
      err.killed = true;
      reject(err);
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < options.maxBuffer) stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < options.maxBuffer) stderr += d;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    // Swallow stdin stream errors (e.g. EPIPE when the child closes its input
    // early / dies before reading): without a listener the 'error' event would
    // surface as an unhandled exception. The real outcome still arrives via the
    // child's 'error'/'close' handlers above.
    child.stdin.on('error', () => {});
    if (options.stdinData !== undefined) child.stdin.end(options.stdinData);
    else child.stdin.end();
  });

export interface CanvasPublisherOptions {
  /** Path (or PATH-resolvable name) of the CLI binary. Default: `'canvas-pp-cli'`. */
  command?: string;
  /** Transport. Defaults to a spawn-based exec; tests inject a recording fake. */
  exec?: ExecLike;
  /** Per-invocation timeout (ms). Default 30s (a live PUT can be slow). */
  timeoutMs?: number;
}

export interface PublishPageInput {
  /** The Canvas base URL the page was imported from (host-match preflight). */
  baseUrl: string;
  courseId: string;
  pageId: string;
  /** Gate-passing HTML (the CALLER enforces the gate; this module publishes verbatim). */
  html: string;
}

export interface PublishPageResult {
  /** The Canvas page URL on the CLI's configured host. */
  canvasUrl: string;
}

export interface CanvasPublisher {
  /** True iff the binary resolves AND a lightweight probe command exits 0. Never throws. */
  available(): Promise<boolean>;
  /** The CLI's configured Canvas base URL, normalized (from `doctor --agent`). */
  configuredBase(): Promise<string>;
  /** PUT the page body via `pages update`. Resolves with the page URL on success. */
  publishPage(input: PublishPageInput): Promise<PublishPageResult>;
}

const DEFAULT_COMMAND = 'canvas-pp-cli';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Canvas ids/slugs as this app consumes them: numeric ids or page-URL slugs.
 * Anything else (spaces, slashes, leading dashes…) is rejected BEFORE argv so a
 * hostile value can neither traverse the path nor read as a CLI flag.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/**
 * Normalized HTTP(S) base — scheme + lowercased host(+port) + path with trailing
 * slashes stripped (`https://X.edu/canvas/` → `https://x.edu/canvas`), or null for
 * a non-HTTP(S) or unparseable value. Comparing the FULL base (not just the host)
 * keeps a path-hosted Canvas (`…/canvas`) and the http/https scheme part of the
 * preflight, and lets the receipt URL be built from the real configured base.
 */
function normalizeBase(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function createCanvasPublisher(opts: CanvasPublisherOptions = {}): CanvasPublisher {
  const command = opts.command ?? DEFAULT_COMMAND;
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function invoke(args: readonly string[], stdinData?: string): Promise<unknown> {
    let result: PublishExecResult;
    try {
      const options: { timeoutMs: number; maxBuffer: number; stdinData?: string } = {
        timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
      };
      if (stdinData !== undefined) options.stdinData = stdinData;
      result = await exec(command, [...args, '--agent'], options);
    } catch (err) {
      const e = err as Error & { code?: unknown; killed?: boolean };
      if (e.code === 'ENOENT') {
        throw new PublishError('unavailable', `canvas-pp-cli is not installed or not on PATH: ${e.message}`);
      }
      if (e.killed) {
        throw new PublishError('timeout', `canvas-pp-cli timed out after ${timeoutMs}ms`);
      }
      throw new PublishError('cliError', e.message);
    }
    if (result.exitCode !== 0) {
      throw new PublishError(
        'cliError',
        `canvas-pp-cli "${args.join(' ')}" exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new PublishError('parse', `canvas-pp-cli returned non-JSON output for "${args.join(' ')}"`);
    }
  }

  async function configuredBase(): Promise<string> {
    const data = await invoke(['doctor']);
    const baseUrl =
      typeof data === 'object' && data !== null ? (data as Record<string, unknown>).base_url : undefined;
    const base = typeof baseUrl === 'string' ? normalizeBase(baseUrl) : null;
    if (!base) {
      throw new PublishError('parse', 'canvas-pp-cli doctor did not report a base_url');
    }
    return base;
  }

  return {
    async available(): Promise<boolean> {
      try {
        // Same cheap, side-effect-free probe the catalog client uses. Unlike the
        // catalog client's execFile transport (which REJECTS on a non-zero exit),
        // our spawn-based exec RESOLVES with the code — so a broken-but-present
        // binary that exits non-zero must read as unavailable, not available.
        const result = await exec(command, ['agent-context'], { timeoutMs, maxBuffer: MAX_BUFFER_BYTES });
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },

    configuredBase,

    async publishPage(input: PublishPageInput): Promise<PublishPageResult> {
      if (!SAFE_ID.test(input.courseId)) {
        throw new PublishError('invalidId', `invalid Canvas course id: ${JSON.stringify(input.courseId)}`);
      }
      if (!SAFE_ID.test(input.pageId)) {
        throw new PublishError('invalidId', `invalid Canvas page id: ${JSON.stringify(input.pageId)}`);
      }

      // Base-match preflight: the CLI publishes to ITS configured Canvas; refuse
      // when that is not the Canvas this page was imported from (full base — scheme,
      // host, and any path — so http/https and path-hosted instances can't mismatch).
      const cliBase = await configuredBase();
      const appBase = normalizeBase(input.baseUrl);
      if (!appBase || appBase !== cliBase) {
        throw new PublishError(
          'hostMismatch',
          `canvas-pp-cli is configured for ${cliBase}, but this page came from ${appBase ?? input.baseUrl}. ` +
            'Re-point one of them before publishing.',
        );
      }

      const body = JSON.stringify({ wiki_page: { body: input.html, notify_of_update: false } });
      await invoke(['pages', 'update', input.courseId, input.pageId, '--stdin'], body);
      return { canvasUrl: `${cliBase}/courses/${input.courseId}/pages/${input.pageId}` };
    },
  };
}
