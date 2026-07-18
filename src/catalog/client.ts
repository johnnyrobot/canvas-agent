/**
 * Read-only adapter around the locally installed `laccd-courses-pp-cli`
 * binary — an OPTIONAL enrichment source that turns a search query or a
 * numeric catalog id into real course SLOs/objectives/descriptions from the
 * LACCD eLumen catalog, instead of placeholder text. See `README.md`.
 *
 * Every invocation goes through `createCatalogClient`, the single choke point
 * that:
 *   - always spawns via an ARG ARRAY (`execFile`), never a shell string, so
 *     user-typed search text can never be interpreted as shell syntax;
 *   - never asks the CLI to write anything (no `sync`, `import`, `config set`,
 *     etc. — only `agent-context`, `courses search`, and `courses get`);
 *   - times out each call so a hung/throttled upstream can't hang the caller;
 *   - maps every failure (spawn error, non-zero exit, malformed JSON) to a
 *     typed `CatalogError` instead of letting a raw `Error` (or a Buffer, or
 *     an unhandled rejection shape) leak to the caller.
 *
 * Zero runtime dependencies beyond `node:child_process`, injected for tests.
 */
import { execFile as execFileCb } from 'node:child_process';
import type { CatalogCourse, CatalogCourseSummary } from './types.js';
import { CatalogError } from './types.js';

/** One CLI invocation's captured output. */
export interface CliExecResult {
  stdout: string;
  stderr: string;
}

/**
 * The shape of the error node's `child_process.execFile` rejects with on a
 * non-zero exit / spawn failure / timeout-kill. Our default transport passes
 * this through verbatim; tests construct one directly (no real spawn).
 */
export interface CliExecError extends Error {
  /** Process exit code, or a signal-shaped string/`null` on spawn failure. */
  code?: number | string | null;
  /** Set by Node when the timeout budget killed the child. */
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

/**
 * The slice of `child_process.execFile` we depend on (injected as a fake in
 * tests — no real process is ever spawned by the test suite).
 */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer: number },
) => Promise<CliExecResult>;

/** Promise-wrapped `execFile`, preserving Node's real error shape (`code`/`killed`/`stdout`/`stderr`). */
const defaultExecFile: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFileCb(
      file,
      args as string[],
      { timeout: options.timeoutMs, maxBuffer: options.maxBuffer, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as CliExecError;
          e.stdout = typeof stdout === 'string' ? stdout : '';
          e.stderr = typeof stderr === 'string' ? stderr : '';
          reject(e);
          return;
        }
        resolve({ stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' });
      },
    );
  });

export interface CatalogClientOptions {
  /** Path (or PATH-resolvable name) of the CLI binary. Default: `'laccd-courses-pp-cli'`. */
  command?: string;
  /** `--home` root for the bundled/copied mirror. Prefixed on every call when set. */
  home?: string;
  /** Transport. Defaults to a promisified `child_process.execFile`; tests inject a recording fake. */
  execFile?: ExecFileLike;
  /** Per-invocation timeout (ms). A hung/throttled CLI must not hang the caller. Default 15s. */
  timeoutMs?: number;
}

export interface CatalogClient {
  /** True iff the binary resolves AND a lightweight probe command exits 0. Never throws. */
  available(): Promise<boolean>;
  /** Search the catalog by free-text query, returning lightweight summaries. */
  searchCourses(query: string): Promise<CatalogCourseSummary[]>;
  /** Fetch one course's full enrichment detail (units, description, SLOs, objectives) by numeric id. */
  getCourse(id: number): Promise<CatalogCourse>;
}

const DEFAULT_COMMAND = 'laccd-courses-pp-cli';
const DEFAULT_TIMEOUT_MS = 15_000;
/** Search/get responses embed a large `fullCourseInfo` JSON string per row; give stdout room. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/** Cap on rows the local full-text `search` returns per query. */
const SEARCH_LIMIT = 25;

