/**
 * Accessibility remediation panel — institutional redesign, ported from the
 * Paper design "Canvas Agent — Institutional Redesign" (artboard "02 ·
 * Accessibility remediation").
 *
 * Two columns: a sidebar (page context + severity tally + issue list) and a
 * main panel (the selected issue, a before/after contrast preview, the
 * suggested CSS fix as a diff, and an action bar). Pure view layer — it builds
 * DOM from a `RemediationView` and emits intent through `deps` callbacks; it
 * never touches `document`/`window` directly (that lives in ui.ts).
 *
 * Exact spacing/colour values come from the Paper file's design tokens (the
 * `--color-*` / `--radius-*` set added to index.html), NOT from screenshots.
 * The serif is a SYSTEM fallback (Georgia): the renderer runs offline under a
 * strict CSP with no `font-src`, so the Paper "Source Serif 4" face cannot be
 * fetched — Georgia carries the same editorial weight on macOS.
 */
import { el, type El } from './ui.js';

export type Severity = 'fail' | 'warn';

export interface RemediationIssue {
  id: string;
  title: string;
  /** Short element locator, shown in mono, e.g. "Heading · 2.9:1". */
  element: string;
  severity: Severity;
}

export interface ContrastSample {
  /** e.g. "2.9 : 1 · Fail". */
  ratio: string;
  level: Severity | 'pass';
  /** Heading colour rendered in the preview tile (the element under test). */
  headingColor: string;
}

export interface RemediationDetail {
  /** Severity tag text, e.g. "Fails AA". */
  tag: string;
  severity: Severity;
  /** e.g. "WCAG 1.4.3 · Contrast (Minimum)". */
  wcag: string;
  /** e.g. "Issue 1 of 5". */
  position: string;
  title: string;
  description: string;
  /** CSS selector for the suggested fix (demo contrast mode). */
  selector?: string;
  /** Demo contrast-preview tiles (the heading under test, before/after). */
  before?: ContrastSample;
  after?: ContrastSample;
  /** Diff lines for the suggested CSS fix (demo contrast mode). */
  fix?: { removed: string; added: string };
  /**
   * Real page-level before/after HTML from a remediation run. Rendered as
   * escaped text (never innerHTML). Used instead of the contrast tiles when the
   * panel is driven by live `RemediateResult` data rather than the demo seed.
   */
  htmlBefore?: string;
  htmlAfter?: string;
}

export interface RemediationView {
  page: { title: string; path: string };
  summary: { fail: number; warn: number; pass: number };
  issues: RemediationIssue[];
  selectedId: string;
  detail: RemediationDetail;
}

export interface RemediationDeps {
  /** A sidebar issue was selected. */
  onSelect(issueId: string): void;
  /** The user accepted the suggested fix for the current issue. */
  onApply(issueId: string): void;
  /** The user skipped the current issue. */
  onSkip(issueId: string): void;
  /** Copy the suggested-fix CSS to the clipboard. */
  onCopyFix(): void;
  /**
   * Download the corrected page HTML. Optional so the demo/seed usage keeps a
   * clean footer; when present (live remediation) it renders a footer button —
   * the equivalent of the old remediate-result "Download HTML" affordance.
   */
  onDownload?(): void;
  /** Open the saved-work screen (the old remediate-result "More" affordance). */
  onOpenSaved?(): void;
}

export interface RemediationPanel {
  element: El;
}

/** A small severity glyph in a fixed-size box (matches the codebase icon idiom). */
function severityIcon(severity: Severity): El {
  const glyph = severity === 'fail' ? '!' : '△';
  return el('span', { class: `remed-sev remed-sev--${severity}`, 'aria-hidden': 'true' }, glyph);
}

/** One severity tally tile (Fail / Warn / Pass). */
function summaryTile(count: number, label: string, tone: 'fail' | 'warn' | 'pass'): El {
  return el(
    'div',
    { class: `remed-tile remed-tile--${tone}` },
    el('span', { class: 'remed-tile__num' }, String(count)),
    el('span', { class: 'remed-tile__label' }, label),
  );
}

