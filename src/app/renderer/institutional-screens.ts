/**
 * Institutional screens — design-to-code port of the Paper redesign
 * ("Canvas Agent — Institutional Redesign": Home, Ask & Answer, Brand kit,
 * Document ingest). Each factory returns a `.inst` screen body (the app's own
 * header provides the chrome, as with the remediation panel). Presentational,
 * seeded with representative data; built with `el()` per ui.ts conventions and
 * styled by the `.inst` token scope in index.html.
 *
 * The serif is a Georgia system fallback (the renderer is offline under a strict
 * no-`font-src` CSP) and icons use the codebase's glyph-in-a-box idiom.
 */
import { el, type El } from './ui.js';

/**
 * Where an institutional task card / nav can lead. The first four are the
 * home task cards; the rest are secondary destinations surfaced as compact
 * links so every place reachable from the classic home stays reachable here.
 */
export type InstTarget =
  | 'ask'
  | 'brand'
  | 'ingest'
  | 'remediation'
  | 'build'
  | 'fix'
  | 'saved'
  | 'alignment'
  | 'brand-manager';

export interface InstDeps {
  onNavigate(target: InstTarget): void;
}

/** A screenshot already attached to the pending question. */
export interface InstAskScreenshot {
  id: string;
  label: string;
  dataUrl: string;
}

/** A capturable screen/window source, surfaced after `onAttachScreenshot` resolves. */
export interface InstAskSource {
  id: string;
  label: string;
  kind: 'screen' | 'window';
  thumbnailDataUrl: string;
}

/** Interactive plumbing for the Ask & Answer screen's live question input. */
export interface InstAskDeps {
  onAsk(question: string): void;
  /** True while a guidance turn is running — disables the submit + shows "Asking…". */
  busy?: boolean;
  /** The half-typed question, if any — restored into the input on re-render. */
  draft?: string;
  /** Fired on every input edit so the caller can preserve the draft across re-renders. */
  onDraftChange?(value: string): void;
  /** Screenshots already attached to the pending question. */
  screenshots?: InstAskScreenshot[];
  /** Starts the capture flow (permission check + source listing). Omit to hide the affordance entirely. */
  onAttachScreenshot?(): void;
  /** Removes an attached screenshot by id. */
  onRemoveScreenshot?(id: string): void;
  /** Capture sources surfaced after `onAttachScreenshot` resolves; pick one to capture. */
  screenshotSources?: InstAskSource[];
  /** Captures from the given source id. */
  onCaptureSource?(id: string): void;
  /** Permission-state (or reassurance) copy shown under the attach affordance. */
  screenshotHint?: string;
}

/** Interactive plumbing for the Document ingest screen's file picker. */
export interface InstIngestDeps {
  /** Fired with the native file-input change event when a document is chosen. */
  onFile(event: unknown): void;
  busy?: boolean;
}

export interface InstScreen {
  element: El;
}

// ── Live-data view models (omit → the screen renders its representative seed) ──

export interface InstAskData {
  question: string;
  /** Meta line, e.g. "Answered on-device · Gemma · 2 tools". */
  meta: string;
  /** The answer prose; split on blank lines into paragraphs. */
  answer: string;
}

export interface InstRole {
  /** Background colour of the role's sample chip. */
  sample: string;
  name: string;
  ratio: string;
  level: 'AA' | 'AAA';
}

export interface InstPreviewColors {
  bannerBg: string;
  bannerFg: string;
  calloutBg: string;
  calloutFg: string;
  btnBg: string;
  btnFg: string;
}

export interface InstBrandData {
  primary: string;
  secondary: string;
  roles: InstRole[];
  note: { ok: boolean; text: string };
  kits: { name: string; gradient: string; meta: string }[];
  preview: InstPreviewColors;
}