/** Build a read-only catalog client over an injectable `execFile`. */
export function createCatalogClient(opts: CatalogClientOptions = {}): CatalogClient {
  const command = opts.command ?? DEFAULT_COMMAND;
  const run = opts.execFile ?? defaultExecFile;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const homeArgs = opts.home ? (['--home', opts.home] as const) : ([] as const);

  /** Run the CLI with `--agent` (JSON, non-interactive) and parse stdout as JSON. */
  async function invoke(args: readonly string[], dataSource: 'local' | 'auto'): Promise<unknown> {
    let stdout: string;
    try {
      const full = [...homeArgs, ...args, '--agent', '--data-source', dataSource];
      const res = await run(command, full, { timeoutMs, maxBuffer: MAX_BUFFER_BYTES });
      stdout = res.stdout;
    } catch (err) {
      throw toCatalogError(err, timeoutMs);
    }
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new CatalogError(
        'parse',
        `laccd-courses-pp-cli returned non-JSON output for "${args.join(' ')}"`,
      );
    }
  }

  return {
    async available(): Promise<boolean> {
      try {
        // A cheap, side-effect-free probe: emits the CLI's own capability
        // description and exits 0 iff the binary runs at all.
        await run(command, [...homeArgs, 'agent-context'], { timeoutMs, maxBuffer: MAX_BUFFER_BYTES });
        return true;
      } catch {
        return false;
      }
    },

    async searchCourses(query: string): Promise<CatalogCourseSummary[]> {
      // Full-text `search` over the local mirror — `courses search --query` does NOT
      // filter in local mode (it dumps all rows); the top-level `search` does.
      const data = await invoke(['search', query, '--type', 'courses', '--limit', String(SEARCH_LIMIT)], 'local');
      return extractResults(data)
        .map(toSummary)
        .filter((s): s is CatalogCourseSummary => s !== null);
    },

    async getCourse(id: number): Promise<CatalogCourse> {
      // Enforce the id contract before anything reaches the CLI's argv.
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new CatalogError('parse', `invalid catalog course id: ${String(id)}`);
      }
      // `auto` = live with local fallback: current SLOs when online, seed when offline.
      const data = await invoke(['courses', 'get', String(id)], 'auto');
      const raw = extractSingle(data);
      if (!raw) {
        throw new CatalogError('notFound', `Course ${id} was not found in the catalog.`);
      }
      return toCourse(raw, extractSource(data));
    },
  };
}

// ── Error mapping ─────────────────────────────────────────────────────────────

/**
 * Map a failed invocation to a typed `CatalogError`. The CLI's documented
 * exit-code contract (2 usage, 3 not found, 5 API error, 7 rate limited, 10
 * config) is tried first; in practice this CLI build exits 1 for most
 * failures, so we ALSO sniff the HTTP status the CLI embeds in its stderr
 * message (e.g. "returned HTTP 404: ...") as the primary, more reliable signal.
 */
function toCatalogError(err: unknown, timeoutMs: number): CatalogError {
  const e = err as CliExecError | undefined;
  const message = e?.message ?? String(err);
  const stderr = typeof e?.stderr === 'string' ? e.stderr : '';

  // Spawn failure: the binary itself could not be found/executed.
  if (e?.code === 'ENOENT' || /ENOENT|command not found|not recognized/i.test(message)) {
    return new CatalogError('unavailable', `laccd-courses-pp-cli is not installed or not on PATH: ${message}`);
  }
  // Node kills the child on timeout; it never carries an HTTP status.
  if (e?.killed) {
    return new CatalogError('timeout', `laccd-courses-pp-cli timed out after ${timeoutMs}ms`);
  }

  const haystack = stderr || message;
  if (/HTTP\s*404\b/.test(haystack) || /not found/i.test(haystack)) {
    return new CatalogError('notFound', haystack || message);
  }
  if (/HTTP\s*429\b/.test(haystack) || /rate.?limit/i.test(haystack)) {
    return new CatalogError('rateLimited', haystack || message);
  }
  if (/HTTP\s*5\d\d\b/.test(haystack)) {
    return new CatalogError('cliError', haystack || message);
  }

  // Fall back to the documented typed exit codes, in case a future CLI build
  // actually emits them.
  const code = typeof e?.code === 'number' ? e.code : undefined;
  if (code === 3) return new CatalogError('notFound', haystack || message);
  if (code === 7) return new CatalogError('rateLimited', haystack || message);
  if (code === 10) return new CatalogError('unavailable', haystack || message);

  return new CatalogError('cliError', haystack || message);
}

// ── Response shape helpers ────────────────────────────────────────────────────

/** The CLI's `--agent` envelope: `{ meta: { source }, results: [...] | {...} }`. */
interface CliEnvelope {
  meta?: { source?: string };
  results?: unknown;
}

function isEnvelope(data: unknown): data is CliEnvelope {
  return typeof data === 'object' && data !== null && 'results' in data;
}

/** The list of raw result rows, regardless of whether the CLI wrapped them in an envelope. */
function extractResults(data: unknown): unknown[] {
  if (isEnvelope(data)) return Array.isArray(data.results) ? data.results : [];
  return Array.isArray(data) ? data : [];
}

/** `courses get` returns a single object under `results` (not an array); tolerate an array too. */
function extractSingle(data: unknown): Record<string, unknown> | null {
  if (!isEnvelope(data)) return null;
  const r = data.results;
  const candidate = Array.isArray(r) ? r[0] : r;
  return typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, unknown>) : null;
}

