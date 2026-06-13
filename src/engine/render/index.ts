/**
 * engine-render: the deterministic render-and-scan accessibility audit (PRD §8).
 *
 * Public surface for this track. Implements the frozen `Auditor` port from
 * `src/contracts` and is consumed by the orchestrator's output gate
 * (`enforceGate` → `audit(html)` in `src/orchestrator/gate.ts`).
 *
 *  - `audit`                 — the production `Auditor` (Chromium + axe-core + computed contrast).
 *  - `createAuditor(runner)` — the pure mapping core, for DI / testing.
 *  - `playwrightRunner`      — the real headless-Chromium `ScanRunner`.
 *
 * `audit` launches a browser only when called; importing this module does not.
 */
import { createAuditor } from './auditor.js';
import { playwrightRunner } from './playwright-runner.js';
import type { Auditor } from '../../contracts/index.js';

/** Production audit: render in headless Chromium, scan, map to an `IssueSet`. */
export const audit: Auditor = createAuditor(playwrightRunner);

export { createAuditor } from './auditor.js';
export type { AuditorOptions } from './auditor.js';
export { createPlaywrightRunner, playwrightRunner } from './playwright-runner.js';
export type { PlaywrightRunnerOptions } from './playwright-runner.js';
export { severityForImpact, semanticCategory, DEFAULT_VIOLATION_SEVERITY } from './mapping.js';
export type { IssueCategory } from './mapping.js';
export type {
  AxeImpact,
  AxeNode,
  AxeResult,
  AxeResults,
  ResolvedBackground,
  ScanResult,
  ScanRunner,
  TextRun,
} from './types.js';