export interface InstIngestData {
  fileName: string;
  ext: string;
  status: string;
  statusColor: string;
  /** Converted markdown/text/HTML, rendered as escaped text. */
  content: string;
  meta: string;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function col(wide: boolean, ...children: El[]): El {
  return el('div', { class: wide ? 'inst__col inst__col--wide' : 'inst__col' }, ...children);
}

function sectionLabel(text: string): El {
  return el('div', { class: 'inst-seclabel' }, el('span', {}, text), el('div', { class: 'inst-rule' }));
}

function hero(eyebrow: string, title: string, lead: string, smallTitle = false): El {
  return el(
    'div',
    { class: 'inst-hero' },
    el('span', { class: 'inst-eyebrow' }, eyebrow),
    el('h1', { class: smallTitle ? 'inst-display inst-display--sm' : 'inst-display' }, title),
    el('p', { class: 'inst-lead' }, lead),
  );
}

// ── Home ─────────────────────────────────────────────────────────────────────

interface TaskDef {
  num: string;
  title: string;
  desc: string;
  target: InstTarget;
  primary?: boolean;
}

const HOME_TASKS: TaskDef[] = [
  { num: '01', title: 'Build a Canvas page', desc: 'Create a page from a guided template and get checked, Canvas-ready HTML.', target: 'build', primary: true },
  { num: '02', title: 'Check accessibility', desc: 'Scan a Canvas page against WCAG 2.2 AA, then remediate each issue with a guided fix.', target: 'remediation' },
  { num: '03', title: 'Ask a question', desc: 'Get cited, step-by-step guidance on accessible course design — answered on-device.', target: 'ask' },
  { num: '04', title: 'Build a brand kit', desc: 'Resolve a contrast-safe palette from two brand colours, with a live template preview.', target: 'brand' },
  { num: '05', title: 'Ingest a document', desc: 'Convert PDFs, Word, and slides into structured, accessible text and markdown.', target: 'ingest' },
];

// Secondary destinations from the classic home that aren't task cards; rendered
// as compact chips so nothing that used to be reachable from home is orphaned.
const HOME_LINKS: { label: string; target: InstTarget }[] = [
  { label: 'Fix an existing page', target: 'fix' },
  { label: 'Saved work', target: 'saved' },
  { label: 'Alignment coach', target: 'alignment' },
];

function linkChip(link: { label: string; target: InstTarget }, deps: InstDeps): El {
  const chip = el('button', { type: 'button', class: 'inst-chip', 'data-testid': `inst-link-${link.target}` }, link.label);
  chip.addEventListener('click', () => deps.onNavigate(link.target));
  return chip;
}

function taskRow(task: TaskDef, deps: InstDeps): El {
  const row = el(
    'button',
    { type: 'button', class: task.primary ? 'inst-task inst-task--primary' : 'inst-task', 'data-testid': `inst-task-${task.target}` },
    el('span', { class: 'inst-task__num' }, task.num),
    el(
      'span',
      { class: 'inst-task__copy' },
      el('span', { class: 'inst-task__title' }, task.title),
      el('span', { class: 'inst-task__desc' }, task.desc),
    ),
    el('span', { class: 'inst-task__arrow', 'aria-hidden': 'true' }, '→'),
  );
  row.addEventListener('click', () => deps.onNavigate(task.target));
  return row;
}

export function createInstHome(deps: InstDeps): InstScreen {
  const tasks = el(
    'div',
    { class: 'inst-tasks' },
    sectionLabel('Choose a task'),
    ...HOME_TASKS.map((t) => taskRow(t, deps)),
  );
  const links = el(
    'div',
    { class: 'inst-hero' },
    sectionLabel('More'),
    el('div', { class: 'inst-chips' }, ...HOME_LINKS.map((l) => linkChip(l, deps))),
  );
  const element = el(
    'div',
    { class: 'inst' },
    col(
      false,
      hero(
        'WCAG 2.2 AA · On-device',
        'Design accessible courses, start to finish.',
        'A private studio for Canvas course content — review pages against WCAG, remediate issues, build contrast-safe brand kits, and turn documents into structured, accessible text. Nothing leaves this machine.',
      ),
      tasks,
      links,
    ),
  );
  return { element };
}

// ── Ask & Answer ─────────────────────────────────────────────────────────────

interface StepDef { num: string; title: string; body: string; }
const ASK_STEPS: StepDef[] = [
  { num: '1', title: 'Add a caption', body: 'Use the table’s caption field to name it — "Weekly schedule." Screen readers announce the caption first, giving listeners context before the data.' },
  { num: '2', title: 'Mark the header row', body: 'Select the top row and set it as a column header so every cell is programmatically tied to its heading.' },
  { num: '3', title: 'Avoid merged cells', body: 'Split any merged cells. Spanned cells break the row-and-column relationship screen readers rely on to read data in order.' },
  { num: '4', title: 'Keep tables for data only', body: 'Never use a table to lay out a page. Reserve them for genuine data; use headings and lists to structure everything else.' },
];

interface SourceDef { kind: string; title: string; host: string; }
const ASK_SOURCES: SourceDef[] = [
  { kind: 'WCAG 2.2', title: '1.3.1 Info & Relationships', host: 'w3.org/WAI/WCAG22' },
  { kind: 'Canvas Guide', title: 'Tables in the editor', host: 'community.canvaslms.com' },
  { kind: 'WebAIM', title: 'Creating Accessible Tables', host: 'webaim.org/techniques' },
];

const ASK_CHIPS = ['Show me an example', 'What about merged headers?', 'Check this page for me'];

function stepRow(step: StepDef): El {
  return el(
    'div',
    { class: 'inst-step' },
    el('span', { class: 'inst-step__num' }, step.num),
    el(
      'div',
      { class: 'inst-step__copy' },
      el('span', { class: 'inst-step__title' }, step.title),
      el('span', { class: 'inst-step__body' }, step.body),
    ),
  );
}

function sourceCard(src: SourceDef): El {
  return el(
    'div',
    { class: 'inst-source' },
    el('span', { class: 'inst-source__kind' }, src.kind),
    el('span', { class: 'inst-source__title' }, src.title),
    el('span', { class: 'inst-source__host' }, src.host),
  );
}

/** One attached-screenshot chip, with a remove control. */
function screenshotChip(shot: InstAskScreenshot, ask: InstAskDeps): El {
  const remove = el(
    'button',
    {
      type: 'button',
      class: 'inst-shot-chip__remove',
      'aria-label': `Remove ${shot.label} screenshot`,
      'data-testid': 'inst-ask-shot-remove',
    },
    '×',
  );
  remove.addEventListener('click', () => ask.onRemoveScreenshot?.(shot.id));
  return el(
    'div',
    { class: 'inst-shot-chip' },
    el('img', { src: shot.dataUrl, alt: `${shot.label} screenshot preview`, class: 'inst-shot-chip__img' }),
    el('span', { class: 'inst-shot-chip__label' }, shot.label),
    remove,
  );
}

/** One capturable source, offered after `onAttachScreenshot` lists them. */
function screenshotSourceCard(source: InstAskSource, ask: InstAskDeps): El {
  const btn = el(
    'button',
    { type: 'button', class: 'inst-shot-source', 'data-testid': `inst-ask-source-${source.id}` },
    el('img', { src: source.thumbnailDataUrl, alt: `${source.label} preview`, class: 'inst-shot-source__img' }),
    el('span', { class: 'inst-shot-source__label' }, source.label),
  );
  btn.addEventListener('click', () => ask.onCaptureSource?.(source.id));
  return btn;
}

/**
 * Compact "Attach screenshot" affordance + attached thumbnails, near the
 * question input. Only rendered when the caller wires `onAttachScreenshot`
 * (the seed/unwired render has no screenshot capability to offer).
 */
function screenshotAttach(ask: InstAskDeps): El {
  const hint =
    ask.screenshotHint ??
    'Screenshots are summarized on-device for this question; raw pixels are not stored in the session.';
  const attachBtn = el(
    'button',
    { type: 'button', class: 'inst-btn inst-btn--ghost inst-btn--small', 'data-testid': 'inst-ask-attach' },
    ask.busy ? 'Capturing…' : 'Attach screenshot',
  );
  attachBtn.disabled = Boolean(ask.busy);
  attachBtn.addEventListener('click', () => ask.onAttachScreenshot?.());
  const children: El[] = [
    el('div', { class: 'inst-shot-toolbar' }, el('span', { class: 'inst-shot-hint' }, hint), attachBtn),
  ];
  const screenshots = ask.screenshots ?? [];
  if (screenshots.length > 0) {
    children.push(
      el(
        'div',
        { class: 'inst-shot-rail', 'aria-label': 'Attached screenshots' },
        ...screenshots.map((shot) => screenshotChip(shot, ask)),
      ),
    );
  }
  const sources = ask.screenshotSources ?? [];
  if (sources.length > 0) {
    children.push(
      el(
        'div',
        { class: 'inst-shot-sources', 'aria-label': 'Screenshot sources' },
        ...sources.map((source) => screenshotSourceCard(source, ask)),
      ),
    );
  }
  return el('div', { class: 'inst-shot' }, ...children);
}

/** The live question input + submit button (replaces the seed's static field). */
function askField(ask: InstAskDeps, hasAnswer: boolean): El {
  const input = el('input', {
    class: 'inst-field__input',
    type: 'text',
    'aria-label': 'Ask a question',
    placeholder: hasAnswer ? 'Ask a follow-up question…' : 'Ask a question about accessible course design…',
    'data-testid': 'inst-ask-input',
  });
  // The renderer replaces the whole DOM subtree on every render(), so the
  // draft must round-trip through the caller or attach/capture re-renders
  // would wipe a half-typed question.
  input.value = ask.draft ?? '';
  input.addEventListener('input', () => ask.onDraftChange?.(input.value));
  const submit = el(
    'button',
    { type: 'button', class: 'inst-btn inst-btn--primary inst-btn--field', 'data-testid': 'inst-ask-submit' },
    ask.busy ? 'Asking…' : 'Ask',
  );
  submit.disabled = Boolean(ask.busy);
  const run = (): void => {
    if (!ask.busy) ask.onAsk(input.value);
  };
  submit.addEventListener('click', run);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') run();
  });
  return el('div', { class: 'inst-field' }, input, submit);
}

