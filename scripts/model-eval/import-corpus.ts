/**
 * Real-corpus importer — turns actual Canvas course content into eval
 * fixtures with MACHINE-DERIVED gold labels, by running the app's own
 * auditor (`src/engine/render`) as ground truth.
 *
 * Three input sources (pick any combination):
 *   --imscc <path>       a Canvas course export (.imscc, a ZIP). Extracts
 *                         wiki page HTML from `wiki_content/*.html` and
 *                         `web_resources/*.html` via the system `unzip`.
 *   --html-dir <dir>     a directory of raw .html files (saved page source).
 *   --pages-json <file>  a JSON array of `{title, body}` (Canvas API pages).
 *
 * Each imported page becomes ONE fixture PER TASK it has content to judge
 * (contrast always applies; alt/heading/table only when the page has an
 * <img>/<h1-6>/<table>). Gold is derived from the real `audit()` output
 * using the frozen rule-id → task mapping in `RULES` below — see
 * `goldForTask` for the per-task gold schema (mirrors `corpus.ts`).
 *
 * Two machine-undecidable dimensions are punted to `needs-label.json`:
 *   - alt TEXT QUALITY (axe only detects missing alt, never bad alt)
 *   - heading `correct_tag` (axe flags the problem, not the fix)
 *
 *   npx tsx scripts/model-eval/import-corpus.ts --imscc course.imscc
 *   npx tsx scripts/model-eval/import-corpus.ts --html-dir ./pages --out .frugal-fable/eval-corpus/real
 *   npx tsx scripts/model-eval/import-corpus.ts --pages-json ./pages.json
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Fixture, TaskKey } from './types.ts';
import type { AuditIssue, Auditor } from '../../src/contracts/index.js';
import { audit as realAudit } from '../../src/engine/render/index.js';

// ---------------------------------------------------------------------------
// Canvas-styled page shell — verbatim copy of corpus.ts's `page()` helper.
// Not exported there, so replicated here rather than inventing new styling.
// ---------------------------------------------------------------------------

/**
 * Wrap a Canvas RCE body fragment in a standalone page.
 *
 * `pageTitle` is rendered as the `<h1>` because that is what Canvas itself does:
 * the page title is chrome, not part of the RCE body, so a well-formed body
 * starts at `<h2>`. Omitting it would show the model a page with no H1 and make
 * "body starts at H3" indistinguishable from "page has no top-level heading" —
 * an artifact of the harness rather than a property of the content.
 */
