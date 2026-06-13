/**
 * Dev-only demo: runs the render-and-scan engine over a gallery of Canvas-style
 * fragments that exercise the "beat WAVE" contrast cases (gradients, translucent
 * overlays, background images) plus controls. For each fixture it separates the
 * open-source baseline (axe-core, which WAVE mirrors) from this engine's added
 * adjudication, to show where we turn a "needs review" punt into a hard verdict.
 *
 *   npx tsx scripts/contrast-demo.ts
 */
import { createAuditor, createPlaywrightRunner } from '../src/engine/render/index.js';
import type { AuditIssue } from '../src/contracts/index.js';

// Solid-black SVG background image. SVG attribute quotes are %22-encoded so the
// url() can be single-quoted inside a double-quoted style attribute (no collision).
const BLACK_SVG =
  "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3Crect width=%22100%25%22 height=%22100%25%22 fill=%22%23000000%22/%3E%3C/svg%3E')";

const FIXTURES: { name: string; wave: string; html: string }[] = [
  {
    name: 'Gradient banner — light text fades into the light end of a gradient',
    wave: 'SKIPS (WAVE: "does not identify contrast issues in text with ... gradients")',
    html: `<div style="background:linear-gradient(90deg,#1a73e8,#e8f0fe);color:#cfe0fb;padding:24px;font-size:20px;font-weight:bold">Module 3 — Photosynthesis</div>`,
  },
  {
    name: 'Translucent callout — tinted semi-transparent box over white',
    wave: 'SKIPS (WAVE: "does not identify contrast issues in text with CSS transparency")',
    html: `<div style="background:#ffffff;padding:8px"><div style="background:rgba(26,115,232,0.12);color:#b9d0f5;padding:16px">Reminder: lab report due Friday at 5pm.</div></div>`,
  },
  {
    name: 'Hero image — text over a background image',
    wave: 'SKIPS (WAVE only checks the CSS fallback background-color, not the image)',
    html: `<div style="background-image:${BLACK_SVG};background-size:cover;color:#333333;padding:40px;font-size:18px">Welcome to BIO 201</div>`,
  },
  {
    name: 'CONTROL — solid-color low contrast (baseline already catches this)',
    wave: 'CATCHES (plain fg/bg pair — parity, not a differentiator)',
    html: `<p style="color:#999999;background:#ffffff">This faint paragraph fails on a plain white background.</p>`,
  },
  {
    name: 'CONTROL — accessible page (good text + a high-contrast gradient)',
    wave: 'n/a (passes)',
    html: `<div style="background:linear-gradient(90deg,#0b3d91,#08306b);color:#ffffff;padding:24px;font-weight:bold">Syllabus</div><p style="color:#1a1a1a;background:#ffffff">Readable body text with sufficient contrast.</p>`,
  },
];

/** axe's own color-contrast result is phrased "Ensure the contrast ..."; ours isn't. */
const isAxe = (i: AuditIssue): boolean => i.message.startsWith('Ensure the contrast');

function baselineVerdict(axe: AuditIssue[]): string {
  if (axe.length === 0) return '—  (no contrast result)';
  if (axe.some((i) => i.severity === 'error' || i.severity === 'blocker')) return 'flags it as a violation';
  return 'PUNTS → "needs manual review" (cannot resolve the background)';
}

async function main(): Promise<void> {
  const audit = createAuditor(createPlaywrightRunner({ settleDelayMs: 50 }));
  console.log('\n=== Contrast adjudication demo — Canvas-style fixtures ===');
  console.log('(baseline = axe-core, the open-source engine; WAVE behaves the same or skips entirely)\n');
  for (const f of FIXTURES) {
    const { issues } = await audit(f.html);
    const contrast = issues.filter((i) => i.category === 'contrast');
    const axe = contrast.filter(isAxe);
    const ours = contrast.filter((i) => !isAxe(i));

    console.log(`• ${f.name}`);
    console.log(`    WAVE:     ${f.wave}`);
    console.log(`    axe-core: ${baselineVerdict(axe)}`);
    if (ours.length === 0) {
      console.log(`    → OUR ENGINE: cleared — definitively passes (no false positive)`);
    } else {
      for (const i of ours) console.log(`    → OUR ENGINE: [${i.severity.toUpperCase()}] ${i.message}`);
    }
    console.log('');
  }
}

void main();