export function createInstAsk(_deps: InstDeps, data?: InstAskData, ask?: InstAskDeps): InstScreen {
  const question = el(
    'div',
    { class: 'inst-hero' },
    el('span', { class: 'inst-eyebrow' }, 'Question'),
    el('h1', { class: 'inst-question' }, data ? data.question : 'How do I make a data table accessible in Canvas?'),
    el(
      'div',
      { class: 'inst-meta' },
      el('span', { class: 'inst-dot' }),
      el('span', {}, data ? data.meta : 'Answered on-device · Gemma · 1.2s · 3 sources cited'),
    ),
  );

  // Real guidance output is prose (no structured steps/sources), so bound data
  // renders the answer as paragraphs; the seed shows the designed steps+sources.
  const answer = data
    ? el(
        'div',
        { class: 'inst-answer' },
        ...data.answer.split(/\n{2,}/).map((p) => el('p', { class: 'inst-answer__p' }, p.trim())),
      )
    : el(
        'div',
        { class: 'inst-answer' },
        el('p', { class: 'inst-answer__lead' }, 'Canvas’s table tools can produce WCAG-compliant markup once a few properties are set. Work through these in the page editor:'),
        el('div', { class: 'inst-steps' }, ...ASK_STEPS.map(stepRow)),
      );

  const sections: El[] = [question, answer];
  if (!data) {
    sections.push(
      el('div', { class: 'inst-hero' }, sectionLabel('Sources · 3'), el('div', { class: 'inst-cards' }, ...ASK_SOURCES.map(sourceCard))),
    );
  }
  sections.push(
    el(
      'div',
      { class: 'inst-hero' },
      el('div', { class: 'inst-chips' }, ...ASK_CHIPS.map((c) => el('span', { class: 'inst-chip' }, c))),
      // Screenshot attach affordance, only when the caller wires it up.
      ...(ask?.onAttachScreenshot ? [screenshotAttach(ask)] : []),
      // Live input when wired to a guidance turn; otherwise the static seed field.
      ask
        ? askField(ask, Boolean(data))
        : el(
            'div',
            { class: 'inst-field' },
            el('span', { class: 'inst-field__ph' }, 'Ask a follow-up question…'),
            el('span', { class: 'inst-btn inst-btn--primary inst-btn--field' }, 'Ask'),
          ),
    ),
  );

  return { element: el('div', { class: 'inst' }, col(false, ...sections)) };
}

