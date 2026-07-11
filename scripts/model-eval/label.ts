/**
 * Gold labeller for the real-Canvas corpus.
 *
 * WHY THIS EXISTS: axe-core cannot grade the tasks the vision model is for. On
 * 314 real course pages it found ZERO alt/heading/table failures — including a
 * page with `alt="SPEED BUMP.jpg"` and 21 pages whose data tables have no <th>.
 * Machine-derived gold would therefore be an all-pass answer key, and a model
 * that says "pass" to everything would score 100%. That is the exact
 * always-pass collapse we are trying to detect.
 *
 * So gold for alt/heading/table is authored here, by explicit rules that encode
 * WCAG judgment axe does not implement. Contrast is NOT relabelled — the
 * deterministic engine computes real ratios from pixels and is better than any
 * eyeball.
 *
 * Every label carries a `rationale`. The rules are auditable and the output is
 * reviewable item-by-item — that is the point. Where a rule cannot decide, the
 * fixture is EXCLUDED rather than guessed, and the exclusion is counted.
 *
 *   npx tsx scripts/model-eval/label.ts --in .frugal-fable/eval-corpus/real/fixtures.json \
 *                                       --out .frugal-fable/eval-corpus/labeled.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { Fixture, TaskKey } from './types.ts';
import type { PageElement } from './contracts.ts';
import { extractStructures } from './extract.ts';

const arg = (n: string, d = ''): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

const body = (html: string): string => {
  const m = /<div class="wrap">([\s\S]*)<\/div><\/body>/.exec(html);
  return m ? m[1]! : html;
};
const strip = (h: string): string => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export interface Labeled extends Fixture {
  /** Why this gold is what it is — WCAG basis. Auditable. */
  rationale: string;
}
export interface Excluded {
  id: string;
  task: TaskKey;
  why: string;
}

// ─────────────────────────────────────────────────────────────── tables
/** A data table conveys relationships and needs headers. A layout table is
 *  positioning furniture (Moodle forum wrappers, image-beside-text) — asking it
 *  for <th> is the WRONG remediation (the fix is role="presentation"), so those
 *  are excluded from this task rather than mislabelled. */
export function classifyTable(tableHtml: string): 'data' | 'layout' {
  if (/class="[^"]*forumpost/i.test(tableHtml)) return 'layout';
  const rows = tableHtml.match(/<tr[\s>][\s\S]*?<\/tr>/gi) ?? [];
  if (rows.length < 2) return 'layout';
  const cellsPerRow = rows.map((r) => (r.match(/<t[dh][\s>]/gi) ?? []).length);
  const maxCols = Math.max(...cellsPerRow, 0);
  if (maxCols < 2) return 'layout';
  // A grid whose cells are mostly images/links with no textual grid content is
  // almost always a layout scaffold.
  const texts = (tableHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => strip(c));
  const nonEmpty = texts.filter((t) => t.length > 0);
  if (nonEmpty.length < 3) return 'layout';
  return 'data';
}

function labelTable(f: Fixture): { gold: unknown; rationale: string } | { exclude: string } {
  const b = body(f.html);
  const tables = b.match(/<table[\s>][\s\S]*?<\/table>/gi) ?? [];
  const data = tables.filter((t) => classifyTable(t) === 'data');
  if (!data.length) return { exclude: 'no data table on page (layout tables only) — not what this task judges' };

  const missing = data.filter((t) => !/<th[\s>]/i.test(t));
  if (missing.length) {
    return {
      gold: {
        status: 'fail',
        confidence: 0.95,
        findings: [
          {
            issue_id: 'missing_table_headers',
            severity: 'error',
            message: `Data table has no <th> header cells (${missing.length} of ${data.length} tables); header row is marked up with <td>.`,
            fixer: 'fix_table_headers',
          },
        ],
      },
      rationale: `WCAG 1.3.1: ${missing.length} data table(s) on this page use <td> for the header row, so no cell is programmatically a header. axe does NOT flag this.`,
    };
  }
  return {
    gold: { status: 'pass', confidence: 0.9, findings: [] },
    rationale: `WCAG 1.3.1: all ${data.length} data table(s) on this page have <th> header cells.`,
  };
}

