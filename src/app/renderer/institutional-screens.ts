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

/** Where an institutional task card / nav can lead. */
export type InstTarget = 'ask' | 'brand' | 'ingest' | 'remediation';

export interface InstDeps {
  onNavigate(target: InstTarget): void;
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
  { num: '01', title: 'Check accessibility', desc: 'Scan a Canvas page against WCAG 2.2 AA, then remediate each issue with a guided fix.', target: 'remediation', primary: true },
  { num: '02', title: 'Ask a question', desc: 'Get cited, step-by-step guidance on accessible course design — answered on-device.', target: 'ask' },
  { num: '03', title: 'Build a brand kit', desc: 'Resolve a contrast-safe palette from two brand colours, with a live template preview.', target: 'brand' },
  { num: '04', title: 'Ingest a document', desc: 'Convert PDFs, Word, and slides into structured, accessible text and markdown.', target: 'ingest' },
];

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

export function createInstAsk(_deps: InstDeps, data?: InstAskData): InstScreen {
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
      el(
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

export function createInstBrand(_deps: InstDeps, data?: InstBrandData): InstScreen {
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
    el('div', { class: 'inst-hero' }, sectionLabel('Saved kits'), ...kits.map((k) => savedKit(k.name, k.gradient, k.meta))),
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

export function createInstIngest(_deps: InstDeps, data?: InstIngestData): InstScreen {
  const dropzone = el(
    'div',
    { class: 'inst-dropzone' },
    el('div', { class: 'inst-dropzone__icon', 'aria-hidden': 'true' }, '↑'),
    el(
      'div',
      { class: 'inst-hero', style: 'align-items:center;gap:4px;text-align:center;' },
      el('span', { class: 'inst-dropzone__title' }, 'Drop a document here'),
      el('span', { class: 'inst-dropzone__sub' }, 'or click to browse your files'),
    ),
    el('div', { class: 'inst-formats' }, ...['PDF', 'DOCX', 'PPTX', 'HTML', 'PNG'].map((f) => el('span', { class: 'inst-fmt' }, f))),
  );

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
