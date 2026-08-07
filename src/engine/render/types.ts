/**
 * Local, minimal type surface for the render-and-scan auditor.
 *
 * We deliberately model only the subset of axe-core's `AxeResults` that the
 * mapping logic reads. Keeping these structural (rather than importing axe-core's
 * own types) means the pure mapping core + its unit tests never need axe-core or
 * a browser — a real `AxeResults` from `axe.run()` is structurally assignable to
 * `AxeResults` here, and tests can hand-build canned fixtures trivially.
 */
import type { TextSize } from '../../contracts/index.js';

/** axe-core impact levels (a violation may also carry `null`/absent impact). */
export type AxeImpact = 'minor' | 'moderate' | 'serious' | 'critical';

/** One failing/needs-review DOM node within an axe result (subset). */
export interface AxeNode {
  html?: string;
  target?: ReadonlyArray<string>;
  failureSummary?: string;
}

/** One axe rule result (subset of axe-core's `Result`). */
export interface AxeResult {
  /** axe rule id, e.g. `image-alt`, `color-contrast`. Becomes `AuditIssue.id`. */
  id: string;
  impact?: AxeImpact | null;
  /** Human description; becomes `AuditIssue.message`. */
  description?: string;
  help?: string;
  helpUrl?: string;
  tags?: ReadonlyArray<string>;
  nodes?: ReadonlyArray<AxeNode>;
}

/** Subset of axe-core's top-level `AxeResults`. */
export interface AxeResults {
  /** Definite failures. */
  violations: ReadonlyArray<AxeResult>;
  /** Needs-review / could-not-determine results (→ `alert`). */
  incomplete?: ReadonlyArray<AxeResult>;
  passes?: ReadonlyArray<AxeResult>;
  inapplicable?: ReadonlyArray<AxeResult>;
}

/**
 * One image and its alt text, as found in the rendered DOM.
 *
 * `alt` distinguishes three states that mean different things under WCAG 1.1.1:
 * `null` = no alt attribute at all (axe's `image-alt` error), `''` = an explicit
 * decorative marker (correct), any other string = a text alternative whose
 * *quality* is judged by `altTextIssue`.
 */
export interface ImageAlt {
  alt: string | null;
  src: string;
  /** `role="presentation"` / `role="none"` / `aria-hidden="true"`. */
  presentation: boolean;
}

/** What a single render-and-scan pass yields for the pure auditor to map. */
export interface ScanResult {
  axe: AxeResults;
  textRuns: TextRun[];
  images: ImageAlt[];
}

/**
 * The injected scanner. The real implementation drives headless Chromium
 * (`createPlaywrightRunner()`); unit tests inject a fake that returns canned
 * data, so the axe→IssueSet mapping is tested with no browser. (PRD §8.6,
 * AGENT_BRIEF.)
 */
export interface ScanRunner {
  run(html: string): Promise<ScanResult>;
}

/**
 * A `ScanRunner` that owns a resource — in practice, one Chromium process held
 * for the lifetime of a turn (ADR-0005).
 *
 * `ScanRunner` itself deliberately stays a SINGLE method: adding `dispose()` to
 * it would force every injected test fake and `createAuditor` to grow a
 * lifecycle they neither have nor need. Only the concrete factory that actually
 * allocates something returns this wider type, and only the caller who
 * constructed it is obliged to dispose it.
 */
export interface DisposableScanRunner extends ScanRunner {
  /**
   * Release the browser. Idempotent, and safe on a runner that never ran.
   *
   * Disposal is FINAL. A `run()` after it rejects rather than launching a
   * second browser — a stray late scan, one escaping the `finally` that
   * disposed the runner, would otherwise allocate a Chromium nobody is left to
   * close. Construct a new runner instead; they are cheap until they launch.
   *
   * This also makes `dispose()` safe against an in-flight `run()`: a launch
   * already under way is awaited and closed, and one not yet started is
   * refused. That `run()` fails, but nothing leaks.
   */
  dispose(): Promise<void>;
}

/** The resolved background behind a text run, as classified by the runner. */
export type ResolvedBackground =
  | { kind: 'layers'; layers: string[] }       // top→bottom CSS colors down to an opaque base
  | { kind: 'gradient'; css: string }          // raw computed gradient string
  | { kind: 'image'; swatches: string[] }      // worst-case opaque bg samples (rgb strings)
  | { kind: 'unresolvable'; reason: string };  // filters / conic / empty box / screenshot failure

/** One visible text run with its resolved background (replaces TextColorPair). */
export interface TextRun {
  fg: string;
  background: ResolvedBackground;
  size: TextSize;
}