// ── Brand kit ────────────────────────────────────────────────────────────────

interface RoleDef { sample: string; name: string; ratio: string; level: 'AA' | 'AAA'; }
const BRAND_ROLES: RoleDef[] = [
  { sample: '#0374B5', name: 'Heading', ratio: '4.61 : 1', level: 'AA' },
  { sample: '#2D3B45', name: 'Accent', ratio: '11.86 : 1', level: 'AAA' },
  { sample: '#0374B5', name: 'Button', ratio: '4.61 : 1', level: 'AA' },
  { sample: '#2D3B45', name: 'Callout', ratio: '11.86 : 1', level: 'AAA' },
  { sample: '#0374B5', name: 'Link', ratio: '4.61 : 1', level: 'AA' },
];

function colorInput(label: string, hex: string): El {
  const swatch = el('div', { class: 'inst-swatch' });
  swatch.setAttribute('style', `background:${hex};`);
  return el(
    'div',
    { class: 'inst-input' },
    swatch,
    el(
      'div',
      { class: 'inst-input__copy' },
      el('span', { class: 'inst-input__label' }, label),
      el('span', { class: 'inst-input__hex' }, hex),
    ),
    el('span', { class: 'inst-input__edit' }, 'Edit'),
  );
}

function roleRow(role: RoleDef): El {
  const sample = el('div', { class: 'inst-role__sample' }, 'Aa');
  sample.setAttribute('style', `background:${role.sample};`);
  return el(
    'div',
    { class: 'inst-role' },
    sample,
    el('span', { class: 'inst-role__name' }, role.name),
    el('span', { class: 'inst-role__ratio' }, role.ratio),
    el('span', { class: `inst-badge inst-badge--${role.level === 'AAA' ? 'aaa' : 'aa'}` }, role.level),
  );
}

