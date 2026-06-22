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
import { api, byId, copyText, el, errorMessage, later, onReady, type El } from './ui.js';
import { turnViewToVm, type FragmentVm } from '../view.js';
import type {
  BrandKit,
  CanvasPage,
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
  | 'home'
  | 'build-template'
  | 'build-details'
  | 'build-brand'
  | 'build-result'
  | 'remediate-source'
  | 'remediate-provide'
  | 'remediate-result'
  | 'guidance-ask'
  | 'guidance-answer'
  | 'alignment'
  | 'brand-manager'
  | 'saved-work';

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
  guidanceQuestion: string;
  guidanceView: TurnView | undefined;
  screenshotPermission: ScreenshotPermissionStatus | undefined;
  screenshotSources: ScreenshotSource[];
  screenshots: ScreenshotAttachment[];
  alignmentContent: string;
  alignmentObjectives: string;
  alignmentRubric: string;
  showCode: boolean;
  artifactView: ArtifactView;
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

const state: State = {
  screen: 'home',
  previousScreen: 'home',
  busy: false,
  error: undefined,
  notice: undefined,
  health: 'checking',
  healthText: 'Local runtime checking',
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
  guidanceQuestion: 'How do I make a table accessible in Canvas?',
  guidanceView: undefined,
  screenshotPermission: undefined,
  screenshotSources: [],
  screenshots: [],
  alignmentContent: '',
  alignmentObjectives: '',
  alignmentRubric: '',
  showCode: false,
  artifactView: 'preview',
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
  const body = renderScreen();
  const children = [
    body.header,
    ...(state.error ? [statusBanner(state.error, 'error')] : []),
    ...(state.notice ? [statusBanner(state.notice, 'notice')] : []),
    body.main,
  ];
  root.replaceChildren(...children);
}

interface ScreenParts {
  header: El;
  main: El;
}

function renderScreen(): ScreenParts {
  switch (state.screen) {
    case 'home':
      return { header: homeHeader(), main: renderHome() };
    case 'build-template':
      return {
        header: flowHeader('Build a Canvas page', 'Step 1 of 4', 25, 'home'),
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
        header: simpleHeader('Fix an existing page', 'Remediate', 'amber', 'home'),
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
    case 'remediate-result':
      return {
        header: simpleHeader('Remediation result', remediateHeaderBadge(), remediateHeaderKind(), 'remediate-provide'),
        main: renderRemediateResult(),
      };
    case 'guidance-ask':
      return {
        header: simpleHeader('Course design guidance', 'Saved guidance', 'neutral', 'home', () => go('saved-work')),
        main: renderGuidanceAsk(),
      };
    case 'guidance-answer':
      return {
        header: simpleHeader('Guidance answer', 'Grounded', 'green', 'guidance-ask'),
        main: renderGuidanceAnswer(),
      };
    case 'alignment':
      return {
        header: simpleHeader('Alignment coach', 'Guidance mode', 'blue', 'home'),
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
  }
}

function homeHeader(): El {
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
    el('div', { class: 'progress', 'aria-label': subtitle }, progressBar(pct)),
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

function healthStatus(): El {
  const cls = state.health === 'ready' ? 'status' : 'status status--warn';
  return el('div', { class: cls, 'data-testid': 'health' }, el('span', { class: 'status__dot' }), state.healthText);
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

function renderHome(): El {
  return screen(
    stack(
      intro('What are you doing today?', 'Pick one job. The app will ask only the next required question.', true),
      el(
        'div',
        { class: 'choice-list' },
        choice('1', 'Build a Canvas page', 'Create a page from a guided template and get checked HTML.', () => go('build-template'), 'primary', 'Start', 'home-build'),
        choice('2', 'Fix an existing page', 'Paste HTML or import a read-only Canvas page.', () => go('remediate-source'), 'warn', undefined, 'home-remediate'),
        choice('3', 'Ask how Canvas works', 'Ask a Canvas question, with or without a screenshot.', () => go('guidance-ask'), 'plain', undefined, 'home-guidance'),
      ),
      quickLinks(),
    ),
  );
}

function quickLinks(): El {
  return el(
    'section',
    { class: 'quick-links' },
    el('div', { class: 'quick-links__label' }, 'Shortcuts'),
    actionButton('Upload document', () => {
      state.sourceMode = 'document';
      go('remediate-provide');
    }, 'chip', undefined, 'quick-upload-document'),
    actionButton('Canvas API token', () => {
      state.sourceMode = 'canvas';
      go('remediate-provide');
    }, 'chip', undefined, 'quick-canvas-token'),
    actionButton('Saved work', () => go('saved-work'), 'chip', undefined, 'quick-saved-work'),
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
  const title = textarea('Page title', state.buildTitle, 'field field--single', 'build-title');
  const rhythm = textarea('Due dates or weekly rhythm', state.buildRhythm, 'field field--single', 'build-rhythm');
  const tasks = textarea('Learner tasks for this week', state.buildTasks, 'field', 'build-tasks');
  return screen(
    stack(
      intro('What should this page say?', 'Add the details you already know. Empty fields can become clear placeholders.'),
      el('div', { class: 'field-stack' }, title, rhythm, tasks),
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
    ),
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

function renderRemediateResult(): El {
  const passed = firstPassedFragment(state.remediateView);
  const fragment = passed ?? firstFragment(state.remediateView);
  const fixedDiffs = remediateFixedDiffs(state.remediateView);
  return screen(
    wideStack(
      intro(
        passed ? 'Your page is ready to copy.' : fragment ? 'Your page still needs review.' : 'No repaired page is ready yet.',
        passed
          ? 'The repaired HTML passed the output gate.'
          : fragment
            ? 'Canvas Agent fixed what it could and is keeping blockers separate from copied HTML.'
            : 'Run a fix first to see the preview, issues, and HTML code.',
      ),
      fixedDiffs.length > 0
        ? el('section', { class: 'panel panel--green steps', 'data-testid': 'remediate-diff-list' }, ...fixedDiffs.map((d) => checkRow(d)))
        : el('section', { class: 'panel', 'data-testid': 'remediate-diff-list' }, el('p', { class: 'panel__body' }, fragment ? 'No issues were marked fixed by the gate diff.' : 'No remediation run yet.')),
      ...(fragment?.remediateResult ? [remediateEvidencePanel(fragment)] : []),
      fragment ? fragmentCard(fragment, 'Repaired Canvas page') : emptyPanel('Run a fix first to see the preview and HTML code.'),
      ...(fragment ? fragmentIssuesPanels(fragment) : []),
      btnRow(
        actionButton('More', () => {
          state.previousScreen = 'remediate-result';
          go('saved-work');
        }, 'btn btn--secondary'),
        downloadButton('Download HTML', passed, 'download-repaired-html'),
        copyButton('Copy repaired HTML', passed),
      ),
    ),
  );
}

function renderGuidanceAsk(): El {
  const prompt = textarea('Guidance question', state.guidanceQuestion, 'field', 'guidance-question');
  return screen(
    stack(
      intro('What do you want to understand?', 'Ask about Canvas, accessibility, course design, or the rubric. Add a screenshot when the screen itself matters.'),
      prompt,
      el(
        'div',
        { class: 'chips' },
        chip('Canvas tables', () => {
          state.guidanceQuestion = 'How do I make a table accessible in Canvas?';
          render();
        }),
        chip('Rubric gaps', () => {
          state.guidanceQuestion = 'How can I tell if this module has rubric gaps?';
          render();
        }),
        chip('Accessible images', () => {
          state.guidanceQuestion = 'How should I write alt text for Canvas course images?';
          render();
        }),
        chip('Check alignment', () => go('alignment')),
      ),
      screenshotCapturePanel(),
      btnRow(actionButton(state.busy ? 'Asking' : 'Ask', () => {
        state.guidanceQuestion = prompt.value.trim();
        void runGuidance(state.guidanceQuestion);
      }, 'btn', undefined, 'guidance-ask')),
    ),
  );
}

function screenshotCapturePanel(): El {
  const permissionCopy = state.screenshotPermission && state.screenshotPermission !== 'granted'
    ? `Screen recording permission: ${state.screenshotPermission}. macOS may ask before the first capture.`
    : 'Screenshots are summarized on-device for this question; raw pixels are not stored in the session.';
  const children: El[] = [
    el(
      'div',
      { class: 'screenshot__toolbar' },
      el('p', { class: 'hint' }, permissionCopy),
      actionButton(state.busy ? 'Capturing' : 'Take screenshot', () => void loadScreenshotSources(), 'btn btn--secondary btn--small'),
    ),
  ];
  if (state.screenshots.length > 0) {
    children.push(
      el(
        'div',
        { class: 'screenshot-rail', 'aria-label': 'Attached screenshots' },
        ...state.screenshots.map((shot) => screenshotThumb(shot)),
      ),
    );
  }
  if (state.screenshotSources.length > 0) {
    children.push(
      el(
        'div',
        { class: 'source-grid', 'aria-label': 'Screenshot sources' },
        ...state.screenshotSources.map((source) => screenshotSourceButton(source)),
      ),
    );
  }
  return el('section', { class: 'panel screenshot' }, ...children);
}

function screenshotThumb(shot: ScreenshotAttachment): El {
  const img = el('img', { src: shot.dataUrl, alt: `${shot.label} screenshot preview`, class: 'screenshot-thumb__img' });
  return el(
    'article',
    { class: 'screenshot-thumb' },
    img,
    el(
      'div',
      { class: 'screenshot-thumb__meta' },
      el('span', { class: 'screenshot-thumb__label' }, shot.label),
      actionButton('Remove', () => removeScreenshot(shot.id), 'link-btn'),
    ),
  );
}

function screenshotSourceButton(source: ScreenshotSource): El {
  const btn = actionButton('', () => void captureScreenshot(source.id), 'source-card');
  btn.replaceChildren(
    el('img', { src: source.thumbnailDataUrl, alt: `${source.label} preview`, class: 'source-card__img' }),
    el('span', { class: 'source-card__label' }, source.label),
    el('span', { class: 'source-card__kind' }, source.kind === 'screen' ? 'Screen' : 'Window'),
  );
  return btn;
}

function renderGuidanceAnswer(): El {
  const answer = state.guidanceView?.text.trim();
  return screen(
    wideStack(
      el(
        'article',
        { class: 'answer' },
        intro(
          'Here is the guidance.',
          answer || 'Use a real table only for data, add a caption, and mark header cells so screen readers can map relationships.',
        ),
        el(
          'section',
          { class: 'panel steps' },
          el('h2', { class: 'panel__title' }, 'In Canvas'),
          step('1', 'Use the table tool for tabular data only.'),
          step('2', 'Add a short caption and header row.'),
          step('3', 'Run the Canvas Accessibility Checker before publishing.'),
        ),
        el('div', { class: 'chips' }, el('span', { class: 'chip chip--blue' }, 'Rubric D4'), el('span', { class: 'chip chip--blue' }, 'WCAG 1.3.1'), el('span', { class: 'chip chip--blue' }, 'Canvas checker')),
        btnRow(
          actionButton('Ask another', () => go('guidance-ask'), 'btn btn--secondary'),
          actionButton('Build a table', () => {
            state.selectedTemplate = 'page-content';
            go('build-details');
          }),
        ),
      ),
    ),
  );
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

function chip(label: string, onClick: () => void): El {
  return actionButton(label, onClick, 'chip');
}

function step(num: string, text: string): El {
  return el('div', { class: 'step' }, el('span', { class: 'step__num' }, num), el('span', {}, text));
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

function checkRow(text: string): El {
  return el('div', { class: 'check-row' }, el('span', { class: 'check-row__icon' }, 'OK'), el('span', {}, text));
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

function remediateEvidencePanel(fragment: FragmentVm): El {
  const result = fragment.remediateResult!;
  const beforeCode = el('code');
  beforeCode.textContent = result.before;
  const afterCode = el('code');
  afterCode.textContent = result.after;
  return el(
    'section',
    { class: 'panel two-col', 'data-testid': 'remediate-before-after' },
    el(
      'div',
      {},
      el('h2', { class: 'panel__title' }, 'Before'),
      el('pre', { class: 'code-panel', 'data-testid': 'remediate-before-html' }, beforeCode),
    ),
    el(
      'div',
      {},
      el('h2', { class: 'panel__title' }, 'After'),
      el('pre', { class: 'code-panel', 'data-testid': 'remediate-after-html' }, afterCode),
    ),
  );
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

function remediateHeaderBadge(): string {
  if (firstPassedFragment(state.remediateView)) return 'Ready';
  if (firstFragment(state.remediateView)) return 'Checks withheld';
  return 'Review';
}

function remediateHeaderKind(): 'blue' | 'green' | 'amber' | 'neutral' {
  if (firstPassedFragment(state.remediateView)) return 'green';
  if (firstFragment(state.remediateView)) return 'amber';
  return 'neutral';
}

function remediateFixedDiffs(view: TurnView | undefined): string[] {
  const diffs = turnViewToVm(view ?? { text: '', fragments: [], toolsUsed: [], iterations: 0 }).fragments
    .flatMap((fragment) => fragment.remediateResult?.issueDiffs ?? [])
    .filter((diff) => diff.fixed)
    .map((diff) => diff.message);
  return diffs;
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
      state.healthText = `Model missing: ${health.model.installCommand}`;
    } else {
      state.healthText = ok
        ? `Local runtime ready${health.model ? ` - ${health.model.tag}` : ''}`
        : `Local runtime: llm ${health.llm ? 'up' : 'down'}, ingest ${health.ingest ? 'up' : 'down'}`;
    }
  } catch {
    state.health = 'degraded';
    state.healthText = 'Local runtime unavailable';
  } finally {
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
      go('remediate-result');
    } else {
      state.guidanceView = view;
      go('guidance-answer');
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

async function generateBuild(): Promise<void> {
  const prompt = [
    `Build a ${templateLabel(state.selectedTemplate)} Canvas page.`,
    `Title: ${state.buildTitle || 'Module 1 - Getting Started'}`,
    state.buildRhythm ? `Dates or rhythm: ${state.buildRhythm}` : 'Dates or rhythm: [TBD]',
    state.buildTasks ? `Learner tasks: ${state.buildTasks}` : 'Learner tasks: read chapter 1; post to the introductions discussion.',
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
    go('remediate-result');
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
    go('guidance-answer');
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
