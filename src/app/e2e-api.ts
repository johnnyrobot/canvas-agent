/**
 * Deterministic AppApi for Electron E2E tests.
 *
 * Activated only from `main.ts` when `CANVAS_AGENT_E2E_API=scripted`. It keeps
 * the public `AppApi` contract unchanged while letting Playwright exercise the
 * real guided renderer and IPC bridge without waiting on local model inference.
 */
import { randomUUID } from 'node:crypto';
import { WCAG } from '../contracts/index.js';
import type {
  AppApi,
  AuditIssue,
  BrandKit,
  CanvasImportResult,
  CanvasPage,
  CatalogCourse,
  CanvasPublishReceipt,
  CanvasPublishStatus,
  CatalogCourseSummary,
  ContrastResult,
  DocumentConversionResult,
  GateResult,
  ProductMode,
  RuntimeHealth,
  ScreenshotAttachment,
  ScreenshotPermissionStatus,
  ScreenshotSource,
  Session,
  SessionState,
  TextSize,
  ThemeResult,
  TurnFragment,
  TurnRequest,
  TurnView,
  UploadedDocument,
} from '../contracts/index.js';

export type E2eScenario =
  | 'default'
  | 'build-pass'
  | 'build-withheld'
  | 'build-warnings'
  | 'remediate-fixed'
  | 'remediate-residual'
  | 'canvas-import'
  | 'guidance'
  | 'runtime-down';

const SOURCE_HTML =
  '<h2>Lab Safety</h2><img src="goggles.png"><p style="color:#aaaaaa;background:#cccccc">Always wear goggles.</p>';

const FIXED_HTML =
  '<section class="cdaa-template cdaa-page-content"><h2>Lab Safety</h2><p>Always wear safety goggles in the lab.</p><img src="goggles.png" alt="Safety goggles on a lab table"></section>';

const BUILD_HTML =
  '<section class="cdaa-template cdaa-module-overview"><h2>Module 1 - Getting Started</h2><p>Read chapter 1 and post to the introductions discussion.</p><ul><li>Read chapter 1</li><li>Post to introductions</li></ul></section>';

const REPAIRED_BUILD_HTML =
  '<section class="cdaa-template cdaa-module-overview"><h2>Needs review</h2><p>This sanitized fragment is safe to preview, but the removed semantic wrapper still blocks the badge.</p></section>';

const CANNED_BRANDS: BrandKit[] = [
  {
    id: 'kit-e2e-ocean',
    name: 'Ocean',
    palette: { primary: '#0B5394', secondary: '#38761D' },
    createdAt: '2026-06-15T00:00:00.000Z',
  },
  {
    id: 'kit-e2e-slate',
    name: 'Slate',
    palette: { primary: '#2D3B45', secondary: '#0374B5' },
    createdAt: '2026-06-14T00:00:00.000Z',
  },
];

const CANNED_PAGES: CanvasPage[] = [
  { id: 'lab-safety', title: 'Lab Safety Guidelines', updatedAt: '2026-06-01T12:00:00.000Z' },
  { id: 'week-1', title: 'Week 1 Overview', updatedAt: '2026-06-02T12:00:00.000Z' },
];

const CANNED_CATALOG_SUMMARIES: CatalogCourseSummary[] = [
  { id: 40830, code: 'ACCTG001', title: 'Introductory Accounting I', college: 'wlac.elumenapp.com' },
];

const CANNED_CATALOG_COURSE: CatalogCourse = {
  id: 40830,
  code: 'ACCTG001',
  title: 'Introductory Accounting I',
  college: 'wlac.elumenapp.com',
  units: 5,
  description: 'E2E scripted course description.',
  slos: ['E2E scripted SLO.'],
  objectives: ['1 - E2E scripted objective.'],
  source: 'live',
};