function savedKit(name: string, gradient: string, meta: string): El {
  const dot = el('div', { class: 'inst-kit__dot' });
  dot.setAttribute('style', `background:${gradient};`);
  return el(
    'div',
    { class: 'inst-kit' },
    dot,
    el('span', { class: 'inst-kit__name' }, name),
    el('span', { class: 'inst-kit__meta' }, meta),
    el('span', { class: 'inst-kit__del', 'aria-hidden': 'true' }, '×'),
  );
}

const SEED_PREVIEW: InstPreviewColors = {
  bannerBg: '#0374B5', bannerFg: '#FFFFFF', calloutBg: '#2D3B45', calloutFg: '#FFFFFF', btnBg: '#0374B5', btnFg: '#FFFFFF',
};

function styled(node: El, css: string): El {
  node.setAttribute('style', css);
  return node;
}

function brandPreview(p: InstPreviewColors): El {
  return el(
    'div',
    { class: 'inst-prev' },
    el(
      'div',
      { class: 'inst-prev__bar' },
      el('div', { class: 'inst-prev__dot' }),
      el('div', { class: 'inst-prev__dot' }),
      el('div', { class: 'inst-prev__dot' }),
      el('span', {}, 'Module page · sample'),
    ),
    styled(
      el(
        'div',
        { class: 'inst-prev__banner' },
        styled(el('span', { class: 'inst-prev__h' }, 'Module 1 — Welcome'), `color:${p.bannerFg};`),
        styled(el('span', { class: 'inst-prev__sub' }, 'Biology 204 · Cellular foundations'), `color:${p.bannerFg};`),
      ),
      `background:${p.bannerBg};`,
    ),
    el(
      'div',
      { class: 'inst-prev__body' },
      el('p', { class: 'inst-prev__p' }, 'This module introduces cellular biology. Work through the reading, then complete the lab before the weekly check-in.'),
      styled(
        el(
          'div',
          { class: 'inst-prev__callout' },
          styled(el('span', { class: 'inst-prev__callout-k' }, 'Due Friday'), `color:${p.calloutFg};`),
          styled(el('span', { class: 'inst-prev__callout-t' }, 'Submit your lab notebook before 5:00 PM.'), `color:${p.calloutFg};`),
        ),
        `background:${p.calloutBg};`,
      ),
      el(
        'div',
        { class: 'inst-prev__actions' },
        styled(el('span', { class: 'inst-prev__btn' }, 'Start module'), `background:${p.btnBg};color:${p.btnFg};`),
        styled(el('span', { class: 'inst-prev__link' }, 'View syllabus'), `color:${p.btnBg};`),
      ),
    ),
  );
}