// ─────────────────────────────────────────────────────────────── alt text
const FILENAME = /\.(jpe?g|png|gif|bmp|webp|svg|tiff?)\s*$/i;
const REDUNDANT = /^\s*(image|picture|photo|graphic|pic|img)\s+(of|showing|:)/i;
const PLACEHOLDER = /^\s*(image|picture|photo|graphic|untitled|placeholder|inline image|screen ?shot|banner|logo|icon|spacer|divider|blank)\s*\d*\s*$/i;

export function judgeAlt(alt: string | null): { status: 'pass' | 'fail'; issue: string; why: string } {
  if (alt === null) return { status: 'fail', issue: 'missing', why: 'no alt attribute — WCAG 1.1.1' };
  const t = alt.trim();
  if (t === '') return { status: 'pass', issue: '', why: 'alt="" — treated as an intentional decorative marker' };
  if (FILENAME.test(t)) return { status: 'fail', issue: 'generic', why: `alt is a filename ("${t}") — not a text alternative` };
  if (REDUNDANT.test(t)) return { status: 'fail', issue: 'vague', why: `alt begins with redundant boilerplate ("${t}")` };
  if (PLACEHOLDER.test(t)) return { status: 'fail', issue: 'generic', why: `alt is a placeholder word ("${t}")` };
  if (t.length < 6) return { status: 'fail', issue: 'vague', why: `alt is too short to describe the image ("${t}")` };
  return { status: 'pass', issue: '', why: `alt is a specific description ("${t.slice(0, 60)}")` };
}

function labelAlt(f: Fixture): { gold: unknown; rationale: string } | { exclude: string } {
  const b = body(f.html);
  const imgs = b.match(/<img[^>]*>/gi) ?? [];
  if (!imgs.length) return { exclude: 'no <img> on page' };
  const figures = imgs.map((tag, i) => {
    const m = /alt\s*=\s*"([^"]*)"/i.exec(tag);
    const hasAlt = /\salt\s*=/i.test(tag);
    const v = judgeAlt(hasAlt ? (m ? m[1]! : '') : null);
    return {
      figure_index: i + 1,
      status: v.status,
      severity: v.status === 'pass' ? 'info' : 'error',
      decorative: hasAlt && (m?.[1] ?? '') === '',
      issue_type: v.issue,
      _why: v.why,
    };
  });
  const why = figures.map((g) => `#${g.figure_index} ${g.status}: ${g._why}`).join(' · ');
  return {
    gold: { figures: figures.map(({ _why, ...rest }) => rest) },
    rationale: `WCAG 1.1.1 — ${why}`,
  };
}

// ─────────────────────────────────────────────────────────────── headings
/**
 * `element_index` MUST come from the same enumeration the prompt shows the model
 * (extract.ts walks h1-6,p,table,tr,th,td,li,figure,img,a — not headings alone).
 * Numbering headings 1..n here instead would make gold's "element_index: 2" and
 * the prompt's "2." refer to different elements on any page with a paragraph in
 * it, and heading exact-correction would be scoring noise.
 */
