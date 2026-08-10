/**
 * The alt-SUGGESTION corpus — a deliberately minimal one.
 *
 * This is the reduced gate agreed when the release date moved to "now": the
 * full corpus of ticket #42 is 20–30 human-sourced images with reference alt and
 * an adjudicated adequacy judgement, and it does not fit the date. What fits is
 * the DETERMINISTIC FLOOR — the failures that make a text alternative actively
 * harmful rather than merely mediocre — over a corpus small enough to build in
 * an afternoon.
 *
 * What this gate can therefore say: "this model does not produce catastrophic
 * alt text on these ten images." What it CANNOT say, and must not be quoted as
 * saying: that this model is better than another, or that its alt text is good.
 * That is still #42/#43.
 *
 * TWO LIMITS, recorded here so the verdict cannot overstate itself:
 *
 *   1. Every image is RENDERED, not photographed. Crisp vector text is a much
 *      easier read than a phone photo of a syllabus, so passing `scanned-*` here
 *      is necessary and NOT sufficient evidence that the model can read a real
 *      scan. The real corpus must include actual scans.
 *   2. Ten images cannot distinguish "reliable" from "lucky". A failure here is
 *      strong evidence; a pass is weak evidence.
 *
 * `mustMention` is the teeth of the text-in-image category. Those strings are
 * rendered in the image and nowhere in the prompt, so a model that reproduces
 * them has demonstrably read the pixels — and one that invents a plausible
 * description without them has produced exactly the confident fiction that is
 * worse for a screen-reader user than no suggestion at all.
 */

export type AltCategory =
  | 'chart'
  | 'diagram'
  | 'text-in-image'
  | 'screenshot'
  | 'equation'
  | 'table-as-image'
  | 'map'
  | 'illustration'
  | 'decorative';

export interface AltFixture {
  id: string;
  category: AltCategory;
  /** A standalone HTML document rendered to the PNG the model is shown. */
  html: string;
  /** Surrounding page text — correct alt depends on context, so the model gets it. */
  context: string;
  /** A human-written adequate alternative. Not string-matched; it anchors review. */
  referenceAlt: string;
  /**
   * Strings rendered INSIDE the image that an adequate alt must reproduce.
   * Only meaningful for `text-in-image`, where failing to read is the
   * disqualifying failure rather than a quality complaint.
   */
  mustMention?: string[];
  /** Why this fixture's gold is what it is. */
  rationale: string;
}