function brandNote(ok: boolean, text: string): El {
  return el(
    'div',
    { class: ok ? 'inst-note' : 'inst-note inst-note--warn' },
    el('span', { class: 'inst-note__icon', 'aria-hidden': 'true' }, ok ? '✓' : '!'),
    el('span', { class: 'inst-note__text' }, text),
  );
}

/** "Manage brand kits" action → the full brand-manager screen. */
function manageKitsButton(deps: InstDeps): El {
  const btn = el(
    'button',
    { type: 'button', class: 'inst-btn inst-btn--ghost', 'data-testid': 'inst-brand-manage' },
    'Manage brand kits',
  );
  btn.addEventListener('click', () => deps.onNavigate('brand-manager'));
  return btn;
}

export function createInstBrand(deps: InstDeps, data?: InstBrandData): InstScreen {
  const primary = data ? data.primary : '#0374B5';
  const secondary = data ? data.secondary : '#2D3B45';
  const roles = data ? data.roles : BRAND_ROLES;
  const note = data ? data.note : { ok: true, text: 'All five roles pass WCAG AA — this palette is safe to ship.' };
  const preview = data ? data.preview : SEED_PREVIEW;
  const kits = data
    ? data.kits
    : [
        { name: 'Biology — Spring', gradient: 'linear-gradient(90deg, #0374B5 50%, #2D3B45 50%)', meta: '5 roles · AA' },
        { name: 'History — Survey', gradient: 'linear-gradient(90deg, #2E5D3B 50%, #8A5A12 50%)', meta: '5 roles · AAA' },
      ];

  const left = el(
    'div',
    { class: 'inst-cols__left' },
    el('div', { class: 'inst-hero' }, sectionLabel('Your colours'), colorInput('Primary', primary), colorInput('Secondary', secondary)),
    el('div', { class: 'inst-hero' }, sectionLabel('Resolved roles'), ...roles.map(roleRow)),
    brandNote(note.ok, note.text),
  );

  const right = el(
    'div',
    { class: 'inst-cols__right' },
    el('div', { class: 'inst-hero' }, sectionLabel('Live preview'), brandPreview(preview)),
    el(
      'div',
      { class: 'inst-field' },
      el('span', { class: 'inst-field__ph' }, 'Name this kit…'),
      el('span', { class: 'inst-btn inst-btn--primary inst-btn--field' }, 'Save kit'),
    ),
    el(
      'div',
      { class: 'inst-hero' },
      sectionLabel('Saved kits'),
      ...kits.map((k) => savedKit(k.name, k.gradient, k.meta)),
      manageKitsButton(deps),
    ),
  );

  const element = el(
    'div',
    { class: 'inst' },
    col(
      true,
      hero('Brand kit', 'A palette that always passes.', 'Pick two brand colours. Canvas Agent resolves every course role to a contrast-safe pairing — checked against WCAG, instantly, on-device.', true),
      el('div', { class: 'inst-cols' }, left, right),
    ),
  );
  return { element };
}