export const wrapPage = (body: string, extraCss = '', pageTitle = ''): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${pageTitle || 'Course page'}</title>
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
<body><nav class="crumbs">Course &rsaquo; Pages &rsaquo; ${pageTitle || 'Course page'}</nav><div class="wrap">
${pageTitle ? `<h1>${pageTitle}</h1>` : ''}
${body}
</div></body></html>`;

// ---------------------------------------------------------------------------
// Rule-id → task mapping (frozen; do not add rules of your own).
// ---------------------------------------------------------------------------

export const RULES: Record<TaskKey, string[]> = {
  alt: ['image-alt', 'role-img-alt', 'input-image-alt', 'object-alt', 'area-alt'],
  contrast: ['color-contrast', 'color-contrast-enhanced'],
  heading: ['heading-order', 'empty-heading', 'page-has-heading-one'],
  table: ['th-has-data-cells', 'td-has-header', 'td-headers-attr', 'scope-attr-valid', 'empty-table-header', 'table-duplicate-name'],
};

/** Issues in `issues[]` that count toward `task`'s gold, per the frozen mapping.
 *  contrast additionally matches on `category === 'contrast'` (the deterministic
 *  contrast engine's own issues, which don't carry an axe rule id in RULES). */
export function issuesForTask(task: TaskKey, issues: AuditIssue[]): AuditIssue[] {
  const ruleIds = new Set(RULES[task]);
  return issues.filter((i) => ruleIds.has(i.id) || (task === 'contrast' && i.category === 'contrast'));
}

/** Parses a "N.NN:1" (or "N:1") ratio out of an issue message. Returns
 *  `undefined` when no such ratio is present (never NaN, never throws). */
export function parseRatio(message: string): number | undefined {
  const m = message.match(/(\d+(?:\.\d+)?)\s*:\s*1/);
  return m ? Number(m[1]) : undefined;
}

const rationaleFor = (matched: AuditIssue[]): string =>
  matched.length > 0
    ? matched.map((i) => `${i.id}: ${i.message}`).join('; ')
    : "no axe violations in this task's rule set";

/**
 * Pure gold-shaping: given the FULL issue set from a real `audit()` call and
 * (for `alt`) how many <img> elements the page has, derive the gold answer in
 * the exact per-task schema `corpus.ts` uses.
 *
 * KNOWN LIMITATION (alt): axe collapses a rule violation to one issue per
 * RULE, not per node, so when an alt-rule issue is present we cannot tell
 * *which* image(s) triggered it. All images are marked fail/missing in that
 * case; conversely, when no alt-rule issue fired, all images are pass — but
 * every such fixture belongs on the needs-label queue, because "has an alt
 * attribute" is not the same as "has a GOOD alt attribute" (see `main`/
 * `importFixtures`, which builds `needs-label.json` from this signal).
 */
export function goldForTask(
  task: TaskKey,
  issues: AuditIssue[],
  imgCount = 0,
): { gold: unknown; rationale: string } {
  const matched = issuesForTask(task, issues);
  const failed = matched.length > 0;
  const rationale = rationaleFor(matched);

  switch (task) {
    case 'alt': {
      const figures = Array.from({ length: imgCount }, (_, i) => ({
        figure_index: i + 1,
        status: failed ? 'fail' : 'pass',
        severity: failed ? 'error' : 'info',
        decorative: false,
        issue_type: failed ? 'missing' : '',
      }));
      return { gold: { figures }, rationale };
    }
    case 'contrast': {
      const issuesOut = matched.map((i) => {
        const ratio = parseRatio(i.message);
        const entry: Record<string, unknown> = { severity: i.severity, description: i.message };
        if (ratio !== undefined) entry.ratio = ratio;
        return entry;
      });
      return { gold: { issues: issuesOut }, rationale };
    }
    case 'heading': {
      const findings = matched.map((i) => ({ severity: i.severity, message: i.message }));
      return { gold: { status: failed ? 'fail' : 'pass', findings }, rationale };
    }
    case 'table': {
      const findings = matched.map((i) => ({
        issue_id: i.id,
        severity: i.severity,
        message: i.message,
        fixer: 'fix_table_headers',
      }));
      return { gold: { status: failed ? 'fail' : 'pass', confidence: 0.9, findings }, rationale };
    }
  }
}

// ---------------------------------------------------------------------------
// Presence detection (per task spec: simple case-insensitive regex).
// ---------------------------------------------------------------------------

const HAS_TABLE_RE = /<table[\s>]/i;
const HAS_IMG_RE = /<img[\s>]/i;
const HAS_HEADING_RE = /<h[1-6][\s>]/i;

/** Extracts `<img>` tags in document order, with src + current alt (or `null`
 *  when the element has no alt attribute at all — the thing axe's image-alt
 *  rule actually flags). Used for imgCount and for the needs-label queue. */
export function extractImages(html: string): { src: string; alt: string | null }[] {
  const tags = html.match(/<img\b[^>]*>/gi) ?? [];
  return tags.map((tag) => {
    const srcMatch = tag.match(/\bsrc\s*=\s*"([^"]*)"|\bsrc\s*=\s*'([^']*)'/i);
    const altMatch = tag.match(/\balt\s*=\s*"([^"]*)"|\balt\s*=\s*'([^']*)'/i);
    const src = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? '') : '';
    const alt = altMatch ? (altMatch[1] ?? altMatch[2] ?? '') : null;
    return { src, alt };
  });
}

/** Which tasks a page has content for. Contrast always applies (every page
 *  has text). */
export function tasksForPage(html: string): TaskKey[] {
  const tasks: TaskKey[] = ['contrast'];
  if (HAS_IMG_RE.test(html)) tasks.push('alt');
  if (HAS_HEADING_RE.test(html)) tasks.push('heading');
  if (HAS_TABLE_RE.test(html)) tasks.push('table');
  return tasks;
}

// ---------------------------------------------------------------------------
// Source readers.
// ---------------------------------------------------------------------------

export interface ImportedPage {
  title: string;
  /** Wrapped, standalone HTML document (Canvas shell + page body). */
  html: string;
  source: string;
}

/** Strips an outer <html>/<body> wrapper if the extracted content already has
 *  one (real Canvas exports are usually fragments, but some tooling emits a
 *  full minimal document) — otherwise Canvas page bodies are fragments and
 *  pass through untouched. */
function bodyFragment(raw: string): string {
  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return bodyMatch ? bodyMatch[1]! : raw;
}

function titleFromFilename(filePath: string): string {
  return path
    .basename(filePath)
    .replace(/\.html?$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/** Lists entries in a ZIP (imscc) archive via the system `unzip -Z1` (zipinfo
 *  mode: bare names, one per line). No npm dependency. */
function listZipEntries(zipPath: string): string[] {
  const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function readZipEntry(zipPath: string, entry: string): string {
  return execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function readImsccPages(imsccPath: string): ImportedPage[] {
  const entries = listZipEntries(imsccPath).filter(
    (e) => /(^|\/)(wiki_content|web_resources)\//i.test(e) && /\.html?$/i.test(e),
  );
  return entries.map((entry) => {
    const raw = readZipEntry(imsccPath, entry);
    const t = titleFromFilename(entry);
    return { title: t, html: wrapPage(bodyFragment(raw), '', t), source: `${imsccPath}:${entry}` };
  });
}

export async function readHtmlDirPages(dir: string): Promise<ImportedPage[]> {
  const names = (await readdir(dir)).filter((n) => /\.html?$/i.test(n)).sort();
  const pages: ImportedPage[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const raw = await readFile(filePath, 'utf8');
    const t = titleFromFilename(name);
    pages.push({ title: t, html: wrapPage(bodyFragment(raw), '', t), source: filePath });
  }
  return pages;
}

export async function readPagesJson(filePath: string): Promise<ImportedPage[]> {
  const raw = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${filePath}: expected a JSON array of {title, body}`);
  return parsed.map((entry, i) => {
    const { title, body } = entry as { title?: unknown; body?: unknown };
    if (typeof title !== 'string' || typeof body !== 'string') {
      throw new Error(`${filePath}[${i}]: expected {title: string, body: string}`);
    }
    return { title, html: wrapPage(bodyFragment(body)), source: `${filePath}[${i}]` };
  });
}

