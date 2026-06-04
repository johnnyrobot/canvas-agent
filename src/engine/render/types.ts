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

/** A computed foreground/background color pair for one visible text run (§8.3). */
export interface TextColorPair {
  /** Computed CSS color of the text. */
  fg: string;
  /** Effective (resolved) CSS background color behind the text. */
  bg: string;
  /** WCAG text-size class for the run. */
  size: TextSize;
}

/** What a single render-and-scan pass yields for the pure auditor to map. */
export interface ScanResult {
  axe: AxeResults;
  textPairs: TextColorPair[];
}

/**
 * The injected scanner. The real implementation drives headless Chromium
 * (`playwrightRunner`); unit tests inject a fake that returns canned data, so
 * the axe→IssueSet mapping is tested with no browser. (PRD §8.6, AGENT_BRIEF.)
 */
export interface ScanRunner {
  run(html: string): Promise<ScanResult>;
}