function labelHeading(
  f: Fixture,
  elements: PageElement[],
): { gold: unknown; rationale: string } | { exclude: string } {
  const seq = elements
    .filter((e) => /^\/H[1-6]$/.test(e.tag) && e.text)
    .map((e) => ({ idx: e.index, level: Number(e.tag[2]), text: e.text }));
  if (!seq.length) return { exclude: 'no headings on page' };

  const findings: Record<string, unknown>[] = [];
  const reasons: string[] = [];

  // Skipped level: a heading more than one level below its predecessor.
  for (let k = 1; k < seq.length; k += 1) {
    const prev = seq[k - 1]!;
    const cur = seq[k]!;
    if (cur.level > prev.level + 1) {
      findings.push({
        severity: 'error',
        element_index: cur.idx,
        current_tag: `H${cur.level}`,
        visible_text: cur.text.slice(0, 60),
        message: `Heading level skips from H${prev.level} to H${cur.level}.`,
        correct_tag: `H${prev.level + 1}`,
        suggested_fix: `Retag as H${prev.level + 1}`,
      });
      reasons.push(`H${prev.level}→H${cur.level} skip at #${cur.idx}`);
    }
  }
  // A page whose first heading is not H1 has no top-level anchor.
  const first = seq[0]!;
  if (first.level > 2) {
    findings.push({
      severity: 'warning',
      element_index: first.idx,
      current_tag: `H${first.level}`,
      visible_text: first.text.slice(0, 60),
      message: `Page's first heading is H${first.level}; there is no H1/H2 to anchor the outline.`,
      correct_tag: 'H2',
      suggested_fix: 'Retag as H2',
    });
    reasons.push(`first heading is H${first.level}`);
  }

  return findings.length
    ? {
        gold: { status: 'fail', findings },
        rationale: `WCAG 1.3.1 — ${reasons.join('; ')}. axe does NOT flag these.`,
      }
    : {
        gold: { status: 'pass', findings: [] },
        rationale: `WCAG 1.3.1: heading sequence ${seq.map((s) => `H${s.level}`).join('→')} descends without skipping.`,
      };
}

// ─────────────────────────────────────────────────────────────── driver
async function main(): Promise<number> {
  const inFile = arg('in', '.frugal-fable/eval-corpus/real/fixtures.json');
  const outFile = arg('out', '.frugal-fable/eval-corpus/labeled.json');
  const fixtures = JSON.parse(await readFile(inFile, 'utf8')) as Fixture[];

  const labeled: Labeled[] = [];
  const excluded: Excluded[] = [];

  // Heading gold needs the prompt's own element numbering — extract it the same
  // way the eval does, so the two cannot drift apart.
  const headingFixtures = fixtures.filter((f) => f.task === 'heading');
  console.log(`extracting element lists for ${headingFixtures.length} heading fixtures…`);
  const structures = await extractStructures(headingFixtures);

  for (const f of fixtures) {
    if (f.task === 'contrast') {
      // Trust the deterministic engine — do not relabel.
      labeled.push(f as Labeled);
      continue;
    }
    const r =
      f.task === 'table'
        ? labelTable(f)
        : f.task === 'alt'
          ? labelAlt(f)
          : labelHeading(f, structures.get(f.id)?.elements ?? []);
    if ('exclude' in r) excluded.push({ id: f.id, task: f.task, why: r.exclude });
    else labeled.push({ ...f, gold: r.gold, rationale: r.rationale });
  }

  await writeFile(outFile, JSON.stringify(labeled, null, 2));
  await writeFile(outFile.replace(/\.json$/, '.excluded.json'), JSON.stringify(excluded, null, 2));

  const stat = (t: TaskKey) => {
    const rows = labeled.filter((f) => f.task === t);
    const fail = rows.filter((f) => {
      const g = f.gold as Record<string, unknown>;
      if (t === 'alt') return (g.figures as { status: string }[]).some((x) => x.status === 'fail');
      if (t === 'contrast') return (g.issues as unknown[]).length > 0;
      return g.status === 'fail';
    }).length;
    return `${t.padEnd(9)} n=${String(rows.length).padStart(3)}  pass=${String(rows.length - fail).padStart(3)}  fail=${String(fail).padStart(3)}`;
  };
  for (const t of ['alt', 'contrast', 'heading', 'table'] as TaskKey[]) console.log(stat(t));
  console.log(`\nexcluded: ${excluded.length}`);
  const byWhy = new Map<string, number>();
  for (const e of excluded) byWhy.set(e.why, (byWhy.get(e.why) ?? 0) + 1);
  for (const [w, n] of byWhy) console.log(`  ${n}× ${w}`);
  console.log(`\nwrote ${outFile}`);
  return 0;
}

if (process.argv[1]?.endsWith('label.ts')) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