// ---------------------------------------------------------------------------
// Fixture assembly.
// ---------------------------------------------------------------------------

export interface NeedsLabelEntry {
  fixtureId: string;
  task: TaskKey;
  why: string;
  images?: { src: string; alt: string | null }[];
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'page';
}

/** Makes `base` unique against `seen`, appending -2, -3, … on collision. */
function dedupe(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

export interface ImportOptions {
  imsccPath?: string;
  htmlDir?: string;
  pagesJsonPath?: string;
  /** Injectable auditor — defaults to the real Chromium+axe-core `audit`.
   *  Tests pass a stub to stay fully offline. */
  auditor?: Auditor;
}

export interface ImportResult {
  fixtures: Fixture[];
  needsLabel: NeedsLabelEntry[];
  pagesImported: number;
}

export async function importFixtures(opts: ImportOptions): Promise<ImportResult> {
  const auditor = opts.auditor ?? realAudit;
  const pages: ImportedPage[] = [];

  if (opts.imsccPath) pages.push(...readImsccPages(opts.imsccPath));
  if (opts.htmlDir) pages.push(...(await readHtmlDirPages(opts.htmlDir)));
  if (opts.pagesJsonPath) pages.push(...(await readPagesJson(opts.pagesJsonPath)));

  const fixtures: Fixture[] = [];
  const needsLabel: NeedsLabelEntry[] = [];
  const idSeen = new Map<string, number>();

  for (const pageEntry of pages) {
    const tasks = tasksForPage(pageEntry.html);
    if (tasks.length === 0) continue;

    const { issues } = await auditor(pageEntry.html);
    const images = extractImages(pageEntry.html);
    const pageSlug = slugify(pageEntry.title);

    for (const task of tasks) {
      const { gold, rationale } = goldForTask(task, issues, images.length);
      const id = dedupe(`real-${pageSlug}-${task}`, idSeen);
      fixtures.push({ id, task, html: pageEntry.html, gold, rationale });

      if (task === 'alt') {
        const status = (gold as { figures: { status: string }[] }).figures;
        const allPass = status.every((f) => f.status === 'pass');
        if (allPass) {
          needsLabel.push({
            fixtureId: id,
            task,
            why: 'alt text quality is not machine-decidable (axe only detects MISSING alt)',
            images,
          });
        }
      }
      if (task === 'heading' && (gold as { status: string }).status === 'fail') {
        needsLabel.push({
          fixtureId: id,
          task,
          why: 'correct_tag is not machine-decidable from axe output',
        });
      }
    }
  }

  return { fixtures, needsLabel, pagesImported: pages.length };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<number> {
  const imsccPath = arg('imscc');
  const htmlDir = arg('html-dir');
  const pagesJsonPath = arg('pages-json');
  const outDir = arg('out', '.frugal-fable/eval-corpus/real')!;

  if (!imsccPath && !htmlDir && !pagesJsonPath) {
    console.error('usage: import-corpus.ts (--imscc <path> | --html-dir <dir> | --pages-json <file>) [--out <dir>]');
    return 1;
  }

  const { fixtures, needsLabel, pagesImported } = await importFixtures({
    ...(imsccPath ? { imsccPath } : {}),
    ...(htmlDir ? { htmlDir } : {}),
    ...(pagesJsonPath ? { pagesJsonPath } : {}),
  });

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'fixtures.json'), JSON.stringify(fixtures, null, 2));
  await writeFile(path.join(outDir, 'needs-label.json'), JSON.stringify(needsLabel, null, 2));

  const perTask = new Map<TaskKey, { pass: number; fail: number }>();
  for (const f of fixtures) {
    const status = (f.gold as { status?: string; figures?: { status: string }[]; issues?: unknown[] });
    const failed =
      status.status === 'fail' ||
      (Array.isArray(status.figures) && status.figures.some((x) => x.status === 'fail')) ||
      (Array.isArray(status.issues) && status.issues.length > 0);
    const bucket = perTask.get(f.task) ?? { pass: 0, fail: 0 };
    if (failed) bucket.fail += 1;
    else bucket.pass += 1;
    perTask.set(f.task, bucket);
  }

  console.log(`pages imported: ${pagesImported}`);
  console.log(`fixtures: ${fixtures.length}`);
  for (const [task, { pass, fail }] of perTask) {
    console.log(`  ${task.padEnd(9)} n=${pass + fail}  pass=${pass}  fail=${fail}`);
  }
  console.log(`needs-label: ${needsLabel.length}`);
  console.log(`\nartifacts: ${outDir}/{fixtures.json,needs-label.json}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
