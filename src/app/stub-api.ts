/**
 * `createStubApi(): AppApi` — canned responses so the Electron shell runs
 * standalone, before the integration track's real `createAppApi` exists.
 *
 * The lead swaps this for the real runtime after both tracks merge (the only
 * change is the argument to `registerIpc` in `main.ts`). Everything here is
 * static, deterministic data shaped exactly like the frozen contracts (the only
 * non-determinism is generated ids / timestamps on create-style calls).
 *
 * The canned turn deliberately includes BOTH a fragment whose gate passed and a
 * fragment whose badge is WITHHELD by a blocker, so the renderer's pass /
 * "checks withheld" rendering is exercised the moment you launch the app. When a
 * streaming `onChunk` callback is supplied it also emits a couple of text chunks
 * and a fragment chunk, so the streaming UI can be demoed on the stub alone.
 *
 * NOTE: this builds `GateResult` literals directly rather than importing the
 * orchestrator's `enforceGate` — the app-shell track depends only on the frozen
 * contract *types*, never on another track's runtime code.
 */
import { WCAG } from '../contracts/index.js';
import type {
  AppApi,
  AuditIssue,
  BrandKit,
  CanvasImportResult,
  CanvasPage,
  CatalogCourse,
  CatalogCourseSummary,
  ContrastResult,
  GateResult,
  RuntimeHealth,
  Session,
  SessionState,
  TextSize,
  ThemeResult,
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

// ── Canned product-layer data ────────────────────────────────────────────────

const CANNED_SESSIONS: Session[] = [
  {
    id: 'sess-welcome',
    title: 'Welcome module overview',
    mode: 'build',
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T09:32:00.000Z',
  },
  {
    id: 'sess-syllabus',
    title: 'Syllabus remediation',
    mode: 'remediate',
    createdAt: '2026-05-03T14:00:00.000Z',
    updatedAt: '2026-05-03T14:21:00.000Z',
  },
];

const CANNED_BRAND_KITS: BrandKit[] = [
  {
    id: 'kit-ocean',
    name: 'Ocean',
    palette: { primary: '#0b5394', secondary: '#38761d' },
    fonts: { heading: 'Georgia', body: 'system-ui' },
    createdAt: '2026-04-10T12:00:00.000Z',
  },
  {
    id: 'kit-sunset',
    name: 'Sunset',
    palette: { primary: '#b45309', secondary: '#7c2d12' },
    createdAt: '2026-04-12T12:00:00.000Z',
  },
];

const CANNED_CANVAS_PAGES: CanvasPage[] = [
  {
    id: 'syllabus',
    title: 'Course Syllabus',
    url: 'https://school.instructure.com/courses/123/pages/syllabus',
    updatedAt: '2026-05-20T08:00:00.000Z',
  },
  {
    id: 'week-1',
    title: 'Week 1 — Getting Started',
    url: 'https://school.instructure.com/courses/123/pages/week-1',
    updatedAt: '2026-05-22T08:00:00.000Z',
  },
  {
    id: 'lab-safety',
    title: 'Lab Safety Guidelines',
    url: 'https://school.instructure.com/courses/123/pages/lab-safety',
    updatedAt: '2026-05-25T08:00:00.000Z',
  },
];

const CANNED_CATALOG_SUMMARIES: CatalogCourseSummary[] = [
  { id: 40830, code: 'ACCTG001', title: 'Introductory Accounting I', college: 'wlac.elumenapp.com' },
  { id: 37988, code: 'ACCTG001', title: 'Introductory Accounting I', college: 'lavc.elumenapp.com' },
];

const CANNED_CATALOG_COURSE: CatalogCourse = {
  id: 40830,
  code: 'ACCTG001',
  title: 'Introductory Accounting I',
  college: 'wlac.elumenapp.com',
  units: 5,
  description:
    'This course is the study of accounting as an information system, examining why it is important ' +
    'and how it is used by investors, creditors, and others to make decisions.',
  slos: [
    'Complete an accounting cycle for a corporation according to GAAP.',
    'Prepare basic financial statements.',
  ],
  objectives: ['1 - Explain the nature and purpose of GAAP and IFRS.'],
  source: 'mirror',
};

/** Build a plausible, internally-consistent ContrastResult for the stub theme. */
function contrast(ratio: number, size: TextSize = 'normal'): ContrastResult {
  const passesAA = ratio >= (size === 'large' ? WCAG.AA_LARGE : WCAG.AA_NORMAL);
  const passesAAA = ratio >= (size === 'large' ? WCAG.AAA_LARGE : WCAG.AAA_NORMAL);
  return { ratio, level: passesAAA ? 'AAA' : passesAA ? 'AA' : 'fail', passesAA, passesAAA, size };
}

export function createStubApi(): AppApi {
  // Per-instance "Allow publishing to Canvas" toggle (the runtime persists this
  // in the meta table; the stub keeps it for the process lifetime).
  let stubPublishEnabled = false;
  return {
    async runTurn(req, onChunk): Promise<TurnView> {
      // Demo the streaming path: a couple of text chunks, a tool chunk, then a
      // gated fragment chunk — mirroring how the real runtime narrates a turn.
      if (onChunk) {
        onChunk({ type: 'text', delta: `You asked: “${req.user}”. ` });
        onChunk({ type: 'text', delta: 'Drafting a module overview plus a figure… ' });
        onChunk({ type: 'tool', name: 'render_template' });
        onChunk({ type: 'fragment', fragment: STUB_FRAGMENTS[0]! });
      }
      return {
        text:
          `You asked: “${req.user}”. Here is a draft module overview plus a figure. ` +
          'The overview passed every accessibility check; the figure is held back until its image gets alt text.',
        fragments: STUB_FRAGMENTS,
        toolsUsed: ['render_template', 'check_contrast', 'audit_html'],
        iterations: 2,
      };
    },

    async saveCanvasAuth(): Promise<void> {
      // Canned stub: pretend the credentials were stored.
    },

    async importCanvas(_baseUrl, courseId): Promise<CanvasImportResult> {
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
      return {
        llm: true,
        ingest: true,
        model: { tag: 'gemma4:e2b', available: true, installCommand: 'ollama pull gemma4:e2b' },
        ingestModel: { available: true },
      };
    },
    async pullModel(onProgress): Promise<void> {
      // The stub model is always "available"; demo a quick progress sweep anyway.
      onProgress?.({ status: 'downloading', total: 100, completed: 100, percent: 100 });
      onProgress?.({ status: 'success' });
    },
    async pullIngestModel(onProgress): Promise<void> {
      onProgress?.({ status: 'downloading', model: 'granite_docling', total: 6, completed: 6, percent: 100 });
      onProgress?.({ status: 'success' });
    },

    // ── Sessions ───────────────────────────────────────────────────────────────
    async createSession(init): Promise<Session> {
      const now = new Date().toISOString();
      return {
        id: `sess-${crypto.randomUUID()}`,
        title: init.title,
        mode: init.mode,
        createdAt: now,
        updatedAt: now,
      };
    },

    async listSessions(): Promise<Session[]> {
      return CANNED_SESSIONS.map((s) => ({ ...s }));
    },

    async loadSession(sessionId): Promise<SessionState | null> {
      const known = CANNED_SESSIONS.find((s) => s.id === sessionId);
      const session: Session = known
        ? { ...known }
        : {
            id: sessionId,
            title: 'Restored session',
            mode: 'guidance',
            createdAt: '2026-05-01T09:00:00.000Z',
            updatedAt: '2026-05-01T09:00:00.000Z',
          };
      return {
        session,
        messages: [
          { role: 'user', content: 'Draft a welcome module overview.' },
          { role: 'assistant', content: 'Here is an accessible module overview draft.' },
        ],
      };
    },

    async deleteSession(_sessionId): Promise<void> {
      // Canned stub: nothing to persist; resolve successfully.
    },

    // ── Brand kits ───────────────────────────────────────────────────────────────
    async resolveBrandTheme(primary, secondary): Promise<ThemeResult> {
      return {
        colors: [
          { role: 'heading', background: '#ffffff', foreground: primary, contrast: contrast(8.2) },
          { role: 'accent', background: primary, foreground: '#ffffff', contrast: contrast(5.1) },
          { role: 'button-bg', background: secondary, foreground: '#ffffff', contrast: contrast(4.7) },
        ],
        warnings: [],
      };
    },

    async listBrandKits(): Promise<BrandKit[]> {
      return CANNED_BRAND_KITS.map((k) => ({ ...k }));
    },

    async saveBrandKit(kit): Promise<BrandKit> {
      return { ...kit, id: `kit-${crypto.randomUUID()}`, createdAt: new Date().toISOString() };
    },

    async deleteBrandKit(_id): Promise<void> {
      // Canned stub: nothing to persist; resolve successfully.
    },

    // ── Read-only Canvas page access ─────────────────────────────────────────────
    async fetchCanvasPage(_baseUrl, _courseId, pageId): Promise<string> {
      return (
        `<h2>${pageId}</h2>` +
        '<p>This is a sample Canvas page body, imported read-only for remediation. ' +
        'It deliberately includes an image without alt text and a low-contrast note so ' +
        'the remediate flow has something to fix.</p>' +
        '<img src="diagram.png">' +
        '<p style="color:#bbbbbb">Last updated last term.</p>'
      );
    },

    async listCanvasPages(_baseUrl, _courseId): Promise<CanvasPage[]> {
      return CANNED_CANVAS_PAGES.map((p) => ({ ...p }));
    },

    async convertDocument(document) {
      return {
        filename: document.filename,
        status: 'success',
        processingTimeMs: 12,
        html:
          `<h2>${document.filename}</h2>` +
          '<p>This sample document was converted locally, then can be checked and repaired before copying into Canvas.</p>',
        text: 'This sample document was converted locally.',
      };
    },

    async screenshotPermissionStatus() {
      return 'granted';
    },

    async listScreenshotSources() {
      return [
        {
          id: 'screen:stub:0',
          kind: 'screen',
          label: 'Entire Screen',
          thumbnailDataUrl: 'data:image/png;base64,',
        },
      ];
    },

    async captureScreenshot(sourceId) {
      return {
        id: `shot-${crypto.randomUUID()}`,
        kind: 'screenshot',
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,QUJD',
        label: sourceId === 'screen:stub:0' ? 'Entire Screen' : sourceId,
        capturedAt: new Date().toISOString(),
      };
    },

    // ── Catalog enrichment (OPTIONAL; laccd-courses-pp-cli) ─────────────────────
    async catalogAvailable() {
      return true;
    },
    async canvasPublishStatus() {
      return { cliAvailable: true, publishEnabled: stubPublishEnabled };
    },
    async setCanvasPublishEnabled(enabled) {
      stubPublishEnabled = enabled;
    },
    async publishCanvasPage(_baseUrl, courseId, pageId, html) {
      if (!stubPublishEnabled) {
        throw new Error('Publishing to Canvas is disabled. Turn on "Allow publishing to Canvas" first.');
      }
      return {
        courseId,
        pageId,
        // Deterministic stand-in for the runtime's SHA-256 (no crypto in the stub).
        contentHash: `stub-${html.length.toString(16)}`,
        publishedAt: new Date().toISOString(),
        canvasUrl: `https://stub.instructure.test/courses/${courseId}/pages/${pageId}`,
      };
    },
    async catalogSearch(_query) {
      return CANNED_CATALOG_SUMMARIES.map((s) => ({ ...s }));
    },
    async catalogGet(id) {
      // Keep the detail consistent with whichever summary row was picked.
      const summary = CANNED_CATALOG_SUMMARIES.find((s) => s.id === id);
      return summary ? { ...CANNED_CATALOG_COURSE, ...summary } : { ...CANNED_CATALOG_COURSE, id };
    },
  };
}