/** One issue row in the sidebar list. */
function issueRow(issue: RemediationIssue, active: boolean, deps: RemediationDeps): El {
  const row = el(
    'button',
    {
      type: 'button',
      class: `remed-issue${active ? ' remed-issue--active' : ''}`,
      'aria-pressed': active ? 'true' : 'false',
    },
    severityIcon(issue.severity),
    el(
      'span',
      { class: 'remed-issue__copy' },
      el('span', { class: 'remed-issue__title' }, issue.title),
      el('span', { class: 'remed-issue__meta' }, issue.element),
    ),
  );
  row.addEventListener('click', () => deps.onSelect(issue.id));
  return row;
}

/** A before/after preview tile rendering the heading under test. */
function compareTile(label: string, sample: ContrastSample): El {
  const heading = el('span', { class: 'remed-tile-prev__head' }, 'Welcome to Biology 204');
  heading.setAttribute('style', `color:${sample.headingColor};`);
  return el(
    'div',
    { class: 'remed-cmp' },
    el(
      'div',
      { class: 'remed-cmp__head' },
      el('span', { class: 'remed-cmp__label' }, label),
      el('span', { class: `remed-cmp__ratio remed-cmp__ratio--${sample.level}` }, sample.ratio),
    ),
    el(
      'div',
      { class: 'remed-tile-prev' },
      heading,
      el(
        'span',
        { class: 'remed-tile-prev__body' },
        'Start with the syllabus, then complete the Module 1 reading before Friday.',
      ),
    ),
  );
}

/** Section label with a trailing hairline rule. */
function sectionLabel(text: string): El {
  return el('div', { class: 'remed-seclabel' }, el('span', {}, text), el('div', { class: 'remed-rule' }));
}

/** Real page-level before/after HTML, rendered as escaped text (not innerHTML). */
function htmlEvidence(before: string, after: string, copyBtn: El): El {
  return el(
    'div',
    { class: 'remed-fix' },
    el(
      'div',
      { class: 'remed-fix__head' },
      el('span', { class: 'remed-fix__label' }, 'Before & after · page HTML'),
      copyBtn,
    ),
    el(
      'div',
      { class: 'remed-html' },
      el('span', { class: 'remed-html__label' }, 'Before'),
      el('pre', { class: 'remed-html__pre', 'data-testid': 'remed-html-before' }, before),
      el('span', { class: 'remed-html__label' }, 'After'),
      el('pre', { class: 'remed-html__pre', 'data-testid': 'remed-html-after' }, after),
    ),
  );
}

