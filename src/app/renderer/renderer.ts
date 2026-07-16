/**
 * Simplified renderer shell.
 *
 * The Paper redesign replaces the old always-visible three-column workbench with
 * a progressive, screen-based flow: choose one job, answer one focused prompt,
 * then review one result. This module owns only UI state and AppApi calls. The
 * safety invariants remain in the lower-level modules: gated HTML is rendered
 * through the sandboxed preview frame, raw/user/model text is textContent, and
 * the Electron renderer still reaches the runtime only through the preload
 * bridge.
 */
import { composeAlignmentPrompt } from './alignment.js';
import { previewFrame, previewSrcdoc } from './preview.js';
import { api, byId, copyText, el, errorMessage, later, onReady, readStorage, writeStorage, type El } from './ui.js';
import { turnViewToVm, type FragmentVm } from '../view.js';
import { appChromeClass, themedScreenRoot, uiThemeRootClass, type UiTheme } from './ui-theme.js';
import { createRemediationPanel, type RemediationDeps, type RemediationIssue, type RemediationView } from './remediation.js';
import { catalogSummaryLabel, catalogPromptLines } from './catalog-view.js';
import {
  createInstHome,
  createInstAsk,
  createInstBrand,
  createInstIngest,
  type InstDeps,
  type InstTarget,
  type InstAskData,
  type InstAskDeps,
  type InstBrandData,
  type InstIngestData,
  type InstIngestDeps,
  type InstRole,
} from './institutional-screens.js';
import type {
  AuditIssue,
  Severity as GateSeverity,
  BrandKit,
  CanvasPage,
  CanvasPublishStatus,
  CatalogCourse,
  CatalogCourseSummary,
  DocumentConversionResult,
  ProductMode,
  ScreenshotAttachment,
  ScreenshotPermissionStatus,
  ScreenshotSource,
  Session,
  SessionState,
  TemplateType,
  ThemeResult,
  TurnRequest,
  TurnView,
  UploadedDocument,
} from '../../contracts/index.js';

type Screen =
  | 'build-template'
  | 'build-details'
  | 'build-brand'
  | 'build-result'
  | 'remediate-source'
  | 'remediate-provide'
  | 'alignment'
  | 'brand-manager'
  | 'saved-work'
  | 'remediate-review'
  | 'inst-home'
  | 'inst-ask'
  | 'inst-brand'
  | 'inst-ingest';

type SourceMode = 'paste' | 'canvas' | 'document';
type ArtifactView = 'preview' | 'code';

interface FileLike {
  name: string;
  type: string;
  size: number;
}

interface FileListLike {
  length: number;
  item(index: number): FileLike | null;
  [index: number]: FileLike | undefined;
}

interface FileReaderEvent {
  target: { result: string | ArrayBuffer | null } | null;
}

declare class FileReader {
  result: string | ArrayBuffer | null;
  onload: ((event: FileReaderEvent) => void) | null;
  onerror: (() => void) | null;
  readAsDataURL(file: FileLike): void;
}

interface TemplateOption {
  id: TemplateType;
  title: string;
  body: string;
}

interface State {
  screen: Screen;
  previousScreen: Screen;
  busy: boolean;
  error: string | undefined;
  notice: string | undefined;
  health: 'checking' | 'ready' | 'degraded';
  healthText: string;
  /** Set when the configured model isn't installed — drives the in-app download affordance. */
  modelMissingTag: string | undefined;
  /** Set while a first-run model download is in flight. */
  modelPull: { text: string; percent: number | undefined } | undefined;
  /** Set when the Docling conversion models aren't installed (PDF/scanned-doc support). */
  ingestModelMissing: boolean;
  /** Set while a first-run Docling model download is in flight. */
  ingestPull: { text: string; percent: number | undefined } | undefined;
  activeSessionId: string | undefined;
  sessions: Session[];
  sessionsLoaded: boolean;
  selectedTemplate: TemplateType;
  showAllTemplates: boolean;
  buildTitle: string;
  buildRhythm: string;
  buildTasks: string;
  brandKits: BrandKit[];
  brandKitsLoaded: boolean;
  selectedBrandId: string | undefined;
  theme: ThemeResult | undefined;
  themeKey: string | undefined;
  buildView: TurnView | undefined;
  sourceMode: SourceMode;
  remediateSourceHtml: string;
  documentFileName: string | undefined;
  documentMime: string;
  documentSizeBytes: number;
  documentDataUrl: string | undefined;
  documentConversion: DocumentConversionResult | undefined;
  canvasBaseUrl: string;
  canvasCourseId: string;
  canvasToken: string;
  canvasPages: CanvasPage[];
  canvasPagesLoaded: boolean;
  selectedCanvasPageId: string | undefined;
  remediateView: TurnView | undefined;
  /** Canvas publish availability (CLI presence + opt-in toggle); loaded lazily. */
  publishStatus: CanvasPublishStatus | undefined;
  publishStatusLoaded: boolean;
  /** Two-step confirm state for the review panel's Publish button. */
  publishConfirming: boolean;
  publishBusy: boolean;
  guidanceQuestion: string;
  /** Half-typed inst-ask question, preserved across attach/capture re-renders. */
  askDraft: string;
  guidanceView: TurnView | undefined;
  screenshotPermission: ScreenshotPermissionStatus | undefined;
  screenshotSources: ScreenshotSource[];
  screenshots: ScreenshotAttachment[];
  alignmentContent: string;
  alignmentObjectives: string;
  alignmentRubric: string;
  showCode: boolean;
  artifactView: ArtifactView;
  /**
   * UI chrome theme (light/dark) for the redesign screens — distinct from
   * `theme` above, which is the resolved brand-kit `ThemeResult`.
   */
  uiTheme: UiTheme;

  // ── Catalog enrichment (optional; see src/catalog/README.md) ───────────────
  /** Whether the local LACCD catalog CLI is installed. `undefined` = not yet checked. */
  catalogAvailable: boolean | undefined;
  catalogQuery: string;
  catalogResults: CatalogCourseSummary[];
  catalogSelected: CatalogCourse | undefined;
  catalogBusy: boolean;
  catalogError: string | undefined;
}

const DEFAULT_BRAND: BrandKit = {
  id: 'default-ocean',
  name: 'Ocean',
  palette: { primary: '#0B5394', secondary: '#38761D' },
  createdAt: '2026-01-01T00:00:00.000Z',
};

const TEMPLATE_OPTIONS: TemplateOption[] = [
  {
    id: 'module-overview',
    title: 'Module overview',
    body: 'Weekly introduction, readings, due dates, and learner expectations.',
  },
  {
    id: 'assignment',
    title: 'Assignment instructions',
    body: 'Prompt, submission details, criteria, and support notes.',
  },
  {
    id: 'page-content',
    title: 'General content page',
    body: 'A flexible Canvas page for readings, notes, or resources.',
  },
  { id: 'syllabus', title: 'Syllabus', body: 'Course policies, expectations, and support resources.' },
  { id: 'discussion', title: 'Discussion', body: 'Participation prompt, expectations, and response guidance.' },
  { id: 'lecture-notes', title: 'Lecture notes', body: 'Structured notes with headings, lists, and callouts.' },
  { id: 'study-guide', title: 'Study guide', body: 'Review topics, key ideas, and practice prompts.' },
  { id: 'rubric', title: 'Rubric', body: 'Criteria, performance levels, and review-ready descriptions.' },
];

const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024;

const UI_THEME_STORAGE_KEY = 'canvasAgent.uiTheme';