function contrast(ratio: number, size: TextSize = 'normal'): ContrastResult {
  const passesAA = ratio >= (size === 'large' ? WCAG.AA_LARGE : WCAG.AA_NORMAL);
  const passesAAA = ratio >= (size === 'large' ? WCAG.AAA_LARGE : WCAG.AAA_NORMAL);
  return { ratio, level: passesAAA ? 'AAA' : passesAA ? 'AA' : 'fail', passesAA, passesAAA, size };
}

function issue(id: string, severity: AuditIssue['severity'], message: string): AuditIssue {
  return { id, severity, message, category: severity === 'blocker' || severity === 'error' ? 'error' : 'alert' };
}

function gate(
  html: string,
  opts: {
    blockers?: AuditIssue[];
    warnings?: AuditIssue[];
    needsHumanReview?: AuditIssue[];
  } = {},
): GateResult {
  const blockers = opts.blockers ?? [];
  return {
    html,
    badgeWithheld: blockers.length > 0,
    conformance: {
      passedChecks: blockers.length === 0,
      blockers,
      warnings: opts.warnings ?? [],
      needsHumanReview: opts.needsHumanReview ?? [],
    },
  };
}

function fragment(g: GateResult): TurnFragment {
  return { html: g.html, gate: g };
}

function buildPass(warnings = false): TurnView {
  const g = gate(BUILD_HTML, warnings
    ? {
        warnings: [issue('table-caption', 'warning', 'Table has no caption')],
        needsHumanReview: [issue('external-link', 'alert', 'Confirm the linked resource is accessible')],
      }
    : {});
  return {
    text: warnings ? 'Built with non-blocking findings surfaced.' : 'Built a checked module overview.',
    fragments: [fragment(g)],
    toolsUsed: ['render_template', 'audit_html'],
    iterations: 2,
    mode: 'build',
  };
}

function buildWithheld(): TurnView {
  const g = gate(REPAIRED_BUILD_HTML, {
    blockers: [issue('allowlist-removed-semantic:figure', 'blocker', 'Removed semantic <figure>')],
  });
  return {
    text: 'The HTML was sanitized, but the badge is withheld until the blocker is resolved.',
    fragments: [fragment(g)],
    toolsUsed: ['validate_allowlist', 'audit_html'],
    iterations: 1,
    mode: 'build',
  };
}

function remediateFixed(before = SOURCE_HTML): TurnView {
  const afterGate = gate(FIXED_HTML);
  const frag: TurnFragment = {
    html: afterGate.html,
    gate: afterGate,
    remediateResult: {
      before,
      after: afterGate.html,
      issueDiffs: [
        { issue: issue('image-alt', 'blocker', 'Image missing alt text'), fixed: true },
        { issue: issue('contrast', 'blocker', 'Low contrast text'), fixed: true },
      ],
      gate: afterGate,
    },
  };
  return {
    text: 'Repaired the pasted Canvas HTML and rechecked it.',
    fragments: [frag],
    toolsUsed: ['audit_html', 'check_contrast'],
    iterations: 2,
    mode: 'remediate',
  };
}

function remediateResidual(before = SOURCE_HTML): TurnView {
  const after =
    '<section><h2>Lab Safety</h2><p>Always wear safety goggles.</p><img src="goggles.png"></section>';
  const afterGate = gate(after, {
    blockers: [issue('image-alt', 'blocker', 'Image still needs human alt text')],
    needsHumanReview: [issue('image-context', 'alert', 'Verify the image meaning with the course author')],
  });
  const frag: TurnFragment = {
    html: afterGate.html,
    gate: afterGate,
    remediateResult: {
      before,
      after: afterGate.html,
      issueDiffs: [
        { issue: issue('contrast', 'blocker', 'Low contrast text'), fixed: true },
        { issue: issue('image-alt', 'blocker', 'Image missing alt text'), fixed: false },
      ],
      gate: afterGate,
    },
  };
  return {
    text: 'Some issues were repaired; one blocker remains.',
    fragments: [frag],
    toolsUsed: ['audit_html', 'check_contrast'],
    iterations: 4,
    mode: 'remediate',
  };
}

