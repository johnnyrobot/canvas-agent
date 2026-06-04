/**
 * `createStubApi(): AppApi` — canned responses so the Electron shell runs
 * standalone, before the integration track's real `createAppApi` exists.
 *
 * The lead swaps this for the real runtime after both tracks merge (the only
 * change is the argument to `registerIpc` in `main.ts`). Everything here is
 * static, deterministic data shaped exactly like the frozen contracts.
 *
 * The canned turn deliberately includes BOTH a fragment whose gate passed and a
 * fragment whose badge is WITHHELD by a blocker, so the renderer's pass /
 * "checks withheld" rendering is exercised the moment you launch the app.
 *
 * NOTE: this builds `GateResult` literals directly rather than importing the
 * orchestrator's `enforceGate` — the app-shell track depends only on the frozen
 * contract *types*, never on another track's runtime code.
 */
import type {
  AppApi,
  AuditIssue,
  CanvasImportResult,
  GateResult,
  RuntimeHealth,
  TurnFragment,
  TurnView,
} from '../contracts/index.js';

function passingGate(html: string, needsHumanReview: AuditIssue[] = []): GateResult {
  return {
    html,
    badgeWithheld: false,
    conformance: {
      passedChecks: true,
      blockers: [],
      warnings: [],
      needsHumanReview,
    },
  };
}

function withheldGate(html: string, blockers: AuditIssue[]): GateResult {
  return {
    html,
    badgeWithheld: true,
    conformance: {
      passedChecks: false,
      blockers,
      warnings: [],
      needsHumanReview: [],
    },
  };
}

function fragment(gate: GateResult): TurnFragment {
  return { html: gate.html, gate };
}

const PASSING_HTML =
  '<section class="cdaa-template cdaa-module-overview">' +
  '<h2>Module 1 — Getting Started</h2>' +
  '<p>This overview lists the week’s readings, the discussion prompt, and the quiz due date.</p>' +
  '<ul><li>Read chapter 1</li><li>Post to the introductions discussion</li></ul>' +
  '</section>';

const WITHHELD_HTML =
  '<figure class="cdaa-figure">' +
  '<img src="resources/diagram.png">' +
  '<figcaption>Course concept map</figcaption>' +
  '</figure>';

const STUB_FRAGMENTS: TurnFragment[] = [
  fragment(
    passingGate(PASSING_HTML, [
      {
        id: 'link_external',
        severity: 'alert',
        message: 'Contains an external link — confirm the destination is accessible.',
        category: 'alert',
      },
    ]),
  ),
  fragment(
    withheldGate(WITHHELD_HTML, [
      {
        id: 'img-alt-missing',
        severity: 'blocker',
        message: 'Image is missing alt text — add a description before publishing.',
        category: 'error',
      },
    ]),
  ),
];

export function createStubApi(): AppApi {
  return {
    async runTurn(req): Promise<TurnView> {
      return {
        text:
          `You asked: “${req.user}”. Here is a draft module overview plus a figure. ` +
          'The overview passed every accessibility check; the figure is held back until its image gets alt text.',
        fragments: STUB_FRAGMENTS,
        toolsUsed: ['render_template', 'check_contrast', 'audit_html'],
        iterations: 2,
      };
    },

    async importCanvas(_config, courseId): Promise<CanvasImportResult> {
      return {
        courseId,
        name: `Imported course ${courseId}`,
        importedAt: new Date().toISOString(),
        pages: 12,
        assignments: 8,
        files: 23,
        warnings: ['3 pages had inline styles that were normalized on import.'],
      };
    },

    async health(): Promise<RuntimeHealth> {
      return { llm: true, ingest: true };
    },
  };
}