/** Build the remediation panel from a view model. */
export function createRemediationPanel(view: RemediationView, deps: RemediationDeps): RemediationPanel {
  const d = view.detail;

  // ── Sidebar ────────────────────────────────────────────────────────────────
  const context = el(
    'div',
    { class: 'remed-context' },
    el('span', { class: 'remed-eyebrow' }, 'Reviewing'),
    el('h2', { class: 'remed-context__title' }, view.page.title),
    el('span', { class: 'remed-context__path' }, view.page.path),
  );

  const summary = el(
    'div',
    { class: 'remed-summary' },
    summaryTile(view.summary.fail, 'Fail', 'fail'),
    summaryTile(view.summary.warn, 'Warn', 'warn'),
    summaryTile(view.summary.pass, 'Pass', 'pass'),
  );

  const issues = el(
    'div',
    { class: 'remed-issues' },
    sectionLabel(`Issues · ${view.issues.length}`),
    ...view.issues.map((issue) => issueRow(issue, issue.id === view.selectedId, deps)),
  );

  const sidebar = el('aside', { class: 'remed-sidebar', 'aria-label': 'Issues' }, context, summary, issues);

  // ── Main ─────────────────────────────────────────────────────────────────────
  const copyBtn = el('button', { type: 'button', class: 'remed-fix__copy', 'data-testid': 'remed-copy-fix' }, 'Copy');
  copyBtn.addEventListener('click', () => deps.onCopyFix());

  const header = el(
    'div',
    { class: 'remed-header' },
    el(
      'div',
      { class: 'remed-tags' },
      el('span', { class: `remed-tag remed-tag--${d.severity}`, 'data-testid': 'remed-tag' }, d.tag),
      el('span', { class: 'remed-wcag' }, d.wcag),
      el('span', { class: 'remed-spacer' }),
      el('span', { class: 'remed-position' }, d.position),
    ),
    el('h1', { class: 'remed-title', 'data-testid': 'remed-title' }, d.title),
    el('p', { class: 'remed-desc', 'data-testid': 'remed-desc' }, d.description),
  );

  // Before/after evidence: contrast tiles for the demo seed, OR the real
  // page-level before/after HTML when driven by live remediation data.
  const compare =
    d.before && d.after
      ? el(
          'div',
          { class: 'remed-compare' },
          sectionLabel('Before & after'),
          el('div', { class: 'remed-compare__row' }, compareTile('Before', d.before), compareTile('After', d.after)),
        )
      : d.htmlBefore !== undefined && d.htmlAfter !== undefined
        ? htmlEvidence(d.htmlBefore, d.htmlAfter, copyBtn)
        : undefined;

  // Suggested CSS fix exists only in the demo contrast mode; real remediation
  // already bakes the fix into the `after` HTML shown above.
  const fix =
    d.fix && d.selector
      ? el(
          'div',
          { class: 'remed-fix' },
          el(
            'div',
            { class: 'remed-fix__head' },
            el('span', { class: 'remed-fix__label' }, `Suggested fix · ${d.selector}`),
            copyBtn,
          ),
          el(
            'div',
            { class: 'remed-code' },
            el('pre', { class: 'remed-code__line' }, `${d.selector} {`),
            el('pre', { class: 'remed-code__line remed-code__del' }, d.fix.removed),
            el('pre', { class: 'remed-code__line remed-code__add' }, d.fix.added),
            el('pre', { class: 'remed-code__line' }, '}'),
          ),
        )
      : undefined;

  const footerBtns: El[] = [];
  if (deps.onOpenSaved) {
    const moreBtn = el('button', { type: 'button', class: 'remed-btn remed-btn--ghost', 'data-testid': 'remed-open-saved' }, 'More');
    moreBtn.addEventListener('click', () => deps.onOpenSaved!());
    footerBtns.push(moreBtn);
  }
  if (deps.onDownload) {
    const downloadBtn = el('button', { type: 'button', class: 'remed-btn remed-btn--ghost', 'data-testid': 'remed-download-html' }, 'Download HTML');
    downloadBtn.addEventListener('click', () => deps.onDownload!());
    footerBtns.push(downloadBtn);
  }
  const skipBtn = el('button', { type: 'button', class: 'remed-btn remed-btn--ghost' }, 'Skip');
  skipBtn.addEventListener('click', () => deps.onSkip(view.selectedId));
  const applyBtn = el('button', { type: 'button', class: 'remed-btn remed-btn--primary' }, '✓ Apply fix');
  applyBtn.addEventListener('click', () => deps.onApply(view.selectedId));

  const actions = el(
    'div',
    { class: 'remed-actions' },
    el('span', { class: 'remed-actions__note' }, 'Applies to the live Canvas page · fully revertable'),
    el('div', { class: 'remed-actions__btns' }, ...footerBtns, skipBtn, applyBtn),
  );

  const main = el(
    'main',
    { class: 'remed-main' },
    header,
    ...(compare ? [compare] : []),
    ...(fix ? [fix] : []),
    actions,
  );

  const element = el('div', { class: 'remed', 'data-testid': 'remediation-panel' }, sidebar, main);
  return { element };
}