// ── Document ingest ──────────────────────────────────────────────────────────

interface FileDef { ext: string; extColor: string; name: string; status: string; statusColor: string; active?: boolean; check?: boolean; }
const INGEST_FILES: FileDef[] = [
  { ext: 'PDF', extColor: 'var(--color-oxblood)', name: 'syllabus.pdf', status: 'Converted · 12 elements', statusColor: 'var(--color-forest)', active: true, check: true },
  { ext: 'PPTX', extColor: 'var(--color-oak)', name: 'lecture-1.pptx', status: 'Converting · 64%', statusColor: 'var(--color-oak)' },
  { ext: 'DOCX', extColor: 'var(--color-muted)', name: 'rubric.docx', status: 'Queued', statusColor: 'var(--color-muted)' },
];

function fileRow(file: FileDef): El {
  const ext = el('span', { class: 'inst-file__ext' }, file.ext);
  ext.setAttribute('style', `color:${file.extColor};`);
  const status = el('span', { class: 'inst-file__status' }, file.status);
  status.setAttribute('style', `color:${file.statusColor};`);
  const children: El[] = [
    ext,
    el('span', { class: 'inst-file__copy' }, el('span', { class: 'inst-file__name' }, file.name), status),
  ];
  if (file.check) {
    const tick = el('span', { 'aria-hidden': 'true' }, '✓');
    tick.setAttribute('style', 'width:24px;flex-shrink:0;text-align:center;color:var(--color-forest);');
    children.push(tick);
  }
  return el('div', { class: file.active ? 'inst-file inst-file--active' : 'inst-file' }, ...children);
}

const INGEST_BULLETS = [
  'Weeks 1–4 — Cellular foundations and membrane transport',
  'Weeks 5–9 — Genetics, transcription, and translation',
  'Weeks 10–14 — Systems biology and the final project',
];