/** A standalone image document at a fixed size — this renders to the PNG itself. */
const img = (w: number, h: number, body: string, css = ''): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>img</title><style>
  html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;}
  body{font-family:"Helvetica Neue",Arial,sans-serif;color:#2d3b45;background:#fff;}
  ${css}
</style></head><body>${body}</body></html>`;

export const ALT_FIXTURES: AltFixture[] = [
  {
    id: 'chart-enrollment',
    category: 'chart',
    context: 'Enrollment trends — this page discusses growth across the academic year.',
    referenceAlt: 'Bar chart of enrollment by quarter: four bars, Q1 through Q4, each taller than the last.',
    rationale:
      'WCAG 1.1.1: the chart has labelled quarters but no numeric axis, so an adequate alt names the trend and the categories and asserts NO figures — quoting numbers here would be unverifiable from the image.',
    html: img(
      480,
      300,
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300">
        <rect width="480" height="300" fill="#fff"/>
        <text x="24" y="34" font-size="18" font-weight="bold" fill="#2d3b45">Enrollment by quarter</text>
        <rect x="60" y="170" width="60" height="80" fill="#0f6cbf"/>
        <rect x="150" y="130" width="60" height="120" fill="#0f6cbf"/>
        <rect x="240" y="95" width="60" height="155" fill="#0f6cbf"/>
        <rect x="330" y="60" width="60" height="190" fill="#0f6cbf"/>
        <line x1="45" y1="250" x2="440" y2="250" stroke="#2d3b45" stroke-width="2"/>
        <text x="78" y="272" font-size="15">Q1</text><text x="168" y="272" font-size="15">Q2</text>
        <text x="258" y="272" font-size="15">Q3</text><text x="348" y="272" font-size="15">Q4</text>
      </svg>`,
    ),
  },
  {
    id: 'scanned-syllabus',
    category: 'text-in-image',
    context: 'Course syllabus — the instructor uploaded a scan of the printed handout.',
    referenceAlt:
      'Scanned syllabus page: BIO 101, office hours Tuesday 2:00–4:00 in Room 214, midterm on October 14.',
    mustMention: ['BIO 101', 'Room 214', 'October 14'],
    rationale:
      'WCAG 1.1.1 and the highest-stakes case in this domain: the image IS the content. An alt that describes it as "a scanned document" without the details leaves a screen-reader user with nothing, and one that invents different details is worse than silence.',
    html: img(
      640,
      420,
      `<div style="padding:36px 44px;border:1px solid #ddd;height:100%;box-sizing:border-box;background:#fbfbf8;">
        <div style="text-align:center;font-size:21px;font-weight:bold;letter-spacing:.5px;">BIO 101 — Introductory Biology</div>
        <div style="text-align:center;font-size:15px;margin-top:4px;color:#444;">Fall Semester — Course Syllabus</div>
        <hr style="margin:20px 0;border:none;border-top:1px solid #bbb;">
        <p style="font-size:16px;line-height:1.7;margin:0 0 10px;"><b>Instructor:</b> Dr. Alvarez</p>
        <p style="font-size:16px;line-height:1.7;margin:0 0 10px;"><b>Office hours:</b> Tuesday 2:00&ndash;4:00, Room 214</p>
        <p style="font-size:16px;line-height:1.7;margin:0 0 10px;"><b>Midterm exam:</b> October 14</p>
        <p style="font-size:16px;line-height:1.7;margin:0;"><b>Required text:</b> Campbell, <i>Biology</i>, 12th edition</p>
      </div>`,
    ),
  },
  {
    id: 'slide-objectives',
    category: 'text-in-image',
    context: 'Week 3 lecture — the slide deck was exported as images.',
    referenceAlt:
      'Lecture slide titled Learning Objectives, listing: describe the cell cycle, identify mitosis phases, and explain checkpoints.',
    mustMention: ['Learning Objectives', 'mitosis'],
    rationale:
      'WCAG 1.1.1: slide exports are text-as-image. The bullets are the payload; an alt naming only "a lecture slide" discards the entire content.',
    html: img(
      640,
      380,
      `<div style="height:100%;box-sizing:border-box;padding:40px 48px;background:#12354f;color:#fff;">
        <div style="font-size:30px;font-weight:bold;margin-bottom:26px;">Learning Objectives</div>
        <ul style="font-size:19px;line-height:1.9;padding-left:26px;margin:0;">
          <li>Describe the stages of the cell cycle</li>
          <li>Identify the phases of mitosis</li>
          <li>Explain what checkpoints control</li>
        </ul>
      </div>`,
    ),
  },
  {
    id: 'diagram-process',
    category: 'diagram',
    context: 'How to submit an assignment — the steps are shown as a flow diagram.',
    referenceAlt: 'Flow diagram: Draft, then Peer review, then Revise, then Submit.',
    rationale:
      'WCAG 1.1.1: a process diagram’s meaning is the ORDER of its steps, so an adequate alt states the sequence rather than calling it "a diagram".',
    html: img(
      680,
      180,
      `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="180">
        <rect width="680" height="180" fill="#fff"/>
        ${['Draft', 'Peer review', 'Revise', 'Submit']
          .map(
            (label, i) =>
              `<rect x="${20 + i * 165}" y="60" width="130" height="60" rx="8" fill="#e8f2fb" stroke="#0f6cbf" stroke-width="2"/>` +
              `<text x="${85 + i * 165}" y="96" font-size="15" text-anchor="middle" fill="#12354f">${label}</text>` +
              (i < 3
                ? `<line x1="${150 + i * 165}" y1="90" x2="${183 + i * 165}" y2="90" stroke="#0f6cbf" stroke-width="2"/>` +
                  `<polygon points="${183 + i * 165},84 ${185 + i * 165},90 ${183 + i * 165},96" fill="#0f6cbf"/>`
                : ''),
          )
          .join('')}
      </svg>`,
    ),
  },
  {
    id: 'screenshot-gradebook',
    category: 'screenshot',
    context: 'Where to find your marks — this page walks through the course navigation menu.',
    referenceAlt: 'Canvas gradebook screenshot with the Grades item highlighted in the course navigation menu.',
    mustMention: ['Grades'],
    rationale:
      'WCAG 1.1.1: a UI screenshot in instructions must name the control being pointed at, or the instruction is unusable without sight.',
    html: img(
      620,
      340,
      `<div style="height:100%;display:flex;box-sizing:border-box;border:1px solid #c7cdd1;">
        <div style="width:170px;background:#394b58;color:#fff;padding:16px 0;font-size:15px;">
          ${['Home', 'Announcements', 'Assignments', 'Grades', 'People']
            .map(
              (t) =>
                `<div style="padding:9px 18px;${t === 'Grades' ? 'background:#f0b429;color:#12354f;font-weight:bold;' : ''}">${t}</div>`,
            )
            .join('')}
        </div>
        <div style="flex:1;padding:20px;">
          <div style="font-size:20px;font-weight:bold;margin-bottom:14px;">Course Home</div>
          <div style="height:12px;background:#eceff1;margin-bottom:9px;"></div>
          <div style="height:12px;background:#eceff1;width:78%;margin-bottom:9px;"></div>
          <div style="height:12px;background:#eceff1;width:60%;"></div>
        </div>
      </div>`,
    ),
  },
  {
    id: 'table-as-image',
    category: 'table-as-image',
    context: 'Lab schedule — pasted from a spreadsheet as a picture.',
    referenceAlt:
      'Lab schedule table: Week 1 Microscopy, Week 2 Cell staining, Week 3 Enzyme assay. Full schedule follows in text below.',
    mustMention: ['Microscopy'],
    rationale:
      'WCAG 1.1.1: a data table shipped as a picture loses its structure entirely. The alt cannot recreate a table, so an adequate one summarises and points to the real data — which is why the page context matters.',
    html: img(
      560,
      240,
      `<div style="padding:26px;">
        <div style="font-size:18px;font-weight:bold;margin-bottom:14px;">Lab schedule</div>
        <table style="border-collapse:collapse;font-size:16px;">
          <tr style="background:#f0f0f0;"><th style="border:1px solid #999;padding:9px 20px;text-align:left;">Week</th><th style="border:1px solid #999;padding:9px 20px;text-align:left;">Topic</th></tr>
          <tr><td style="border:1px solid #999;padding:9px 20px;">1</td><td style="border:1px solid #999;padding:9px 20px;">Microscopy</td></tr>
          <tr><td style="border:1px solid #999;padding:9px 20px;">2</td><td style="border:1px solid #999;padding:9px 20px;">Cell staining</td></tr>
          <tr><td style="border:1px solid #999;padding:9px 20px;">3</td><td style="border:1px solid #999;padding:9px 20px;">Enzyme assay</td></tr>
        </table>
      </div>`,
    ),
  },
  {
    id: 'equation-quadratic',
    category: 'equation',
    context: 'Solving quadratics — the formula is shown as an image.',
    referenceAlt: 'The quadratic formula: x equals negative b plus or minus the square root of b squared minus four a c, all over two a.',
    rationale:
      'WCAG 1.1.1: an equation image must be spoken as an equation. "A mathematical formula" conveys nothing a student could use.',
    html: img(
      520,
      170,
      `<div style="height:100%;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;font-size:38px;">
        <span>x =</span>
        <span style="display:inline-block;text-align:center;margin-left:14px;">
          <span style="display:block;border-bottom:2px solid #2d3b45;padding:0 14px 6px;">&minus;b &plusmn; &radic;(b&sup2; &minus; 4ac)</span>
          <span style="display:block;padding-top:6px;">2a</span>
        </span>
      </div>`,
    ),
  },
  {
    id: 'map-campus',
    category: 'map',
    context: 'Finding the lab — a map of the campus is shown below.',
    referenceAlt: 'Campus map showing the Science Building north of the Library, across the quad from Parking Lot B.',
    mustMention: ['Science'],
    rationale:
      'WCAG 1.1.1: a map’s content is the spatial relationship between named places, so an adequate alt states the relationships rather than the fact that it is a map.',
    html: img(
      560,
      330,
      `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="330">
        <rect width="560" height="330" fill="#eef4ea"/>
        <rect x="60" y="40" width="180" height="90" fill="#c8d9bf" stroke="#5a7a4a" stroke-width="2"/>
        <text x="150" y="90" font-size="16" text-anchor="middle" fill="#2d3b45">Science Building</text>
        <rect x="60" y="200" width="180" height="90" fill="#d9d2c8" stroke="#8a7a66" stroke-width="2"/>
        <text x="150" y="250" font-size="16" text-anchor="middle" fill="#2d3b45">Library</text>
        <rect x="330" y="120" width="170" height="110" fill="#dfe3e6" stroke="#7a8a95" stroke-width="2"/>
        <text x="415" y="180" font-size="16" text-anchor="middle" fill="#2d3b45">Parking Lot B</text>
        <text x="285" y="180" font-size="13" text-anchor="middle" fill="#5a7a4a">quad</text>
      </svg>`,
    ),
  },
  {
    id: 'illustration-cell',
    category: 'illustration',
    context: 'Cell structure — a labelled illustration of a plant cell.',
    referenceAlt: 'Illustration of a plant cell with the nucleus, chloroplast, and cell wall labelled.',
    mustMention: ['nucleus'],
    rationale:
      'WCAG 1.1.1: a labelled scientific illustration is informative, and its labels are the information. This is the closest stand-in the corpus has for a photograph, and it is NOT one — see the limits at the top of this file.',
    html: img(
      520,
      330,
      `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="330">
        <rect width="520" height="330" fill="#fff"/>
        <rect x="70" y="40" width="290" height="240" rx="14" fill="#e6f3e2" stroke="#3f7a3a" stroke-width="5"/>
        <circle cx="200" cy="150" r="52" fill="#b9d3ea" stroke="#2b5f8e" stroke-width="3"/>
        <text x="200" y="156" font-size="15" text-anchor="middle" fill="#12354f">nucleus</text>
        <ellipse cx="130" cy="235" rx="34" ry="19" fill="#8fc47f" stroke="#3f7a3a" stroke-width="2"/>
        <text x="300" y="238" font-size="14" fill="#2d3b45">chloroplast</text>
        <line x1="164" y1="235" x2="292" y2="234" stroke="#666" stroke-width="1"/>
        <text x="372" y="60" font-size="14" fill="#2d3b45">cell wall</text>
        <line x1="360" y1="56" x2="366" y2="56" stroke="#666" stroke-width="1"/>
      </svg>`,
    ),
  },
  {
    id: 'decorative-divider',
    category: 'decorative',
    context: 'Welcome to the course — a decorative rule separates the header from the body text.',
    referenceAlt: '',
    rationale:
      'WCAG 1.1.1: a purely decorative graphic should carry an EMPTY alt. This fixture exists to catch the opposite failure from all the others — a model that describes everything will narrate a horizontal line, adding noise to a page that was already correct.',
    html: img(
      600,
      60,
      `<div style="height:100%;display:flex;align-items:center;justify-content:center;">
        <svg xmlns="http://www.w3.org/2000/svg" width="520" height="16">
          <line x1="0" y1="8" x2="520" y2="8" stroke="#c7cdd1" stroke-width="3" stroke-dasharray="2 6"/>
        </svg>
      </div>`,
    ),
  },
];