function guidanceView(req: TurnRequest): TurnView {
  return {
    text: `Use real table headers, captions, and scoped cells. Question: ${req.user}`,
    fragments: [],
    toolsUsed: ['retrieve_kb'],
    iterations: 1,
    mode: 'guidance',
  };
}

function sessionFor(mode: ProductMode, fragments: TurnFragment[] = []): SessionState {
  const session: Session = {
    id: `sess-e2e-${mode}`,
    title: mode === 'build' ? 'E2E generated module' : mode === 'remediate' ? 'E2E repaired page' : 'E2E guidance',
    mode,
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:10:00.000Z',
  };
  return {
    session,
    messages: [
      { role: 'user', content: mode === 'remediate' ? 'Fix this page' : 'Build this page' },
      {
        role: 'assistant',
        content: mode === 'guidance' ? 'Use headers and captions.' : 'Here is the stored work.',
        fragments,
      },
    ],
  };
}

function scenarioFromEnv(value: string | undefined): E2eScenario {
  const known: E2eScenario[] = [
    'default',
    'build-pass',
    'build-withheld',
    'build-warnings',
    'remediate-fixed',
    'remediate-residual',
    'canvas-import',
    'guidance',
    'runtime-down',
  ];
  return known.includes(value as E2eScenario) ? value as E2eScenario : 'default';
}

