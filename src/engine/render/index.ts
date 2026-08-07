/**
 * engine-render: the deterministic render-and-scan accessibility audit (PRD §8).
 *
 * Public surface for this track. Implements the frozen `Auditor` port from
 * `src/contracts` and is consumed by the orchestrator's output gate
 * (`enforceGate` → `audit(html)` in `src/orchestrator/gate.ts`).
 *
 *  - `audit`                    — a ONE-SHOT production `Auditor` (Chromium + axe-core + contrast).
 *  - `createAuditor(runner)`    — the pure mapping core, for DI / testing.
 *  - `createPlaywrightRunner()` — the real headless-Chromium runner, which OWNS a browser.
 *
 * `audit` launches a browser only when called; importing this module does not.
 */
import { createAuditor } from './auditor.js';
import { createPlaywrightRunner } from './playwright-runner.js';
import type { Auditor } from '../../contracts/index.js';

/**
 * One-shot production audit: launch Chromium, scan once, close it.
 *
 * For a SINGLE audit — the build gate, a one-off tool call — this is exactly
 * what happened before ADR-0005, launch and all. A caller that audits
 * repeatedly (a remediate turn scans up to five times) must NOT use this, or it
 * pays a launch per scan; such callers hold their own `createPlaywrightRunner()`
 * for the turn and dispose it in a `finally`.
 *
 * There is deliberately no module-level runner behind this. One would hold a
 * Chromium process nobody disposes — the app has no shutdown path to hang a
 * teardown off (ADR-0005).
 */
export const audit: Auditor = async (html) => {
  const runner = createPlaywrightRunner();
  try {
    return await createAuditor(runner)(html);
  } finally {
    await runner.dispose();
  }
};

export { createAuditor } from './auditor.js';
export type { AuditorOptions } from './auditor.js';
export { CHECKS, axeViolations, axeIncomplete, computedContrast, altTextQuality } from './checks.js';
export type { Check, CheckOptions } from './checks.js';
export { createPlaywrightRunner } from './playwright-runner.js';
export type { PlaywrightRunnerOptions } from './playwright-runner.js';
export { severityForImpact, semanticCategory, DEFAULT_VIOLATION_SEVERITY } from './mapping.js';
export type { IssueCategory } from './mapping.js';
export type {
  AxeImpact,
  AxeNode,
  AxeResult,
  AxeResults,
  DisposableScanRunner,
  ResolvedBackground,
  ScanResult,
  ScanRunner,
  TextRun,
} from './types.js';