/** Accept list mirrors the classic document-provide file input. */
const INGEST_ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.html,.htm,.md,.txt,.rtf,image/*';

export function createInstIngest(_deps: InstDeps, data?: InstIngestData, ingest?: InstIngestDeps): InstScreen {
  const dropzoneBody: El[] = [
    el('div', { class: 'inst-dropzone__icon', 'aria-hidden': 'true' }, '↑'),
    el(
      'div',
      { class: 'inst-hero', style: 'align-items:center;gap:4px;text-align:center;' },
      el('span', { class: 'inst-dropzone__title' }, ingest?.busy ? 'Converting…' : 'Drop a document here'),
      el('span', { class: 'inst-dropzone__sub' }, 'or click to browse your files'),
    ),
    el('div', { class: 'inst-formats' }, ...['PDF', 'DOCX', 'PPTX', 'HTML', 'PNG'].map((f) => el('span', { class: 'inst-fmt' }, f))),
  ];
  // When wired, the dropzone is a <label> wrapping a hidden file input, so a
  // click browses and a chosen file reuses the renderer's convert path.
  let dropzone: El;
  if (ingest) {
    const fileInput = el('input', {
      type: 'file',
      accept: INGEST_ACCEPT,
      'aria-label': 'Choose document to convert',
      'data-testid': 'inst-ingest-file',
      style: 'position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;',
    });
    fileInput.addEventListener('change', (event: unknown) => ingest.onFile(event));
    dropzone = el('label', { class: 'inst-dropzone', 'data-testid': 'inst-ingest-upload' }, fileInput, ...dropzoneBody);
  } else {
    dropzone = el('div', { class: 'inst-dropzone' }, ...dropzoneBody);
  }

  const files: FileDef[] = data
    ? [{ ext: data.ext, extColor: 'var(--color-navy)', name: data.fileName, status: data.status, statusColor: data.statusColor, active: true, check: true }]
    : INGEST_FILES;
  const queue = el(
    'div',
    { class: 'inst-hero' },
    sectionLabel(data ? 'This session · 1' : 'This session · 3'),
    ...files.map(fileRow),
  );

  const left = el('div', { class: 'inst-cols__left' }, dropzone, queue);

  const outputHead = el(
    'div',
    { class: 'inst-card__head' },
    el(
      'div',
      { style: 'display:flex;align-items:center;gap:12px;min-width:0;' },
      el('span', { class: 'inst-source__host', style: 'font-size:13px;font-weight:600;color:var(--color-ink);' }, data ? data.fileName : 'syllabus.md'),
      el(
        'span',
        { class: 'inst-meta', style: 'font-weight:600;color:var(--color-forest);' },
        el('span', { class: 'inst-dot' }),
        'Converted',
      ),
    ),
    el(
      'div',
      { class: 'inst-toggle' },
      el('span', { class: 'inst-toggle__on' }, 'Preview'),
      el('span', { class: 'inst-toggle__off' }, 'Markdown'),
    ),
  );

  const doc = data
    ? el('div', { class: 'inst-doc' }, el('pre', { class: 'inst-doc__pre' }, data.content))
    : el(
        'div',
        { class: 'inst-doc' },
        el(
          'div',
          { style: 'display:flex;flex-direction:column;gap:6px;' },
          el('span', { class: 'inst-doc__h' }, 'Biology 204 — Syllabus'),
          el('span', { class: 'inst-doc__cap' }, 'Heading 1 · detected from title page'),
        ),
        el('p', { class: 'inst-doc__p' }, 'This course introduces the molecular and cellular basis of life. Weekly readings pair with lab work; assessment is by three exams and a final project.'),
        el('span', { class: 'inst-doc__h2' }, 'Course schedule'),
        el(
          'div',
          { style: 'display:flex;flex-direction:column;gap:9px;' },
          ...INGEST_BULLETS.map((b) => el('div', { class: 'inst-li' }, el('span', { class: 'inst-li__b' }), el('span', { class: 'inst-li__t' }, b))),
        ),
        el(
          'div',
          { class: 'inst-alt' },
          el('span', { class: 'inst-alt__icon', 'aria-hidden': 'true' }, '!'),
          el(
            'div',
            { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;' },
            el('span', { class: 'inst-alt__t' }, '1 image needs alt text'),
            el('span', { class: 'inst-alt__b' }, 'figure-1.png was extracted without a description. Canvas Agent left a scaffold for you to complete before export.'),
          ),
          el('span', { class: 'inst-alt__btn' }, 'Add alt text'),
        ),
      );

  const right = el(
    'div',
    { class: 'inst-cols__right' },
    el('div', { class: 'inst-card' }, outputHead, doc),
    el(
      'div',
      { class: 'inst-split' },
      el('span', { class: 'inst-kit__meta' }, data ? data.meta : '12 elements · 1 table · 1 image'),
      el(
        'div',
        { style: 'display:flex;align-items:center;gap:10px;' },
        el('span', { class: 'inst-btn inst-btn--ghost' }, 'Send to Canvas'),
        el('span', { class: 'inst-btn inst-btn--primary' }, '↓  Export Markdown'),
      ),
    ),
  );

  const element = el(
    'div',
    { class: 'inst' },
    col(
      true,
      hero('Document ingest', 'Turn any document into accessible text.', 'Convert PDFs, Word files, slides, and scans into clean, structured Markdown — headings, lists, tables, and alt-text scaffolding intact. Processed entirely on this machine.', true),
      el('div', { class: 'inst-cols' }, left, right),
    ),
  );
  return { element };
}