/** `meta.source` reported by the CLI ("live" = real-time public API; anything else = the local mirror). */
function extractSource(data: unknown): string {
  if (isEnvelope(data) && data.meta && typeof data.meta.source === 'string') return data.meta.source;
  return 'mirror';
}

/** The numeric catalog id, preferring the `_links.self.href` slug (e.g. "/public/courses/38409"). */
function parseId(raw: Record<string, unknown>): number | undefined {
  const links = raw._links;
  if (typeof links === 'object' && links !== null) {
    const self = (links as Record<string, unknown>).self;
    const href = typeof self === 'object' && self !== null ? (self as Record<string, unknown>).href : undefined;
    if (typeof href === 'string') {
      const match = /(\d+)\s*$/.exec(href);
      if (match?.[1] !== undefined) {
        const n = Number(match[1]);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  // Fall back to a top-level numeric `id`, when the href is absent or unparseable.
  if (typeof raw.id === 'number' && Number.isFinite(raw.id)) return raw.id;
  return undefined;
}

/** Map one raw search-result row to a `CatalogCourseSummary`. `null` skips an unusable row rather than surfacing junk. */
function toSummary(raw: unknown): CatalogCourseSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = parseId(r);
  if (id === undefined || typeof r.code !== 'string') return null;

  const summary: CatalogCourseSummary = {
    id,
    code: r.code,
    title: typeof r.name === 'string' ? r.name : '',
  };
  if (typeof r.tenant === 'string') summary.college = r.tenant;
  return summary;
}

/** An objective's authored order; unordered/malformed entries sort last but are never dropped. */
function objectiveSequence(o: unknown): number {
  if (typeof o !== 'object' || o === null) return Number.MAX_SAFE_INTEGER;
  const seq = (o as Record<string, unknown>).sequence;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER;
}

/**
 * Build a `CatalogCourse` from one raw `courses get`/`courses search` row.
 * `fullCourseInfo` is a JSON-ENCODED STRING on the raw row — malformed JSON
 * there is a typed `CatalogError('parse', …)`, never an uncaught throw. A
 * missing/absent `fullCourseInfo` degrades to a shell record (id/code/title
 * only) rather than an error — the caller still gets a usable, honest result.
 */
function toCourse(raw: Record<string, unknown>, source: string): CatalogCourse {
  const id = parseId(raw);
  if (id === undefined) {
    throw new CatalogError('parse', 'catalog course response had no resolvable numeric id');
  }

  const course: CatalogCourse = {
    id,
    code: typeof raw.code === 'string' ? raw.code : '',
    title: typeof raw.name === 'string' ? raw.name : '',
    slos: [],
    objectives: [],
    source: source === 'live' ? 'live' : 'mirror',
  };
  if (typeof raw.tenant === 'string') course.college = raw.tenant;

  const fullRaw = raw.fullCourseInfo;
  if (typeof fullRaw !== 'string' || fullRaw.length === 0) return course;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fullRaw);
  } catch {
    throw new CatalogError('parse', `course ${id}: fullCourseInfo was not valid JSON`);
  }
  // JSON.parse can legally return null/arrays/primitives — only an object is usable.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CatalogError('parse', `course ${id}: fullCourseInfo was not a JSON object`);
  }
  const full = parsed as Record<string, unknown>;

  if (typeof full.courseTitle === 'string' && full.courseTitle.length > 0) course.title = full.courseTitle;
  if (typeof full.courseDescription === 'string') course.description = full.courseDescription;

  const credits = Array.isArray(full.creditsAndHours) ? full.creditsAndHours : [];
  const defaultCredit =
    credits.find(
      (c): c is Record<string, unknown> => typeof c === 'object' && c !== null && (c as Record<string, unknown>).isDefault === true,
    ) ?? (credits[0] as Record<string, unknown> | undefined);
  if (defaultCredit && typeof defaultCredit.credit === 'number') course.units = defaultCredit.credit;

  const outcomes = Array.isArray(full.outcomes) ? full.outcomes : [];
  course.slos = outcomes
    .filter(
      (o): o is Record<string, unknown> =>
        typeof o === 'object' && o !== null && (o as Record<string, unknown>).outcomeLevel === 'CSLO',
    )
    .map((o) => (typeof o.name === 'string' ? o.name : ''))
    .filter((name) => name.length > 0);

  const objectives = Array.isArray(full.objectives) ? full.objectives : [];
  course.objectives = objectives
    .slice()
    .sort((a, b) => objectiveSequence(a) - objectiveSequence(b))
    .map((o) => (typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>).name === 'string'
      ? ((o as Record<string, unknown>).name as string)
      : ''))
    .filter((name) => name.length > 0);

  return course;
}