export function createE2eAppApi(scenarioValue = process.env.CANVAS_AGENT_E2E_SCENARIO): AppApi {
  const scenario = scenarioFromEnv(scenarioValue);
  // Scripted "Allow publishing to Canvas" toggle (process-lifetime, like the stub's).
  let e2ePublishEnabled = false;
  const failIfDown = (): void => {
    if (scenario === 'runtime-down') throw new Error('E2E scripted runtime is down');
  };
  const savedCanvasAuth: string[] = [];

  return {
    async runTurn(req): Promise<TurnView> {
      failIfDown();
      if (req.mode === 'guidance') return guidanceView(req);
      if (req.mode === 'remediate' && req.remediateInput) {
        return scenario === 'remediate-residual'
          ? remediateResidual(req.remediateInput.sourceHtml)
          : remediateFixed(req.remediateInput.sourceHtml);
      }
      if (scenario === 'build-withheld') return buildWithheld();
      return buildPass(scenario === 'build-warnings');
    },

    async saveCanvasAuth(auth): Promise<void> {
      failIfDown();
      savedCanvasAuth.push(auth.baseUrl);
    },

    async importCanvas(_baseUrl, courseId): Promise<CanvasImportResult> {
      failIfDown();
      return {
        courseId,
        name: `E2E course ${courseId}`,
        importedAt: '2026-06-15T00:00:00.000Z',
        pages: CANNED_PAGES.length,
        assignments: 0,
        files: 0,
        warnings: [],
      };
    },

    async health(): Promise<RuntimeHealth> {
      return {
        llm: scenario !== 'runtime-down',
        ingest: scenario !== 'runtime-down',
        model: {
          tag: 'e2e-scripted',
          available: scenario !== 'runtime-down',
          installCommand: 'CANVAS_AGENT_E2E_API=scripted',
        },
        ingestModel: { available: scenario !== 'runtime-down' },
      };
    },
    async pullModel(onProgress): Promise<void> {
      failIfDown();
      onProgress?.({ status: 'success' });
    },
    async pullIngestModel(onProgress): Promise<void> {
      failIfDown();
      onProgress?.({ status: 'success' });
    },

    async createSession(init): Promise<Session> {
      failIfDown();
      return {
        id: `sess-${randomUUID()}`,
        title: init.title,
        mode: init.mode,
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      };
    },

    async listSessions(): Promise<Session[]> {
      return [
        sessionFor('build', buildPass().fragments).session,
        sessionFor('remediate', remediateFixed().fragments).session,
        sessionFor('guidance').session,
      ];
    },

    async loadSession(sessionId): Promise<SessionState | null> {
      failIfDown();
      if (sessionId.includes('remediate')) return sessionFor('remediate', remediateFixed().fragments);
      if (sessionId.includes('guidance')) return sessionFor('guidance');
      return sessionFor('build', buildPass().fragments);
    },

    async deleteSession(): Promise<void> {
      failIfDown();
    },

    async resolveBrandTheme(primary, secondary): Promise<ThemeResult> {
      failIfDown();
      return {
        colors: [
          { role: 'heading', background: '#ffffff', foreground: primary, contrast: contrast(8.2) },
          { role: 'accent', background: primary, foreground: '#ffffff', contrast: contrast(5.4) },
          { role: 'button-bg', background: secondary, foreground: '#ffffff', contrast: contrast(4.8) },
        ],
        warnings: [],
      };
    },

    async listBrandKits(): Promise<BrandKit[]> {
      return CANNED_BRANDS.map((kit) => ({ ...kit }));
    },

    async saveBrandKit(kit): Promise<BrandKit> {
      failIfDown();
      return { ...kit, id: `kit-${randomUUID()}`, createdAt: '2026-06-15T00:00:00.000Z' };
    },

    async deleteBrandKit(): Promise<void> {
      failIfDown();
    },

    async fetchCanvasPage(_baseUrl, _courseId, pageId): Promise<string> {
      failIfDown();
      return `<h2>${pageId}</h2><img src="diagram.png"><p style="color:#aaa;background:#ccc">Imported for repair.</p>`;
    },

    async listCanvasPages(): Promise<CanvasPage[]> {
      failIfDown();
      return CANNED_PAGES.map((page) => ({ ...page }));
    },

    async convertDocument(document: UploadedDocument): Promise<DocumentConversionResult> {
      failIfDown();
      return {
        filename: document.filename,
        status: 'success',
        processingTimeMs: 3,
        html: `<h2>${document.filename}</h2><p>Converted document content.</p>`,
        text: 'Converted document content.',
      };
    },

    async screenshotPermissionStatus(): Promise<ScreenshotPermissionStatus> {
      return scenario === 'runtime-down' ? 'unknown' : 'granted';
    },

    async listScreenshotSources(): Promise<ScreenshotSource[]> {
      failIfDown();
      return [
        {
          id: 'screen:e2e:0',
          kind: 'screen',
          label: 'E2E Screen',
          thumbnailDataUrl: 'data:image/png;base64,',
        },
      ];
    },

    async captureScreenshot(sourceId): Promise<ScreenshotAttachment> {
      failIfDown();
      return {
        id: `shot-${randomUUID()}`,
        kind: 'screenshot',
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,QUJD',
        label: sourceId,
        capturedAt: '2026-06-15T00:00:00.000Z',
      };
    },

    async catalogAvailable(): Promise<boolean> {
      return scenario !== 'runtime-down';
    },
    async canvasPublishStatus(): Promise<CanvasPublishStatus> {
      return { cliAvailable: scenario !== 'runtime-down', publishEnabled: e2ePublishEnabled };
    },
    async setCanvasPublishEnabled(enabled): Promise<void> {
      failIfDown();
      e2ePublishEnabled = enabled;
    },
    async publishCanvasPage(_baseUrl, courseId, pageId, html): Promise<CanvasPublishReceipt> {
      failIfDown();
      if (!e2ePublishEnabled) {
        throw new Error('Publishing to Canvas is disabled. Turn on "Allow publishing to Canvas" first.');
      }
      return {
        courseId,
        pageId,
        contentHash: `e2e-${html.length.toString(16)}`,
        publishedAt: new Date().toISOString(),
        canvasUrl: `https://e2e.instructure.test/courses/${courseId}/pages/${pageId}`,
      };
    },
    async catalogSearch(): Promise<CatalogCourseSummary[]> {
      failIfDown();
      return CANNED_CATALOG_SUMMARIES.map((s) => ({ ...s }));
    },
    async catalogGet(id): Promise<CatalogCourse> {
      failIfDown();
      return { ...CANNED_CATALOG_COURSE, id };
    },
  };
}
