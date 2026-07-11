/**
 * The Canvas-domain gold corpus.
 *
 * Every fixture is a standalone Canvas-styled course page with ONE deliberate
 * accessibility property, and a gold answer in the task's output schema. The
 * `rationale` field names the WCAG basis — the gold is auditable, not asserted.
 *
 * Deliberately includes near-threshold contrast cases (ratios inside [4.2, 4.8]),
 * because that band is where a real contrast adjudicator earns its keep and it
 * is the only way `nearThresholdStatusAccuracy` is non-null.
 *
 * This is a seed corpus sized to answer "does this model belong in the product",
 * not a training set. Grow it from real Canvas exports before promoting anything.
 */
import type { Fixture } from './types.ts';

/** Canvas-ish page chrome, so screenshots look like the real render target. */
const page = (body: string, extraCss = ''): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Course page</title>
<style>
  body { margin:0; font-family: "Lato", "Helvetica Neue", Arial, sans-serif; color:#2d3b45; background:#fff; }
  .crumbs { padding:10px 24px; font-size:13px; color:#586874; border-bottom:1px solid #c7cdd1; }
  .wrap { max-width: 900px; padding: 24px; }
  h1 { font-size: 28px; margin: 0 0 16px; }
  h2 { font-size: 23px; margin: 24px 0 8px; }
  h3 { font-size: 20px; margin: 20px 0 8px; }
  h4 { font-size: 17px; margin: 16px 0 8px; }
  p, li, td, th { font-size: 16px; line-height: 1.5; }
  table { border-collapse: collapse; margin: 16px 0; }
  th, td { border:1px solid #c7cdd1; padding:8px 12px; text-align:left; }
  th { background:#f5f5f5; }
  ${extraCss}
</style></head>
<body><nav class="crumbs">BIO 101 &rsaquo; Pages &rsaquo; Course page</nav><div class="wrap">
${body}
</div></body></html>`;

/** Inline SVG data URI — keeps the corpus offline (CSP-safe, no network). */
const CHART = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><rect width="360" height="220" fill="#fff"/>` +
    `<rect x="40" y="120" width="50" height="70" fill="#0f6cbf"/><rect x="110" y="90" width="50" height="100" fill="#0f6cbf"/>` +
    `<rect x="180" y="60" width="50" height="130" fill="#0f6cbf"/><rect x="250" y="30" width="50" height="160" fill="#0f6cbf"/>` +
    `<line x1="30" y1="190" x2="330" y2="190" stroke="#2d3b45" stroke-width="2"/>` +
    `<text x="40" y="210" font-size="13" fill="#2d3b45">Q1</text><text x="110" y="210" font-size="13" fill="#2d3b45">Q2</text>` +
    `<text x="180" y="210" font-size="13" fill="#2d3b45">Q3</text><text x="250" y="210" font-size="13" fill="#2d3b45">Q4</text>` +
    `<text x="40" y="20" font-size="14" fill="#2d3b45">Enrollment by quarter</text></svg>`,
)}`;

const DIVIDER = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="12"><rect width="600" height="3" y="4" fill="#c7cdd1"/></svg>`,
)}`;

const fig = (
  i: number,
  status: 'pass' | 'fail',
  issue: string,
  decorative = false,
): Record<string, unknown> => ({
  figure_index: i,
  status,
  severity: status === 'pass' ? 'info' : 'error',
  decorative,
  issue_type: issue,
});

export const FIXTURES: Fixture[] = [
  // ---------------------------------------------------------------- alt text
  {
    id: 'alt-pass-descriptive',
    task: 'alt',
    rationale: 'WCAG 1.1.1: alt text is specific, accurate, and concise.',
    html: page(
      `<h1>Enrollment trends</h1><img src="${CHART}" alt="Bar chart of BIO 101 enrollment rising each quarter, from about 70 students in Q1 to 160 in Q4." width="360" height="220"><p>Enrollment grew steadily.</p>`,
    ),
    gold: { figures: [fig(1, 'pass', '')] },
  },
  {
    id: 'alt-fail-filename',
    task: 'alt',
    rationale: 'WCAG 1.1.1: a filename is not a text alternative.',
    html: page(
      `<h1>Enrollment trends</h1><img src="${CHART}" alt="chart_final_v2.png" width="360" height="220"><p>Enrollment grew steadily.</p>`,
    ),
    gold: { figures: [fig(1, 'fail', 'generic')] },
  },
  {
    id: 'alt-fail-missing',
    task: 'alt',
    rationale: 'WCAG 1.1.1: informative image with no alt attribute at all.',
    html: page(
      `<h1>Enrollment trends</h1><img src="${CHART}" width="360" height="220"><p>Enrollment grew steadily.</p>`,
    ),
    gold: { figures: [fig(1, 'fail', 'missing')] },
  },
  {
    id: 'alt-fail-redundant',
    task: 'alt',
    rationale: 'WCAG 1.1.1: "image of a picture of" is redundant boilerplate, not a description.',
    html: page(
      `<h1>Enrollment trends</h1><img src="${CHART}" alt="image of a picture of a chart" width="360" height="220"><p>Enrollment grew steadily.</p>`,
    ),
    gold: { figures: [fig(1, 'fail', 'vague')] },
  },
  {
    id: 'alt-pass-decorative',
    task: 'alt',
    rationale: 'WCAG 1.1.1: decorative divider correctly hidden with alt="" + role=presentation.',
    html: page(
      `<h1>Syllabus</h1><img src="${DIVIDER}" alt="" role="presentation" width="600" height="12"><p>Welcome to the course.</p>`,
    ),
    gold: { figures: [fig(1, 'pass', '', true)] },
  },

  // ---------------------------------------------------------------- contrast
  {
    id: 'contrast-pass-body',
    task: 'contrast',
    rationale: '#595959 on #ffffff = 7.0:1, above the 4.5:1 normal-text threshold.',
    html: page(`<h1>Syllabus</h1><p class="b">Readings are posted each Monday.</p>`, `.b { color:#595959; }`),
    gold: { issues: [] },
  },
  {
    id: 'contrast-fail-body',
    task: 'contrast',
    rationale: '#999999 on #ffffff = 2.85:1, well below the 4.5:1 normal-text threshold.',
    html: page(`<h1>Syllabus</h1><p class="b">Readings are posted each Monday.</p>`, `.b { color:#999999; }`),
    gold: {
      issues: [
        { severity: 'error', description: 'Body text contrast ratio is 2.85:1, below WCAG AA 4.5:1.', ratio: 2.85, text_rgb: [153, 153, 153], bg_rgb: [255, 255, 255] },
      ],
    },
  },
  {
    id: 'contrast-fail-near-threshold',
    task: 'contrast',
    rationale: 'NEAR-THRESHOLD: #7a7a7a on #ffffff = 4.37:1 — just under 4.5:1, so it fails. The band where an adjudicator earns its keep.',
    html: page(`<h1>Syllabus</h1><p class="b">Readings are posted each Monday.</p>`, `.b { color:#7a7a7a; }`),
    gold: {
      issues: [
        { severity: 'error', description: 'Body text contrast ratio is 4.37:1, below WCAG AA 4.5:1.', ratio: 4.37, text_rgb: [122, 122, 122], bg_rgb: [255, 255, 255] },
      ],
    },
  },
  {
    id: 'contrast-pass-near-threshold',
    task: 'contrast',
    rationale: 'NEAR-THRESHOLD: #767676 on #ffffff = 4.54:1 — the smallest passing grey. Must NOT be flagged.',
    html: page(`<h1>Syllabus</h1><p class="b">Readings are posted each Monday.</p>`, `.b { color:#767676; }`),
    gold: { issues: [] },
  },
  {
    id: 'contrast-pass-large-text',
    task: 'contrast',
    rationale: '#8f8f8f on white = 3.2:1 — fails normal text but PASSES at 28px (large-text threshold is 3.0:1).',
    html: page(`<h1>Syllabus</h1><p class="b">Office hours moved to Friday.</p>`, `.b { color:#8f8f8f; font-size:28px; }`),
    gold: { issues: [] },
  },

  // ---------------------------------------------------------------- headings
  {
    id: 'heading-pass-hierarchy',
    task: 'heading',
    rationale: 'WCAG 1.3.1: H1 → H2 → H3 descends without skipping.',
    html: page(`<h1>Syllabus</h1><h2>Week 1</h2><p>Intro.</p><h3>Readings</h3><p>Chapter 1.</p>`),
    gold: { status: 'pass', findings: [] },
  },
  {
    id: 'heading-fail-skip',
    task: 'heading',
    rationale: 'WCAG 1.3.1: H1 jumps straight to H4, skipping H2/H3. The H4 should be H2.',
    html: page(`<h1>Syllabus</h1><h4>Week 1</h4><p>Intro.</p>`),
    gold: {
      status: 'fail',
      findings: [
        { severity: 'error', element_index: 2, current_tag: 'H4', visible_text: 'Week 1', message: 'Heading level skips from H1 to H4.', correct_tag: 'H2', suggested_fix: 'Retag as H2' },
      ],
    },
  },
  {
    id: 'heading-fail-title-as-p',
    task: 'heading',
    rationale: 'WCAG 1.3.1: the visually dominant page title is a styled <p>, not a heading. Should be H1.',
    html: page(
      `<p class="t">Course Syllabus</p><h2>Week 1</h2><p>Intro.</p>`,
      `.t { font-size:30px; font-weight:700; margin:0 0 16px; }`,
    ),
    gold: {
      status: 'fail',
      findings: [
        { severity: 'error', element_index: 1, current_tag: 'P', visible_text: 'Course Syllabus', message: 'Page title is styled text, not a heading.', correct_tag: 'H1', suggested_fix: 'Retag as H1' },
      ],
    },
  },
  {
    id: 'heading-fail-body-as-heading',
    task: 'heading',
    rationale: 'WCAG 1.3.1: an ordinary body sentence is marked H3, inflating the outline.',
    html: page(
      `<h1>Syllabus</h1><h2>Week 1</h2><h3>Please remember to bring your lab notebook to every session.</h3><p>Intro.</p>`,
    ),
    gold: {
      status: 'fail',
      findings: [
        { severity: 'error', element_index: 3, current_tag: 'H3', visible_text: 'Please remember to bring your lab notebook to every session.', message: 'Body sentence is tagged as a heading.', correct_tag: 'P', suggested_fix: 'Retag as P' },
      ],
    },
  },

  // ------------------------------------------------------------------ tables
  {
    id: 'table-pass-headers',
    task: 'table',
    rationale: 'WCAG 1.3.1: column headers are TH with scope=col.',
    html: page(
      `<h1>Grades</h1><table><thead><tr><th scope="col">Student</th><th scope="col">Grade</th></tr></thead>` +
        `<tbody><tr><td>Ann</td><td>A</td></tr><tr><td>Ben</td><td>B</td></tr></tbody></table>`,
    ),
    gold: { status: 'pass', confidence: 0.9, findings: [] },
  },
  {
    id: 'table-fail-no-headers',
    task: 'table',
    rationale: 'WCAG 1.3.1: the header row is TD, so no cell is programmatically a header.',
    html: page(
      `<h1>Grades</h1><table><tr><td><strong>Student</strong></td><td><strong>Grade</strong></td></tr>` +
        `<tr><td>Ann</td><td>A</td></tr><tr><td>Ben</td><td>B</td></tr></table>`,
    ),
    gold: {
      status: 'fail',
      confidence: 0.9,
      findings: [
        { issue_id: 'missing_table_headers', severity: 'error', message: 'Header row uses TD cells; no TH header cells exist.', fixer: 'fix_table_headers' },
      ],
    },
  },
  {
    id: 'table-fail-row-headers-as-td',
    task: 'table',
    rationale: 'WCAG 1.3.1: column headers exist, but the row-header column (Week) is TD — row associations are lost.',
    html: page(
      `<h1>Schedule</h1><table><thead><tr><th scope="col">Week</th><th scope="col">Topic</th></tr></thead>` +
        `<tbody><tr><td>Week 1</td><td>Cells</td></tr><tr><td>Week 2</td><td>Genetics</td></tr></tbody></table>`,
    ),
    gold: {
      status: 'fail',
      confidence: 0.8,
      findings: [
        { issue_id: 'missing_row_headers', severity: 'warning', message: 'Row header cells use TD instead of TH scope="row".', fixer: 'fix_table_headers' },
      ],
    },
  },
  {
    id: 'table-pass-row-and-col-headers',
    task: 'table',
    rationale: 'WCAG 1.3.1: both column and row headers are TH with correct scope.',
    html: page(
      `<h1>Schedule</h1><table><thead><tr><th scope="col">Week</th><th scope="col">Topic</th></tr></thead>` +
        `<tbody><tr><th scope="row">Week 1</th><td>Cells</td></tr><tr><th scope="row">Week 2</th><td>Genetics</td></tr></tbody></table>`,
    ),
    gold: { status: 'pass', confidence: 0.9, findings: [] },
  },
];

export const fixturesFor = (task: string): Fixture[] =>
  task === 'all' ? FIXTURES : FIXTURES.filter((f) => f.task === task);