/** Load the persisted UI theme preference, defaulting to 'light' on any failure. */
function loadUiTheme(): UiTheme {
  return readStorage(UI_THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
}

const state: State = {
  screen: 'inst-home',
  previousScreen: 'inst-home',
  busy: false,
  error: undefined,
  notice: undefined,
  health: 'checking',
  healthText: 'Local runtime checking',
  modelMissingTag: undefined,
  modelPull: undefined,
  ingestModelMissing: false,
  ingestPull: undefined,
  activeSessionId: undefined,
  sessions: [],
  sessionsLoaded: false,
  selectedTemplate: 'module-overview',
  showAllTemplates: false,
  buildTitle: 'Module 1 - Getting Started',
  buildRhythm: '',
  buildTasks: '',
  brandKits: [],
  brandKitsLoaded: false,
  selectedBrandId: undefined,
  theme: undefined,
  themeKey: undefined,
  buildView: undefined,
  sourceMode: 'paste',
  remediateSourceHtml: '<h2>Week 1</h2>\n<p style="color:#bbbbbb">Last updated last term.</p>\n<img src="diagram.png">',
  documentFileName: undefined,
  documentMime: '',
  documentSizeBytes: 0,
  documentDataUrl: undefined,
  documentConversion: undefined,
  canvasBaseUrl: '',
  canvasCourseId: '',
  canvasToken: '',
  canvasPages: [],
  canvasPagesLoaded: false,
  selectedCanvasPageId: undefined,
  remediateView: undefined,
  publishStatus: undefined,
  publishStatusLoaded: false,
  publishConfirming: false,
  publishBusy: false,
  guidanceQuestion: 'How do I make a table accessible in Canvas?',
  askDraft: '',
  guidanceView: undefined,
  screenshotPermission: undefined,
  screenshotSources: [],
  screenshots: [],
  alignmentContent: '',
  alignmentObjectives: '',
  alignmentRubric: '',
  showCode: false,
  artifactView: 'preview',
  uiTheme: loadUiTheme(),
  catalogAvailable: undefined,
  catalogQuery: '',
  catalogResults: [],
  catalogSelected: undefined,
  catalogBusy: false,
  catalogError: undefined,
};

let root: El | undefined;

function mount(): void {
  const appRoot = byId('app');
  if (!appRoot) return;
  root = appRoot;
  render();
  void refreshHealth();
  void loadBrandKits();
}

function render(): void {
  if (!root) return;
  // Every screen is chrome-themed now — re-theme the GLOBAL chrome (appbar,
  // health/status, banners, app footer; see `.app--dark` in index.html)
  // independently of the per-screen `inst`/`remed`/`classic` root below.
  root.className = appChromeClass(root.className, state.uiTheme);
  const body = renderScreen();
  const themedRoot = themedScreenRoot(state.screen);
  if (themedRoot) {
    body.main.className = uiThemeRootClass(body.main.className, themedRoot, state.uiTheme);
    body.header.append(themeToggleButton());
  }
  const children = [
    body.header,
    ...(state.error ? [statusBanner(state.error, 'error')] : []),
    ...(state.notice ? [statusBanner(state.notice, 'notice')] : []),
    body.main,
  ];
  root.replaceChildren(...children);
}

/**
 * Dark-mode toggle shown on the five redesign screens (see `themedScreenRoot`).
 * Reflects state via `aria-pressed`; the visible label doubles as the accessible
 * name so there's no separate label/name to keep in sync.
 */
function themeToggleButton(): El {
  const dark = state.uiTheme === 'dark';
  const btn = el(
    'button',
    { type: 'button', class: 'appbar__theme-toggle', 'aria-pressed': String(dark), 'data-testid': 'theme-toggle' },
    el('span', { 'aria-hidden': 'true' }, dark ? '☀' : '🌙'),
    'Dark mode',
  );
  btn.addEventListener('click', () => {
    state.uiTheme = dark ? 'light' : 'dark';
    writeStorage(UI_THEME_STORAGE_KEY, state.uiTheme);
    render();
  });
  return btn;
}

interface ScreenParts {
  header: El;
  main: El;
}

function renderScreen(): ScreenParts {
  switch (state.screen) {
    case 'build-template':
      return {
        header: flowHeader('Build a Canvas page', 'Step 1 of 4', 25, 'inst-home'),
        main: renderBuildTemplate(),
      };
    case 'build-details':
      return {
        header: flowHeader('Module overview', 'Step 2 of 4', 50, 'build-template'),
        main: renderBuildDetails(),
      };
    case 'build-brand':
      return {
        header: flowHeader('Brand and accessibility', 'Step 3 of 4', 75, 'build-details'),
        main: renderBuildBrand(),
      };
    case 'build-result':
      return {
        header: simpleHeader('Review generated page', buildHeaderBadge(), buildHeaderKind(), 'build-brand'),
        main: renderBuildResult(),
      };
    case 'remediate-source':
      return {
        header: simpleHeader('Check accessibility', 'Remediate', 'amber', 'inst-home'),
        main: renderRemediateSource(),
      };
    case 'remediate-provide':
      return {
        header: simpleHeader(
          remediateSourceTitle(),
          'Switch source',
          'neutral',
          'remediate-source',
          () => go('remediate-source'),
        ),
        main: renderRemediateProvide(),
      };
    case 'alignment':
      return {
        header: simpleHeader('Alignment coach', 'Guidance mode', 'blue', 'inst-home'),
        main: renderAlignment(),
      };
    case 'brand-manager':
      return {
        header: simpleHeader('Brand kits', 'New kit', 'blue', state.previousScreen, () => newBrandKit()),
        main: renderBrandManager(),
      };
    case 'saved-work':
      return {
        header: simpleHeader('Saved work and more', 'New session', 'blue', state.previousScreen, () => newSession()),
        main: renderSavedWork(),
      };
    case 'remediate-review':
      return {
        header: simpleHeader('Accessibility review', 'Remediate', 'amber', 'inst-home'),
        main: renderRemediationReview(),
      };
    case 'inst-home':
      return { header: instHomeHeader(), main: renderInstHome() };
    case 'inst-ask':
      return { header: simpleHeader('Ask & Answer', 'Redesign', 'blue', 'inst-home'), main: renderInstAsk() };
    case 'inst-brand':
      return { header: simpleHeader('Brand kit', 'Redesign', 'blue', 'inst-home'), main: renderInstBrand() };
    case 'inst-ingest':
      return { header: simpleHeader('Document ingest', 'Redesign', 'blue', 'inst-home'), main: renderInstIngest() };
  }
}

function institutionalDeps(): InstDeps {
  return {
    onNavigate: (target: InstTarget) => {
      switch (target) {
        case 'build':
          return go('build-template');
        case 'remediation':
          return go('remediate-source');
        case 'ask':
          return go('inst-ask');
        case 'brand':
          return go('inst-brand');
        case 'ingest':
          return go('inst-ingest');
        case 'fix':
          return go('remediate-source');
        case 'saved':
          return go('saved-work');
        case 'alignment':
          return go('alignment');
        case 'brand-manager':
          return go('brand-manager');
      }
    },
  };
}

function renderInstHome(): El {
  return createInstHome(institutionalDeps()).element;
}

// The inst-* preview screens bind to whatever real state exists (the latest
// guidance answer, the current brand kit + resolved theme, the last document
// conversion), falling back to their representative seed when none is present.
function instAskData(): InstAskData | undefined {
  const view = state.guidanceView;
  const answer = view?.text.trim();
  if (!answer) return undefined;
  const toolCount = view?.toolsUsed?.length ?? 0;
  const tools = toolCount > 0 ? ` · ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : '';
  return {
    question: state.guidanceQuestion.trim() || 'Your question',
    meta: `Answered on-device · Gemma${tools}`,
    answer,
  };
}

function instBrandData(): InstBrandData | undefined {
  void ensureCurrentTheme();
  const theme = state.theme;
  if (!theme || theme.colors.length === 0) return undefined;
  const kit = currentBrandKit();
  const roles: InstRole[] = theme.colors.map((c) => ({
    sample: c.background,
    name: roleName(c.role),
    ratio: `${c.contrast.ratio.toFixed(2)} : 1`,
    level: c.contrast.level === 'AAA' ? 'AAA' : 'AA',
  }));
  const c0 = theme.colors[0];
  const c1 = theme.colors[1] ?? c0;
  return {
    primary: kit.palette.primary,
    secondary: kit.palette.secondary,
    roles,
    note:
      theme.warnings.length > 0
        ? { ok: false, text: theme.warnings[0]! }
        : { ok: true, text: 'Every role passes WCAG AA — this palette is safe to ship.' },
    kits: allBrandKits().map((k) => ({
      name: k.name,
      gradient: `linear-gradient(90deg, ${k.palette.primary} 50%, ${k.palette.secondary} 50%)`,
      meta: `${theme.colors.length} roles`,
    })),
    preview: {
      bannerBg: c0?.background ?? kit.palette.primary,
      bannerFg: c0?.foreground ?? '#FFFFFF',
      calloutBg: c1?.background ?? kit.palette.secondary,
      calloutFg: c1?.foreground ?? '#FFFFFF',
      btnBg: c0?.background ?? kit.palette.primary,
      btnFg: c0?.foreground ?? '#FFFFFF',
    },
  };
}

function instIngestData(): InstIngestData | undefined {
  const conv = state.documentConversion;
  if (!conv) return undefined;
  const content = conv.markdown ?? conv.text ?? conv.html ?? '(no text output)';
  const ext = (conv.filename.split('.').pop() ?? 'DOC').toUpperCase().slice(0, 4);
  const hasOutput = Boolean(conv.html || conv.markdown || conv.text);
  const kind = conv.html ? 'HTML' : conv.markdown ? 'Markdown' : 'Text';
  return {
    fileName: conv.filename,
    ext,
    status: conv.status,
    statusColor: hasOutput ? 'var(--color-forest)' : 'var(--color-oak)',
    content,
    meta: `${conv.processingTimeMs} ms · ${kind}`,
  };
}

/** Permission-state copy for the screenshot attach affordance (mirrors the retired panel's hint). */
function screenshotHint(): string {
  return state.screenshotPermission && state.screenshotPermission !== 'granted'
    ? `Screen recording permission: ${state.screenshotPermission}. macOS may ask before the first capture.`
    : 'Screenshots are summarized on-device for this question; raw pixels are not stored in the session.';
}

function instAskDeps(): InstAskDeps {
  return {
    onAsk: (question: string) => {
      state.guidanceQuestion = question.trim();
      state.askDraft = '';
      void runGuidance(state.guidanceQuestion);
    },
    busy: state.busy,
    draft: state.askDraft,
    // State-only; the DOM already shows the text, so no render() here.
    onDraftChange: (value: string) => {
      state.askDraft = value;
    },
    screenshots: state.screenshots.map((shot) => ({ id: shot.id, label: shot.label, dataUrl: shot.dataUrl })),
    onAttachScreenshot: () => void loadScreenshotSources(),
    onRemoveScreenshot: (id: string) => removeScreenshot(id),
    screenshotSources: state.screenshotSources.map((source) => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
      thumbnailDataUrl: source.thumbnailDataUrl,
    })),
    onCaptureSource: (id: string) => void captureScreenshot(id),
    screenshotHint: screenshotHint(),
  };
}

function instIngestDeps(): InstIngestDeps {
  return {
    onFile: (event: unknown) => void ingestDocument(event),
    busy: state.busy,
  };
}

function renderInstAsk(): El {
  return createInstAsk(institutionalDeps(), instAskData(), instAskDeps()).element;
}
function renderInstBrand(): El {
  return createInstBrand(institutionalDeps(), instBrandData()).element;
}
function renderInstIngest(): El {
  return createInstIngest(institutionalDeps(), instIngestData(), instIngestDeps()).element;
}

/** Boot/hub header for inst-home: brand mark + health, no back button. */
function instHomeHeader(): El {
  return el(
    'header',
    { class: 'appbar' },
    el('div', { class: 'appbar__mark' }, 'CA'),
    el('div', { class: 'appbar__title-main' }, 'Canvas Agent'),
    el('div', { class: 'appbar__spacer' }),
    healthStatus(),
  );
}

function flowHeader(title: string, subtitle: string, pct: number, back: Screen): El {
  return el(
    'header',
    { class: 'appbar' },
    backButton(back),
    el('div', { class: 'appbar__title' }, el('div', { class: 'appbar__title-main' }, title), el('div', { class: 'appbar__title-sub' }, subtitle)),
    el('div', { class: 'appbar__spacer' }),
    progressWrap(pct, subtitle),
  );
}

function simpleHeader(
  title: string,
  badge: string,
  kind: 'blue' | 'green' | 'amber' | 'neutral',
  back: Screen,
  badgeAction?: () => void,
): El {
  const badgeClass = kind === 'blue'
    ? 'pill pill--blue'
    : kind === 'green'
      ? 'pill pill--green'
      : kind === 'amber'
        ? 'pill pill--amber'
        : 'pill';
  return el(
    'header',
    { class: 'appbar' },
    backButton(back),
    el('div', { class: 'appbar__title-main' }, title),
    el('div', { class: 'appbar__spacer' }),
    badgeAction ? actionButton(badge, badgeAction, badgeClass) : el('div', { class: badgeClass }, badge),
  );
}

function backButton(screen: Screen): El {
  return actionButton('<', () => go(screen), 'appbar__back', 'Back');
}

function progressBar(width: number): El {
  const bar = el('div', { class: 'progress__bar' });
  bar.setAttribute('style', `width:${width}%;`);
  return bar;
}

/**
 * A labelled `.progress` track. Plain `<div>`s carry the implicit ARIA role
 * `generic`, which does not support naming (axe: `aria-prohibited-attr`) — so
 * `aria-label` alone on a bare `.progress` div is invalid. `role="progressbar"`
 * both fixes that and gives the indicator a real accessible value it never had.
 */
function progressWrap(pct: number, label: string): El {
  return el(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-label': label,
      'aria-valuenow': String(pct),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    },
    progressBar(pct),
  );
}

function healthStatus(): El {
  const cls = state.health === 'ready' ? 'status' : 'status status--warn';
  const children: Array<El | string> = [el('span', { class: 'status__dot' }), state.healthText];
  if (state.modelPull) {
    children.push(
      progressWrap(state.modelPull.percent ?? 0, 'Model download progress'),
      el('span', { class: 'status__pull' }, state.modelPull.text),
    );
  } else if (state.modelMissingTag) {
    children.push(
      actionButton(
        'Download model',
        () => void downloadModel(),
        'btn btn--small',
        `Download model ${state.modelMissingTag}`,
        'download-model',
      ),
    );
  }
  // Docling document models (independent of the LLM): offer a first-run download
  // for PDF/scanned-doc support. Office/web docs convert without them.
  if (state.ingestPull) {
    children.push(
      progressWrap(state.ingestPull.percent ?? 0, 'Document model download progress'),
      el('span', { class: 'status__pull' }, state.ingestPull.text),
    );
  } else if (state.ingestModelMissing) {
    children.push(
      actionButton(
        'Download document models',
        () => void downloadIngestModel(),
        'btn btn--small',
        'Download Docling document-conversion models (for PDF and scanned documents)',
        'download-ingest-model',
      ),
    );
  }
  return el('div', { class: cls, 'data-testid': 'health' }, ...children);
}

function screen(...children: El[]): El {
  return el('main', { class: 'screen' }, ...children);
}

function stack(...children: El[]): El {
  return el('div', { class: 'stack' }, ...children);
}

function wideStack(...children: El[]): El {
  return el('div', { class: 'stack stack--wide' }, ...children);
}

function intro(title: string, body: string, centered = false): El {
  return el(
    'div',
    { class: centered ? 'intro intro--center' : 'intro' },
    el('h1', { class: 'intro__title' }, title),
    el('p', { class: 'intro__body' }, body),
  );
}

function statusBanner(message: string, kind: 'error' | 'notice'): El {
  return el(
    'div',
    { class: 'banner-wrap' },
    el(
      'div',
      {
        class: kind === 'error' ? 'error-banner' : 'notice-banner',
        'data-testid': kind === 'error' ? 'error-banner' : 'notice-banner',
      },
      message,
    ),
  );
}

function renderBuildTemplate(): El {
  const shown = state.showAllTemplates ? TEMPLATE_OPTIONS : TEMPLATE_OPTIONS.slice(0, 3);
  return screen(
    stack(
      intro('Which page are you building?', 'Choose the closest fit. You can rename sections later.'),
      el(
        'div',
        { class: 'choice-list' },
        ...shown.map((template) => templateRow(template)),
        actionButton(
          state.showAllTemplates ? 'Show fewer templates' : 'Show more templates',
          () => {
            state.showAllTemplates = !state.showAllTemplates;
            render();
          },
          'choice',
        ),
      ),
      splitRow(
        el('div', { class: 'hint' }, 'Next: title, dates, and learner tasks.'),
        actionButton('Continue', () => go('build-details'), 'btn', undefined, 'build-template-continue'),
      ),
    ),
  );
}

function templateRow(template: TemplateOption): El {
  const selected = state.selectedTemplate === template.id;
  const row = actionButton(
    '',
    () => {
      state.selectedTemplate = template.id;
      render();
    },
    selected ? 'choice choice--primary' : 'choice',
  );
  row.replaceChildren(
    el('span', { class: selected ? 'radio radio--on' : 'radio' }),
    el('span', { class: 'choice__copy' }, el('span', { class: 'choice__title' }, template.title), el('span', { class: 'choice__body' }, template.body)),
  );
  return row;
}

function renderBuildDetails(): El {
  void ensureCatalogAvailable();
  const title = textarea('Page title', state.buildTitle, 'field field--single', 'build-title');
  const rhythm = textarea('Due dates or weekly rhythm', state.buildRhythm, 'field field--single', 'build-rhythm');
  const tasks = textarea('Learner tasks for this week', state.buildTasks, 'field', 'build-tasks');
  return screen(
    stack(
      intro('What should this page say?', 'Add the details you already know. Empty fields can become clear placeholders.'),
      el('div', { class: 'field-stack' }, title, rhythm, tasks),
      ...(state.catalogAvailable === true ? [catalogPanel()] : []),
      splitRow(
        el('div', { class: 'hint' }, 'The app will not invent course outcomes.'),
        actionButton('Continue', () => {
          state.buildTitle = title.value.trim() || 'Module 1 - Getting Started';
          state.buildRhythm = rhythm.value.trim();
          state.buildTasks = tasks.value.trim();
          go('build-brand');
        }, 'btn', undefined, 'build-details-continue'),
      ),
    ),
  );
}

/**
 * "Official course outcomes" panel — optional LACCD catalog enrichment.
 * Only rendered by the caller when `state.catalogAvailable === true`; see
 * `ensureCatalogAvailable()` and `src/catalog/README.md`.
 */
function catalogPanel(): El {
  if (state.catalogSelected) return catalogSelectedPanel(state.catalogSelected);
  const search = textarea('Search the LACCD catalog (e.g. course code or title)', state.catalogQuery, 'field field--single', 'catalog-search-input');
  const runSearch = () => {
    state.catalogQuery = search.value;
    void searchCatalog(search.value);
  };
  const searchButton = actionButton(state.catalogBusy ? 'Searching' : 'Search catalog', runSearch, 'btn btn--secondary btn--small', undefined, 'catalog-search');
  searchButton.disabled = state.catalogBusy;
  return el(
    'section',
    { class: 'panel' },
    el('h2', { class: 'panel__title' }, 'Official course outcomes'),
    el(
      'p',
      { class: 'panel__body' },
      'Search the local LACCD catalog mirror to attach official student learning outcomes to this page. This may query the public eLumen API when the local mirror has no match.',
    ),
    el('div', { class: 'field-stack' }, search),
    splitRow(
      el(
        'div',
        { class: 'hint' },
        state.catalogError ?? (state.catalogResults.length > 0 ? `${state.catalogResults.length} result(s)` : ''),
      ),
      searchButton,
    ),
    ...(state.catalogResults.length > 0
      ? [el('div', { class: 'list', 'data-testid': 'catalog-results' }, ...state.catalogResults.map((s) => catalogResultRow(s)))]
      : []),
  );
}

function catalogResultRow(summary: CatalogCourseSummary): El {
  const row = actionButton(catalogSummaryLabel(summary), () => void selectCatalogCourse(summary.id), 'row', undefined, 'catalog-result');
  row.disabled = state.catalogBusy;
  return row;
}

function catalogSelectedPanel(course: CatalogCourse): El {
  return el(
    'section',
    { class: 'panel panel--green' },
    el('h2', { class: 'panel__title' }, 'Official course outcomes'),
    el('p', { class: 'panel__body' }, `${course.code} — ${course.title}`),
    el('p', { class: 'panel__body' }, `${course.slos.length} outcome(s) attached`),
    ...(course.slos.length > 0 ? [el('div', { class: 'list' }, ...course.slos.map((slo) => el('p', { class: 'panel__body' }, slo)))] : []),
    splitRow(
      el('div', { class: 'hint' }, 'These outcomes will be included in the generated page prompt.'),
      actionButton('Remove', () => {
        state.catalogSelected = undefined;
        render();
      }, 'btn btn--secondary btn--small', undefined, 'catalog-remove'),
    ),
  );
}

function renderBuildBrand(): El {
  void ensureCurrentTheme();
  const kit = currentBrandKit();
  return screen(
    stack(
      intro('Use this brand kit?', 'Canvas Agent checks the palette before it appears in generated HTML.'),
      el(
        'section',
        { class: 'panel split-row' },
        el(
          'div',
          { class: 'split-row' },
          swatches(kit.palette.primary, kit.palette.secondary),
          el('div', {}, el('h2', { class: 'panel__title' }, kit.name), el('p', { class: 'panel__body' }, 'Saved brand kit')),
        ),
        actionButton('Change', () => {
          state.previousScreen = 'build-brand';
          go('brand-manager');
        }, 'btn btn--secondary btn--small', undefined, 'brand-change'),
      ),
      contrastPanel(),
      splitRow(
        el('div', { class: 'hint' }, 'Next: generate and run the output gate.'),
        actionButton(state.busy ? 'Generating' : 'Generate page', () => void generateBuild(), 'btn', undefined, 'build-generate'),
      ),
    ),
  );
}

function renderBuildResult(): El {
  const passed = firstPassedFragment(state.buildView);
  const blocked = firstBlockedFragment(state.buildView);
  const fragment = passed ?? blocked;
  return screen(
    stack(
      intro(
        passed ? 'One section is ready to copy.' : blocked ? 'Generated HTML needs review.' : 'No checked section is ready yet.',
        passed
          ? 'The generated section passed the output gate.'
          : blocked
            ? 'The gate repaired the HTML enough to preview it safely, but blockers still withhold the badge.'
            : 'Generate a page first to see the checked preview.',
      ),
      fragment ? fragmentCard(fragment, 'Generated Canvas page', true) : emptyPanel('Generate a page first to see the checked preview.'),
      ...(fragment ? fragmentIssuesPanels(fragment) : []),
      btnRow(
        actionButton('More', () => {
          state.previousScreen = 'build-result';
          go('saved-work');
        }, 'btn btn--secondary'),
        downloadButton('Download HTML', passed, 'download-ready-html'),
        copyButton('Copy ready HTML', passed),
      ),
    ),
  );
}

function renderRemediateSource(): El {
  return screen(
    stack(
      intro('What should we check?', 'Choose where the existing content comes from.'),
      el(
        'div',
        { class: 'choice-list' },
        choice('1', 'Paste HTML', 'Best when you already copied content from Canvas.', () => {
          state.sourceMode = 'paste';
          go('remediate-provide');
        }, 'warn', 'Use this', 'remediate-source-paste'),
        choice('2', 'Import a read-only Canvas page', 'Fetch content without changing Canvas.', () => {
          state.sourceMode = 'canvas';
          go('remediate-provide');
        }, 'primary', undefined, 'remediate-source-canvas'),
        choice('3', 'Upload a short document', 'Convert a PDF, Word file, slide deck, or text file into Canvas HTML, then check it.', () => {
          state.sourceMode = 'document';
          go('remediate-provide');
        }, 'plain', undefined, 'remediate-source-document'),
      ),
    ),
  );
}

function renderRemediateProvide(): El {
  if (state.sourceMode === 'canvas') return renderCanvasSourceProvide();
  if (state.sourceMode === 'document') return renderDocumentSourceProvide();
  return renderPasteSourceProvide();
}

function renderPasteSourceProvide(): El {
  const source = textarea('Source HTML', state.remediateSourceHtml, 'field field--code', 'remediate-source-html');
  return screen(
    stack(
      intro('Paste the page HTML', 'The original will be shown as text only. The repaired result must pass the gate before copying.'),
      source,
      splitRow(
        el('div', { class: 'hint' }, 'Need Canvas content? Import read-only pages from the source menu.'),
        actionButton(state.busy ? 'Checking' : 'Check and fix', () => {
          state.remediateSourceHtml = source.value;
          void runRemediate(source.value);
        }, 'btn btn--warn', undefined, 'remediate-check-fix'),
      ),
    ),
  );
}

function renderDocumentSourceProvide(): El {
  const input = fileInput();
  const convert = actionButton(state.busy ? 'Converting' : 'Convert and fix', () => void convertUploadedDocument(), 'btn btn--warn');
  convert.disabled = state.busy || !state.documentDataUrl;
  return screen(
    stack(
      intro('Upload a short document', 'Convert a local PDF, Word file, slide deck, spreadsheet, or text file into Canvas-ready HTML, then run the same remediation gate.'),
      el(
        'section',
        { class: 'panel upload-panel' },
        input,
      ),
      documentStatusPanel(),
      splitRow(
        el('div', { class: 'hint' }, 'File bytes are used once for local conversion and are not stored in the session.'),
        convert,
      ),
    ),
  );
}

function renderCanvasSourceProvide(): El {
  const baseUrl = textInput('Canvas base URL', state.canvasBaseUrl, 'field field--single', 'text', 'canvas-base-url');
  const courseId = textInput('Course ID', state.canvasCourseId, 'field field--single', 'text', 'canvas-course-id');
  const token = textInput('Access token', state.canvasToken, 'field field--single', 'password', 'canvas-token');
  const pages = state.canvasPages;
  if (!state.selectedCanvasPageId) state.selectedCanvasPageId = pages[0]?.id;
  return screen(
    stack(
      intro('Canvas API token and course import', 'Save a Canvas access token in Keychain, then import a page read-only for repair. Canvas Agent reads pages without writing changes back.'),
      el('div', { class: 'field-stack' }, baseUrl, courseId, token),
      splitRow(
        el('div', { class: 'hint' }, 'Settings live here for now. Leave token blank if it is already saved for this Canvas URL.'),
        actionButton(state.busy ? 'Connecting' : 'Connect', () => {
          state.canvasBaseUrl = baseUrl.value.trim();
          state.canvasCourseId = courseId.value.trim();
          state.canvasToken = token.value.trim();
          void loadCanvasPages();
        }, 'btn', undefined, 'canvas-connect'),
      ),
      pages.length > 0
        ? el('div', { class: 'choice-list' }, ...pages.map((page) => canvasPageRow(page)))
        : emptyPanel(state.canvasPagesLoaded ? 'No pages were found for this course.' : 'Connect to choose a page.'),
      splitRow(
        el('div', { class: 'hint' }, 'Fetched content will be repaired in the next step.'),
        actionButton(state.busy ? 'Importing' : 'Import and fix', () => void importAndRemediate(), 'btn btn--warn', undefined, 'canvas-import-fix'),
      ),
      publishSettingRow(),
    ),
  );
}

/**
 * The opt-in "Allow publishing to Canvas" setting (PRD §17). Lives on the
 * Canvas connect screen ("Settings live here for now"). Publishing shells out
 * to the EXTERNAL canvas-pp-cli, so the checkbox is disabled — and the publish
 * path stays invisible — until that binary is detected.
 */
function publishSettingRow(): El {
  if (!state.publishStatusLoaded) void loadPublishStatus();
  const status = state.publishStatus;
  const cliAvailable = status?.cliAvailable === true;
  const checkbox = el('input', {
    type: 'checkbox',
    id: 'canvas-publish-toggle',
    'data-testid': 'canvas-publish-toggle',
  }) as El & { checked: boolean };
  checkbox.checked = status?.publishEnabled === true;
  checkbox.disabled = !cliAvailable;
  checkbox.addEventListener('change', () => void setPublishEnabled(checkbox.checked));
  const label = el(
    'label',
    { class: 'hint', for: 'canvas-publish-toggle' },
    'Allow publishing repaired pages back to Canvas (via the separately installed canvas-pp-cli; asks per page).',
  );
  const detail = !state.publishStatusLoaded
    ? 'Checking for canvas-pp-cli…'
    : cliAvailable
      ? 'canvas-pp-cli detected. Publishing still requires a per-page confirm, and only gate-passing pages can publish.'
      : 'canvas-pp-cli was not detected on this Mac — publishing stays off. The app itself never writes to Canvas.';
  return el(
    'section',
    { class: 'panel' },
    splitRow(el('div', {}, checkbox, ' ', label), el('div', { class: 'hint' }, detail)),
  );
}

function canvasPageRow(page: CanvasPage): El {
  const selected = state.selectedCanvasPageId === page.id;
  const row = actionButton(
    '',
    () => {
      state.selectedCanvasPageId = page.id;
      render();
    },
    selected ? 'choice choice--primary' : 'choice',
  );
  row.setAttribute('data-testid', `canvas-page-${page.id}`);
  row.replaceChildren(
    el('span', { class: selected ? 'radio radio--on' : 'radio' }),
    el('span', { class: 'choice__copy' }, el('span', { class: 'choice__title' }, page.title), el('span', { class: 'choice__body' }, page.updatedAt ? `Updated ${shortDate(page.updatedAt)}` : 'Read-only Canvas page')),
  );
  return row;
}

// ── Institutional accessibility-review screen ────────────────────────────────
// The redesigned remediation panel (ported from the Paper design
// "02 · Accessibility remediation" via remediation.ts), bound to the live
// remediation run in state.remediateView. With no run to show it renders an
// empty state that routes to the remediate-source input flow.
let reviewSelectedId = '';

// Map a live remediation run (state.remediateView) into the panel's view model.
// Real findings carry id/severity/message/category — but no per-element contrast
// tiles or CSS diff — so the panel renders the page-level before/after HTML
// instead. Returns undefined when there is no usable run (→ empty state).
function gateSeverityToPanel(severity: GateSeverity): 'fail' | 'warn' {
  return severity === 'blocker' || severity === 'error' ? 'fail' : 'warn';
}

function auditCategoryLabel(category: AuditIssue['category']): string {
  switch (category) {
    case 'contrast':
      return 'Contrast';
    case 'aria':
      return 'ARIA';
    case 'structure':
      return 'Structure';
    case 'error':
      return 'Error';
    case 'alert':
      return 'Alert';
    case 'feature':
      return 'Feature';
    default:
      return 'Issue';
  }
}

function reviewPageContext(): { title: string; path: string } {
  if (state.sourceMode === 'canvas') {
    const page = state.canvasPages.find((p) => p.id === state.selectedCanvasPageId);
    return { title: page?.title ?? 'Imported Canvas page', path: state.canvasBaseUrl || 'canvas' };
  }
  if (state.sourceMode === 'document') {
    return { title: state.documentFileName ?? 'Converted document', path: 'document' };
  }
  return { title: 'Pasted HTML', path: 'pasted-source' };
}

function realRemediationView(): RemediationView | undefined {
  const view = state.remediateView;
  if (!view) return undefined;
  const frag = view.fragments.find((f) => f.remediateResult) ?? view.fragments[0];
  if (!frag) return undefined;
  const conf = frag.gate.conformance;
  const toIssue = (i: AuditIssue): RemediationIssue => ({
    id: i.id,
    title: i.message,
    element: auditCategoryLabel(i.category),
    severity: gateSeverityToPanel(i.severity),
  });
  const issues: RemediationIssue[] = [
    ...conf.blockers.map(toIssue),
    ...conf.warnings.map(toIssue),
    ...conf.needsHumanReview.map(toIssue),
  ];
  const remediate = frag.remediateResult;
  if (issues.length === 0 && !remediate) return undefined;
  const fixedCount = remediate ? remediate.issueDiffs.filter((d) => d.fixed).length : 0;
  const fixedNote = `${fixedCount} ${fixedCount === 1 ? 'issue was' : 'issues were'} auto-fixed by the gate.`;
  const htmlBefore = remediate?.before ?? '';
  const htmlAfter = remediate?.after ?? frag.html;
  const page = reviewPageContext();
  const summary = {
    fail: conf.blockers.length,
    warn: conf.warnings.length + conf.needsHumanReview.length,
    pass: fixedCount,
  };

  if (issues.length === 0) {
    return {
      page,
      summary,
      issues: [],
      selectedId: '',
      detail: {
        tag: 'Audit clear',
        severity: 'warn',
        wcag: 'On-device audit',
        position: 'No blocking issues',
        title: 'No blocking issues found',
        description: `The repaired page passed the on-device accessibility audit. ${fixedNote}`,
        htmlBefore,
        htmlAfter,
      },
    };
  }

  const selected = issues.find((i) => i.id === reviewSelectedId) ?? issues[0]!;
  const idx = issues.findIndex((i) => i.id === selected.id);
  return {
    page,
    summary,
    issues,
    selectedId: selected.id,
    detail: {
      tag: selected.severity === 'fail' ? 'Fails checks' : 'Needs review',
      severity: selected.severity,
      wcag: `On-device audit · ${selected.element}`,
      position: `Issue ${idx + 1} of ${issues.length}`,
      title: selected.title,
      description: `Surfaced by the on-device accessibility audit. The repaired, Canvas-safe page is shown below; ${fixedNote}`,
      htmlBefore,
      htmlAfter,
    },
  };
}

function renderRemediationEmpty(): El {
  return screen(
    stack(
      intro('No accessibility run yet', 'Paste page HTML, import a read-only Canvas page, or convert a document — the on-device audit and repaired result land here.'),
      splitRow(
        el('div', { class: 'hint' }, 'Nothing is sent off this machine; pages are read from Canvas without writing back.'),
        actionButton('Start a check', () => go('remediate-source'), 'btn btn--warn', undefined, 'remediate-review-start'),
      ),
    ),
  );
}

/**
 * The Canvas page-edit URL for the current remediation source, when it was a
 * live Canvas import (source mode is `canvas` AND base URL, course ID, and a
 * selected page are all present) — else `undefined` (pasted-HTML and
 * converted-document remediations get copy-only, no "Open in Canvas" link).
 */
function currentCanvasEditUrl(): string | undefined {
  if (state.sourceMode !== 'canvas') return undefined;
  const baseUrl = state.canvasBaseUrl.trim().replace(/\/+$/, '');
  const courseId = state.canvasCourseId.trim();
  const pageId = state.selectedCanvasPageId;
  if (!baseUrl || !courseId || !pageId) return undefined;
  return `${baseUrl}/courses/${courseId}/pages/${pageId}/edit`;
}

function renderRemediationReview(): El {
  const view = realRemediationView();
  if (!view) return renderRemediationEmpty();
  // Click-time callbacks re-read the live view so they act on fresh state; the
  // render-time view is the fallback only for type narrowing (state.remediateView
  // cannot be cleared while the panel is mounted).
  const current = (): RemediationView => realRemediationView() ?? view;
  // Only offer the corrected-HTML download when the run left no failures — the
  // same safety invariant the retired remediate-result screen enforced by
  // disabling its download/copy affordances on a withheld result.
  const passed = view.summary.fail === 0;
  const deps: RemediationDeps = {
    onSelect: (id) => {
      reviewSelectedId = id;
      render();
    },
    onApply: (id) => {
      const issue = current().issues.find((i) => i.id === id);
      state.notice = issue ? `Fix for "${issue.title}" is in the repaired page.` : 'Repaired page is ready.';
      render();
    },
    onSkip: () => {
      state.notice = 'Issue skipped.';
      render();
    },
    onCopyFix: () => {
      const { detail } = current();
      const text = detail.fix ? `${detail.fix.removed}\n${detail.fix.added}` : detail.htmlAfter ?? '';
      void copyText(text).then((ok) => {
        state.notice = ok ? 'Copied to clipboard.' : 'Clipboard unavailable.';
        render();
      });
    },
    // "More" (jump to saved work) carried over from the retired remediate-result screen.
    onOpenSaved: () => {
      state.previousScreen = 'remediate-review';
      go('saved-work');
    },
  };
  if (passed) {
    deps.onDownload = () => downloadHtml(current().detail.htmlAfter ?? '');
    deps.onCopyForCanvas = () => {
      const text = current().detail.htmlAfter ?? '';
      void copyText(text).then((ok) => {
        state.notice = ok ? 'Copied — paste into the Canvas editor' : 'Clipboard unavailable.';
        render();
      });
    };
  }
  const canvasEditUrl = currentCanvasEditUrl();
  if (canvasEditUrl) deps.canvasEditUrl = canvasEditUrl;

  // Opt-in publish (PRD §17): offered ONLY when every guardrail holds — the run
  // passed the gate, the page came from a live Canvas import (we know its
  // identity), the external CLI is installed, and the setting is on. The button
  // itself is two-step: arm, then confirm.
  if (!state.publishStatusLoaded) void loadPublishStatus();
  const publishTarget = currentPublishTarget();
  if (passed && publishTarget && state.publishStatus?.cliAvailable && state.publishStatus.publishEnabled) {
    deps.publishLabel = state.publishBusy
      ? 'Publishing…'
      : state.publishConfirming
        ? 'Confirm publish to Canvas'
        : 'Publish to Canvas';
    deps.onPublish = () => {
      if (state.publishBusy) return;
      if (!state.publishConfirming) {
        state.publishConfirming = true;
        state.notice = `Publishing will overwrite "${view.page.title}" on Canvas with the repaired page shown above. Click "Confirm publish to Canvas" to proceed.`;
        render();
        return;
      }
      void publishCurrentPage(publishTarget, current().detail.htmlAfter ?? '');
    };
  }

  const panel = createRemediationPanel(view, deps);
  return el('main', { class: 'remed-screen' }, panel.element);
}

function renderAlignment(): El {
  const content = textarea('Course content', state.alignmentContent, 'field');
  const objectives = textarea('Objectives', state.alignmentObjectives, 'field');
  const rubric = textarea('Rubric criteria', state.alignmentRubric, 'field');
  return screen(
    wideStack(
      intro('Check content against objectives.', 'Paste the content first. Objectives and rubric criteria can be added when available.'),
      el('div', { class: 'two-col' }, el('div', { class: 'two-col__main' }, content), el('div', { class: 'two-col__side field-stack' }, objectives, rubric)),
      splitRow(
        el('div', { class: 'hint' }, 'If objectives are blank, the app will say what it inferred.'),
        actionButton(state.busy ? 'Checking' : 'Check alignment', () => {
          state.alignmentContent = content.value.trim();
          state.alignmentObjectives = objectives.value.trim();
          state.alignmentRubric = rubric.value.trim();
          // The answer lands on inst-ask; give it a readable question label.
          state.guidanceQuestion = 'Does this content align with its objectives?';
          void runGuidance(composeAlignmentPrompt({
            content: state.alignmentContent,
            objectives: state.alignmentObjectives,
            rubric: state.alignmentRubric,
          }));
        }),
      ),
    ),
  );
}

function renderBrandManager(): El {
  if (!state.brandKitsLoaded) void loadBrandKits();
  const kit = currentBrandKit();
  void ensureCurrentTheme();
  return screen(
    el(
      'div',
      { class: 'two-col' },
      el(
        'section',
        { class: 'two-col__side' },
        el('h1', { class: 'section-title' }, 'Saved kits'),
        el('div', { class: 'list' }, ...brandRows()),
      ),
      el(
        'section',
        { class: 'two-col__main' },
        el('h1', { class: 'section-title' }, kit.name),
        el('div', { class: 'brand-strip' }, brandChip('Primary', kit.palette.primary), brandChip('Secondary', kit.palette.secondary)),
        contrastPanel(),
        btnRow(
          actionButton('Delete', () => void deleteCurrentBrandKit(), 'btn btn--secondary'),
          actionButton('Save kit', () => void saveCurrentBrandKit(), 'btn'),
        ),
      ),
    ),
  );
}

function renderSavedWork(): El {
  if (!state.sessionsLoaded) void loadSessions();
  const html = activeHtml();
  return screen(
    el(
      'div',
      { class: 'two-col' },
      el(
        'section',
        { class: 'two-col__main' },
        el('h1', { class: 'section-title' }, 'Sessions'),
        el('div', { class: 'list' }, ...sessionRows()),
      ),
      el(
        'section',
        { class: 'two-col__side' },
        el('h1', { class: 'section-title' }, 'More actions'),
        el(
          'div',
          { class: 'list' },
          actionButton('Show HTML code', () => {
            state.showCode = !state.showCode;
            render();
          }, 'row'),
          actionButton('Download HTML', () => downloadHtml(html), 'row'),
          actionButton('Canvas import settings', () => {
            state.sourceMode = 'canvas';
            go('remediate-provide');
          }, 'row'),
          actionButton('Brand kits', () => {
            state.previousScreen = 'saved-work';
            go('brand-manager');
          }, 'row'),
        ),
        state.showCode && html
          ? el('section', { class: 'panel' }, el('pre', { class: 'code-panel' }, html))
          : emptyNode(),
      ),
    ),
  );
}

function choice(
  num: string,
  title: string,
  body: string,
  onClick: () => void,
  tone: 'primary' | 'warn' | 'plain' = 'plain',
  cta?: string,
  testId?: string,
): El {
  const cls = tone === 'primary' ? 'choice choice--primary' : tone === 'warn' ? 'choice choice--warn' : 'choice';
  const children = [
    el('span', { class: 'choice__num' }, num),
    el('span', { class: 'choice__copy' }, el('span', { class: 'choice__title' }, title), el('span', { class: 'choice__body' }, body)),
  ];
  if (cta) children.push(el('span', { class: 'btn btn--small' }, cta));
  const node = actionButton('', onClick, cls);
  if (testId) node.setAttribute('data-testid', testId);
  node.replaceChildren(...children);
  return node;
}

function splitRow(left: El, right: El): El {
  return el('div', { class: 'split-row' }, left, right);
}

function btnRow(...buttons: El[]): El {
  return el('div', { class: 'btn-row' }, ...buttons);
}

function actionButton(label: string, onClick: () => void, className = 'btn', ariaLabel?: string, testId?: string): El {
  const btn = el('button', { type: 'button', class: className }, label);
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  if (testId) btn.setAttribute('data-testid', testId);
  btn.disabled = state.busy && className.includes('btn');
  btn.addEventListener('click', () => onClick());
  return btn;
}

function textarea(label: string, value: string, className: string, testId?: string): El {
  const field = el('textarea', { class: className, placeholder: label, 'aria-label': label });
  if (testId) field.setAttribute('data-testid', testId);
  field.value = value;
  return field;
}

function textInput(label: string, value: string, className: string, type = 'text', testId?: string): El {
  const field = el('input', { class: className, type, placeholder: label, 'aria-label': label });
  if (testId) field.setAttribute('data-testid', testId);
  field.value = value;
  return field;
}

function fileInput(): El {
  const input = el('input', {
    class: 'file-input',
    type: 'file',
    accept: '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.html,.htm,.md,.txt,.rtf,image/*',
    'aria-label': 'Choose document to convert',
  });
  input.addEventListener('change', (event: unknown) => {
    void selectDocument(event);
  });
  return input;
}


function swatches(primary: string, secondary: string): El {
  const a = el('span', { class: 'swatch' });
  const b = el('span', { class: 'swatch' });
  a.setAttribute('style', `background:${primary};`);
  b.setAttribute('style', `background:${secondary};`);
  return el('div', { class: 'swatches' }, a, b);
}

function brandChip(label: string, color: string): El {
  const chipNode = el('div', { class: 'brand-chip' }, `${label} ${color.toUpperCase()}`);
  chipNode.setAttribute('style', `background:${color};`);
  return chipNode;
}

function contrastPanel(): El {
  const colors = state.theme?.colors ?? [];
  if (colors.length === 0) {
    return el('section', { class: 'panel panel--green', 'data-testid': 'contrast-panel' }, el('h2', { class: 'panel__title' }, 'All generated color pairs will be checked'));
  }
  return el(
    'section',
    { class: 'panel panel--green steps', 'data-testid': 'contrast-panel' },
    el('h2', { class: 'panel__title' }, 'Resolved accessible roles'),
    ...colors.slice(0, 3).map((c) => splitRow(el('span', {}, roleName(c.role)), el('span', { class: 'status' }, `${c.contrast.ratio.toFixed(1)} ${c.contrast.level}`))),
  );
}

function copyButton(label: string, fragment: FragmentVm | undefined): El {
  const btn = actionButton(label, () => void copyFragment(fragment), 'btn', undefined, label.includes('repaired') ? 'copy-repaired-html' : 'copy-ready-html');
  btn.disabled = btn.disabled || !fragment?.passed;
  return btn;
}

function downloadButton(label: string, fragment: FragmentVm | undefined, testId: string): El {
  const btn = actionButton(label, () => downloadHtml(fragment?.html ?? ''), 'btn btn--secondary', undefined, testId);
  btn.disabled = btn.disabled || !fragment?.passed;
  return btn;
}

function issuePanel(title: string, body: string, onFix: () => void, testId = 'issue-panel'): El {
  return el(
    'section',
    { class: 'panel panel--warn issue', 'data-testid': testId },
    el('div', { class: 'issue__icon' }, '!'),
    el('div', { class: 'choice__copy' }, el('h2', { class: 'panel__title' }, title), el('p', { class: 'panel__body' }, body)),
    actionButton('Review', onFix, 'btn btn--warn btn--small'),
  );
}

function fragmentIssuesPanels(fragment: FragmentVm): El[] {
  const panels: El[] = [];
  if (fragment.blockers.length > 0) {
    panels.push(issuePanel('Blocking issues', fragment.blockers.join(' '), () => undefined, 'blocker-list'));
  }
  if (fragment.warnings.length > 0) {
    panels.push(el('section', { class: 'panel', 'data-testid': 'warning-list' }, el('h2', { class: 'panel__title' }, 'Warnings'), ...fragment.warnings.map((w) => el('p', { class: 'panel__body' }, w))));
  }
  if (fragment.needsReview.length > 0) {
    panels.push(el('section', { class: 'panel', 'data-testid': 'review-list' }, el('h2', { class: 'panel__title' }, 'Needs human review'), ...fragment.needsReview.map((w) => el('p', { class: 'panel__body' }, w))));
  }
  return panels;
}

function documentStatusPanel(): El {
  if (!state.documentFileName) {
    return emptyPanel('No document selected yet.');
  }
  const rows = [
    splitRow(el('span', {}, 'File'), el('strong', {}, state.documentFileName)),
    splitRow(el('span', {}, 'Size'), el('span', {}, formatBytes(state.documentSizeBytes))),
  ];
  if (state.documentConversion) {
    rows.push(
      splitRow(el('span', {}, 'Conversion'), el('span', {}, state.documentConversion.status)),
      splitRow(el('span', {}, 'Output'), el('span', {}, state.documentConversion.html ? 'HTML ready for checking' : 'No HTML returned')),
    );
  }
  return el('section', { class: 'panel steps' }, ...rows);
}

function emptyPanel(text: string): El {
  return el('section', { class: 'panel' }, el('p', { class: 'panel__body' }, text));
}

function emptyNode(): El {
  return el('span', { hidden: 'true' });
}

function fragmentCard(fragment: FragmentVm, title: string, compact = false): El {
  const frame = previewFrame(fragment.html, `${title} preview`);
  frame.className = compact ? 'preview__frame preview__frame--compact' : 'preview__frame';
  frame.setAttribute('data-testid', 'result-preview-frame');
  const showingCode = state.artifactView === 'code';
  return el(
    'article',
    { class: 'result-card', 'data-testid': 'result-card' },
    el(
      'div',
      { class: 'result-card__head' },
      el('div', { class: 'result-card__title' }, title),
      el(
        'div',
        { class: 'result-card__actions' },
        segmentedButton('Preview', 'preview'),
        segmentedButton('HTML', 'code'),
        el('div', { class: 'status', 'data-testid': 'result-badge' }, el('span', { class: 'status__dot' }), fragment.badge.label),
      ),
    ),
    showingCode
      ? el('pre', { class: 'code-panel result-card__code', 'data-testid': 'result-code' }, fragment.html)
      : frame,
  );
}

function segmentedButton(label: string, value: ArtifactView): El {
  return actionButton(label, () => {
    state.artifactView = value;
    render();
  }, state.artifactView === value ? 'segmented__btn segmented__btn--active' : 'segmented__btn');
}

function brandRows(): El[] {
  const kits = allBrandKits();
  return kits.map((kit) => {
    const active = kit.id === currentBrandKit().id;
    const row = actionButton('', () => {
      state.selectedBrandId = kit.id;
      state.theme = undefined;
      state.themeKey = undefined;
      render();
    }, active ? 'row row--active' : 'row');
    row.setAttribute('data-testid', `brand-row-${kit.id}`);
    row.replaceChildren(
      swatches(kit.palette.primary, kit.palette.secondary),
      el('div', { class: 'row__copy' }, el('div', { class: 'row__title' }, kit.name), el('div', { class: 'row__meta' }, active ? 'Default' : 'Saved kit')),
    );
    return row;
  });
}

function sessionRows(): El[] {
  const sessions = state.sessions.length > 0 ? state.sessions : [
    { id: 'local-build', title: 'Welcome module overview', mode: 'build' as ProductMode, createdAt: '', updatedAt: '' },
    { id: 'local-remediate', title: 'Syllabus remediation', mode: 'remediate' as ProductMode, createdAt: '', updatedAt: '' },
  ];
  return sessions.map((session) => {
    const isBuild = session.mode === 'build';
    const row = actionButton('', () => void openSession(session), session.id === state.activeSessionId ? 'row row--active' : 'row');
    row.setAttribute('data-testid', `session-row-${session.mode}`);
    row.replaceChildren(
      el('span', { class: isBuild ? 'row__icon' : 'row__icon row__icon--warn' }, isBuild ? 'B' : session.mode === 'remediate' ? 'R' : 'G'),
      el(
        'span',
        { class: 'row__copy' },
        el('span', { class: 'row__title' }, session.title),
        el('span', { class: 'row__meta' }, sessionMeta(session)),
      ),
    );
    return row;
  });
}

function templateLabel(id: TemplateType): string {
  return TEMPLATE_OPTIONS.find((t) => t.id === id)?.title ?? id;
}

function roleName(role: string): string {
  return role
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sessionMeta(session: Session): string {
  if (session.mode === 'build') return 'Build - saved page';
  if (session.mode === 'remediate') return 'Remediate - saved repair';
  return 'Guidance - grounded answer';
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function allBrandKits(): BrandKit[] {
  const kits = state.brandKits.length > 0 ? state.brandKits : [DEFAULT_BRAND];
  return kits.some((kit) => kit.id === DEFAULT_BRAND.id) ? kits : [DEFAULT_BRAND, ...kits];
}

function currentBrandKit(): BrandKit {
  const kits = allBrandKits();
  return kits.find((kit) => kit.id === state.selectedBrandId) ?? kits[0] ?? DEFAULT_BRAND;
}

function firstPassedFragment(view: TurnView | undefined): FragmentVm | undefined {
  return view ? turnViewToVm(view).fragments.find((fragment) => fragment.passed) : undefined;
}

function firstBlockedFragment(view: TurnView | undefined): FragmentVm | undefined {
  return view ? turnViewToVm(view).fragments.find((fragment) => !fragment.passed) : undefined;
}

function firstFragment(view: TurnView | undefined): FragmentVm | undefined {
  return view ? turnViewToVm(view).fragments[0] : undefined;
}

function buildHeaderBadge(): string {
  if (firstPassedFragment(state.buildView)) return 'Ready';
  if (firstBlockedFragment(state.buildView)) return 'Checks withheld';
  return 'Review';
}

function buildHeaderKind(): 'blue' | 'green' | 'amber' | 'neutral' {
  if (firstPassedFragment(state.buildView)) return 'green';
  if (firstBlockedFragment(state.buildView)) return 'amber';
  return 'neutral';
}

function activeHtml(): string {
  return firstPassedFragment(state.buildView)?.html
    ?? firstPassedFragment(state.remediateView)?.html
    ?? firstFragment(state.buildView)?.html
    ?? firstFragment(state.remediateView)?.html
    ?? '';
}

function remediateSourceTitle(): string {
  if (state.sourceMode === 'canvas') return 'Canvas API token and import';
  if (state.sourceMode === 'document') return 'Upload document';
  return 'Paste source HTML';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function go(screenName: Screen): void {
  state.error = undefined;
  state.notice = undefined;
  // Navigating away abandons a half-armed publish confirm.
  state.publishConfirming = false;
  state.previousScreen = state.screen;
  state.screen = screenName;
  render();
}

async function refreshHealth(): Promise<void> {
  try {
    const health = await api().health();
    const ok = health.llm && health.ingest;
    state.health = ok ? 'ready' : 'degraded';
    if (health.model && !health.model.available) {
      state.health = 'degraded';
      // Don't surface a bare CLI command — the app downloads the model itself via
      // the bundled Ollama (see downloadModel()); the affordance is rendered next
      // to the status. Skip while a download is already in flight.
      if (!state.modelPull) state.modelMissingTag = health.model.tag;
      state.healthText = `Model not installed (${health.model.tag})`;
    } else {
      state.modelMissingTag = undefined;
      state.healthText = ok
        ? `Local runtime ready${health.model ? ` - ${health.model.tag}` : ''}`
        : `Local runtime: llm ${health.llm ? 'up' : 'down'}, ingest ${health.ingest ? 'up' : 'down'}`;
    }
    // Docling document models are independent of the LLM: missing them only
    // blocks PDF/scanned-image conversion (office/web docs still work), so this
    // surfaces a download affordance without marking the whole runtime degraded.
    // Skip while a download is already in flight.
    if (!state.ingestPull) {
      state.ingestModelMissing = health.ingestModel ? !health.ingestModel.available : false;
    }
  } catch {
    state.health = 'degraded';
    state.healthText = 'Local runtime unavailable';
  } finally {
    render();
  }
}

/**
 * First-run model provisioning: download the configured model into the bundled
 * Ollama, streaming progress into the status indicator. On success, re-probe
 * health (which clears the missing-model state); on failure, surface the error.
 */
async function downloadModel(): Promise<void> {
  if (state.modelPull) return; // a download is already running
  state.error = undefined;
  state.modelPull = { text: 'Starting download…', percent: undefined };
  render();
  try {
    await api().pullModel((p) => {
      const percent = typeof p.percent === 'number' ? p.percent : undefined;
      const text =
        p.status === 'success'
          ? 'Finishing…'
          : percent !== undefined
            ? `${p.status} ${percent}%`
            : p.status;
      state.modelPull = { text, percent };
      render();
    });
    state.modelPull = undefined;
    state.modelMissingTag = undefined;
    state.notice = 'Model downloaded.';
    await refreshHealth();
  } catch (err) {
    state.modelPull = undefined;
    state.error = `Model download failed: ${(err as Error).message}`;
    render();
  }
}

/**
 * First-run document-model provisioning: download the Docling conversion models
 * (layout, TableFormer, OCR, code/formula, picture-classifier + Granite-Docling)
 * into the per-user store, streaming progress into the status indicator. Mirrors
 * downloadModel(); names the current model in the progress text.
 */
async function downloadIngestModel(): Promise<void> {
  if (state.ingestPull) return; // a download is already running
  state.error = undefined;
  state.ingestPull = { text: 'Starting download…', percent: undefined };
  render();
  try {
    await api().pullIngestModel((p) => {
      const percent = typeof p.percent === 'number' ? p.percent : undefined;
      const label = p.model ? `${p.status} ${p.model}` : p.status;
      const text =
        p.status === 'success'
          ? 'Finishing…'
          : percent !== undefined
            ? `${label} ${percent}%`
            : label;
      state.ingestPull = { text, percent };
      render();
    });
    state.ingestPull = undefined;
    state.ingestModelMissing = false;
    state.notice = 'Document models downloaded.';
    await refreshHealth();
  } catch (err) {
    state.ingestPull = undefined;
    state.error = `Document-model download failed: ${(err as Error).message}`;
    render();
  }
}

async function loadBrandKits(): Promise<void> {
  try {
    state.brandKits = await api().listBrandKits();
    if (!state.selectedBrandId) state.selectedBrandId = state.brandKits[0]?.id ?? DEFAULT_BRAND.id;
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    state.brandKitsLoaded = true;
    render();
  }
}

async function loadSessions(): Promise<void> {
  try {
    state.sessions = await api().listSessions();
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    state.sessionsLoaded = true;
    render();
  }
}

function turnViewFromSession(sessionState: SessionState): TurnView {
  const assistant = [...sessionState.messages].reverse().find((m) => m.role === 'assistant');
  return {
    text: assistant?.content ?? '',
    fragments: assistant?.fragments ?? [],
    toolsUsed: [],
    iterations: 0,
    mode: sessionState.session.mode,
  };
}

async function openSession(session: Session): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.error = undefined;
  state.activeSessionId = session.id;
  render();
  try {
    const loaded = await api().loadSession(session.id);
    const view = loaded ? turnViewFromSession(loaded) : { text: '', fragments: [], toolsUsed: [], iterations: 0, mode: session.mode };
    if (session.mode === 'build') {
      state.buildView = view;
      go('build-result');
    } else if (session.mode === 'remediate') {
      state.remediateView = view;
      go('remediate-review');
    } else {
      state.guidanceView = view;
      go('inst-ask');
    }
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    state.busy = false;
    render();
  }
}

async function loadCanvasPages(): Promise<void> {
  const baseUrl = state.canvasBaseUrl.trim();
  const courseId = state.canvasCourseId.trim();
  if (!baseUrl || !courseId) {
    state.error = 'Add a Canvas base URL and course ID first.';
    render();
    return;
  }
  state.busy = true;
  state.error = undefined;
  render();
  try {
    if (state.canvasToken.trim()) {
      await api().saveCanvasAuth({ baseUrl, token: state.canvasToken.trim() });
      state.canvasToken = '';
    }
    state.canvasPages = await api().listCanvasPages(baseUrl, courseId);
    state.selectedCanvasPageId = state.selectedCanvasPageId ?? state.canvasPages[0]?.id;
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    state.busy = false;
    state.canvasPagesLoaded = true;
    render();
  }
}

function fileFromEvent(event: unknown): FileLike | undefined {
  const files = (event as { target?: { files?: FileListLike } }).target?.files;
  return files?.item(0) ?? files?.[0];
}

function readDataUrl(file: FileLike): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result ?? reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('Could not read the selected file.'));
    };
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

async function selectDocument(event: unknown): Promise<void> {
  const file = fileFromEvent(event);
  if (!file) return;
  if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
    state.error = 'Choose a document under 25 MB for this first pass.';
    state.documentDataUrl = undefined;
    state.documentConversion = undefined;
    render();
    return;
  }
  state.error = undefined;
  state.notice = undefined;
  state.documentFileName = file.name;
  state.documentMime = file.type || 'application/octet-stream';
  state.documentSizeBytes = file.size;
  state.documentDataUrl = undefined;
  state.documentConversion = undefined;
  render();
  try {
    state.documentDataUrl = await readDataUrl(file);
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    render();
  }
}

async function convertUploadedDocument(): Promise<void> {
  if (!state.documentFileName || !state.documentDataUrl) {
    state.error = 'Choose a document first.';
    render();
    return;
  }
  const document: UploadedDocument = {
    filename: state.documentFileName,
    mime: state.documentMime || 'application/octet-stream',
    sizeBytes: state.documentSizeBytes,
    dataUrl: state.documentDataUrl,
  };
  state.busy = true;
  state.error = undefined;
  render();
  try {
    const converted = await api().convertDocument(document);
    state.documentConversion = converted;
    state.documentDataUrl = undefined;
    if (!converted.html) {
      throw new Error(`The converter did not return usable HTML for ${converted.filename}.`);
    }
    state.remediateSourceHtml = converted.html;
    state.busy = false;
    await runRemediate(converted.html);
  } catch (err) {
    state.error = errorMessage(err);
    state.busy = false;
    render();
  }
}

/**
 * inst-ingest upload: reuse the classic file-pick (`selectDocument`) and the
 * `convertDocument` path, but stay on inst-ingest and surface the result via
 * `state.documentConversion` (instIngestData reads it). Unlike
 * `convertUploadedDocument`, this does NOT chain into remediation/navigation —
 * that path belongs to the untouched remediate-provide document flow.
 */
async function ingestDocument(event: unknown): Promise<void> {
  await selectDocument(event);
  if (!state.documentFileName || !state.documentDataUrl) return; // size/read error already surfaced
  const document: UploadedDocument = {
    filename: state.documentFileName,
    mime: state.documentMime || 'application/octet-stream',
    sizeBytes: state.documentSizeBytes,
    dataUrl: state.documentDataUrl,
  };
  state.busy = true;
  state.error = undefined;
  render();
  try {
    state.documentConversion = await api().convertDocument(document);
    state.documentDataUrl = undefined;
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    state.busy = false;
    render();
  }
}

async function ensureCurrentTheme(): Promise<void> {
  const kit = currentBrandKit();
  const key = `${kit.palette.primary}:${kit.palette.secondary}`;
  if (state.themeKey === key) return;
  state.themeKey = key;
  try {
    state.theme = await api().resolveBrandTheme(kit.palette.primary, kit.palette.secondary);
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    render();
  }
}

/**
 * Lazily probe whether the local LACCD catalog CLI is installed, so the
 * "Official course outcomes" panel stays invisible until we know the feature
 * is actually usable. Mirrors `ensureCurrentTheme()`'s once-per-value-change
 * shape, keyed on "have we checked at all" rather than a value key.
 */
let catalogProbe: Promise<void> | undefined;

async function ensureCatalogAvailable(): Promise<void> {
  if (state.catalogAvailable !== undefined) return;
  // Re-renders while the probe is in flight must not spawn duplicate CLI checks.
  catalogProbe ??= (async () => {
    try {
      state.catalogAvailable = await api().catalogAvailable();
    } catch {
      state.catalogAvailable = false;
    } finally {
      render();
    }
  })();
  return catalogProbe;
}

/** Search the local LACCD catalog mirror (and, when empty, the public eLumen API). */
async function searchCatalog(query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed || state.catalogBusy) return;
  state.catalogBusy = true;
  state.catalogError = undefined;
  render();
  try {
    state.catalogResults = (await api().catalogSearch(trimmed)).slice(0, 8);
  } catch (err) {
    state.catalogError = errorMessage(err);
  } finally {
    state.catalogBusy = false;
    render();
  }
}

/** Fetch full catalog detail (SLOs/objectives/description) for a chosen search result. */
async function selectCatalogCourse(id: number): Promise<void> {
  if (state.catalogBusy) return;
  state.catalogBusy = true;
  state.catalogError = undefined;
  render();
  try {
    state.catalogSelected = await api().catalogGet(id);
    state.catalogResults = [];
  } catch (err) {
    state.catalogError = errorMessage(err);
  } finally {
    state.catalogBusy = false;
    render();
  }
}

async function generateBuild(): Promise<void> {
  const prompt = [
    `Build a ${templateLabel(state.selectedTemplate)} Canvas page.`,
    `Title: ${state.buildTitle || 'Module 1 - Getting Started'}`,
    state.buildRhythm ? `Dates or rhythm: ${state.buildRhythm}` : 'Dates or rhythm: [TBD]',
    state.buildTasks ? `Learner tasks: ${state.buildTasks}` : 'Learner tasks: read chapter 1; post to the introductions discussion.',
    ...catalogPromptLines(state.catalogSelected),
    `Use the ${currentBrandKit().name} brand kit when accessible.`,
  ].join('\n');
  const view = await runTurn({ user: prompt, mode: 'build' });
  if (view) {
    state.buildView = view;
    go('build-result');
  }
}

async function runRemediate(sourceHtml: string): Promise<void> {
  const view = await runTurn({
    user: 'Check and remediate this Canvas HTML.',
    mode: 'remediate',
    remediateInput: { sourceHtml },
  });
  if (view) {
    state.remediateView = view;
    go('remediate-review');
  }
}

async function loadPublishStatus(): Promise<void> {
  try {
    state.publishStatus = await api().canvasPublishStatus();
  } catch {
    // The probe itself never rejects in the real runtime; a transport failure
    // reads as "no publish path" rather than an error banner.
    state.publishStatus = { cliAvailable: false, publishEnabled: false };
  } finally {
    state.publishStatusLoaded = true;
    render();
  }
}

async function setPublishEnabled(enabled: boolean): Promise<void> {
  try {
    await api().setCanvasPublishEnabled(enabled);
    state.publishStatus = { cliAvailable: state.publishStatus?.cliAvailable ?? false, publishEnabled: enabled };
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    render();
  }
}

/** The Canvas identity of the current remediation, when it was a live import. */
function currentPublishTarget(): { baseUrl: string; courseId: string; pageId: string } | undefined {
  if (state.sourceMode !== 'canvas') return undefined;
  const baseUrl = state.canvasBaseUrl.trim();
  const courseId = state.canvasCourseId.trim();
  const pageId = state.selectedCanvasPageId;
  if (!baseUrl || !courseId || !pageId) return undefined;
  return { baseUrl, courseId, pageId };
}

async function publishCurrentPage(
  target: { baseUrl: string; courseId: string; pageId: string },
  html: string,
): Promise<void> {
  state.publishBusy = true;
  state.error = undefined;
  render();
  try {
    const receipt = await api().publishCanvasPage(target.baseUrl, target.courseId, target.pageId, html);
    state.publishConfirming = false;
    state.notice = `Published to Canvas — ${receipt.canvasUrl}`;
  } catch (err) {
    state.publishConfirming = false;
    state.error = errorMessage(err);
  } finally {
    state.publishBusy = false;
    render();
  }
}

async function importAndRemediate(): Promise<void> {
  const baseUrl = state.canvasBaseUrl.trim();
  const courseId = state.canvasCourseId.trim();
  const pageId = state.selectedCanvasPageId ?? state.canvasPages[0]?.id;
  if (!baseUrl || !courseId || !pageId) {
    state.error = 'Connect to Canvas and choose a page first.';
    render();
    return;
  }
  state.busy = true;
  state.error = undefined;
  render();
  try {
    const html = await api().fetchCanvasPage(baseUrl, courseId, pageId);
    state.remediateSourceHtml = html;
    state.busy = false;
    await runRemediate(html);
  } catch (err) {
    state.busy = false;
    state.error = errorMessage(err);
    render();
  }
}

async function runGuidance(prompt: string): Promise<void> {
  if (!prompt.trim()) {
    state.error = 'Add a question or content first.';
    render();
    return;
  }
  const req: TurnRequest = { user: prompt, mode: 'guidance' };
  if (state.screenshots.length > 0) req.attachments = [...state.screenshots];
  const view = await runTurn(req);
  if (view) {
    state.guidanceView = view;
    state.screenshots = [];
    state.screenshotSources = [];
    go('inst-ask');
  }
}

async function loadScreenshotSources(): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.error = undefined;
  render();
  try {
    state.screenshotPermission = await api().screenshotPermissionStatus();
    state.screenshotSources = await api().listScreenshotSources();
    if (state.screenshotSources.length === 0) state.notice = 'No screen or window sources were found.';
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    state.busy = false;
    render();
  }
}

async function captureScreenshot(sourceId: string): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.error = undefined;
  render();
  try {
    const shot = await api().captureScreenshot(sourceId);
    state.screenshots = [...state.screenshots.filter((s) => s.id !== shot.id), shot];
    state.screenshotSources = [];
  } catch (err) {
    state.error = errorMessage(err);
  } finally {
    state.busy = false;
    render();
  }
}

function removeScreenshot(id: string): void {
  state.screenshots = state.screenshots.filter((shot) => shot.id !== id);
  render();
}

async function runTurn(req: TurnRequest): Promise<TurnView | undefined> {
  if (state.busy) return undefined;
  state.busy = true;
  state.error = undefined;
  render();
  if (state.activeSessionId) req.sessionId = state.activeSessionId;
  try {
    return await api().runTurn(req);
  } catch (err) {
    state.error = errorMessage(err);
    return undefined;
  } finally {
    state.busy = false;
    render();
  }
}

async function copyFragment(fragment: FragmentVm | undefined): Promise<void> {
  if (!fragment || !fragment.passed) {
    state.error = 'No passed HTML is ready to copy yet.';
    render();
    return;
  }
  const ok = await copyText(fragment.html);
  state.notice = ok ? 'Copied HTML.' : 'Clipboard unavailable.';
  render();
  later(() => {
    state.notice = undefined;
    render();
  }, 1400);
}

function downloadHtml(html: string): void {
  if (!html) {
    state.error = 'No HTML is ready to download yet.';
    render();
    return;
  }
  const a = el('a', {
    href: 'data:text/html;charset=utf-8,' + encodeURIComponent(previewSrcdoc(html)),
    download: 'canvas-agent-output.html',
  });
  a.hidden = true;
  root?.append(a);
  a.click();
  a.remove();
}

async function saveCurrentBrandKit(): Promise<void> {
  const kit = currentBrandKit();
  const payload: Omit<BrandKit, 'id' | 'createdAt'> = { name: kit.name, palette: kit.palette };
  if (kit.fonts) payload.fonts = kit.fonts;
  try {
    await api().saveBrandKit(payload);
    state.brandKitsLoaded = false;
    await loadBrandKits();
  } catch (err) {
    state.error = errorMessage(err);
    render();
  }
}

async function deleteCurrentBrandKit(): Promise<void> {
  const kit = currentBrandKit();
  if (kit.id === DEFAULT_BRAND.id) return;
  try {
    await api().deleteBrandKit(kit.id);
    state.selectedBrandId = DEFAULT_BRAND.id;
    state.brandKitsLoaded = false;
    await loadBrandKits();
  } catch (err) {
    state.error = errorMessage(err);
    render();
  }
}

async function newBrandKit(): Promise<void> {
  try {
    const saved = await api().saveBrandKit({
      name: 'New kit',
      palette: { primary: '#0374B5', secondary: '#2D3B45' },
    });
    state.selectedBrandId = saved.id;
    state.brandKitsLoaded = false;
    await loadBrandKits();
  } catch (err) {
    state.error = errorMessage(err);
    render();
  }
}

async function newSession(): Promise<void> {
  try {
    const session = await api().createSession({ title: 'New session', mode: 'guidance' });
    state.activeSessionId = session.id;
    state.sessionsLoaded = false;
    await loadSessions();
  } catch (err) {
    state.error = errorMessage(err);
    render();
  }
}

onReady(mount);
