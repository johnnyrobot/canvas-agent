/**
 * Pure contrast adjudicator: one TextRun → an AuditIssue (or null when it passes).
 * Handles every ResolvedBackground kind, reusing engine-core's WCAG math. No DOM,
 * no browser — fully unit-tested with hand-built TextRun fixtures.
 */
import { checkContrast, parseColor, parseColorAlpha, compositeLayers, parseGradientStops } from '../contrast.js';
import { WCAG } from '../../contracts/index.js';
import type { AuditIssue, Severity, TextSize } from '../../contracts/index.js';
import type { ResolvedBackground, TextRun } from './types.js';

const CONTRAST_ID = 'contrast';

export interface RunContrastOptions {
  /** Severity for deterministic (layers/gradient) failures. */
  failSeverity: Severity;
  /** Severity for raster (image) worst-case estimate failures. */
  imageFailSeverity: Severity;
  /** Interpolated samples added between each adjacent gradient stop pair. */
  gradientSamples: number;
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function fail(severity: Severity, message: string): AuditIssue {
  return { id: CONTRAST_ID, severity, message, category: 'contrast' };
}
function review(message: string): AuditIssue {
  return { id: CONTRAST_ID, severity: 'alert', message, category: 'contrast' };
}
function minFor(size: TextSize): number {
  return size === 'large' ? WCAG.AA_LARGE : WCAG.AA_NORMAL;
}

/** Lowest-ratio background among candidates (each an opaque CSS color), with fg composited over it. */
function worstAgainst(fg: string, candidates: string[], size: TextSize): { ratio: number; bg: string; passes: boolean } {
  let worst = { ratio: Infinity, bg: candidates[0] ?? 'rgb(255, 255, 255)', passes: true };
  for (const bg of candidates) {
    const fgSolid = compositeLayers([fg, bg]); // composite the (possibly translucent) text over this bg
    const res = checkContrast(fgSolid, bg, size);
    if (res.ratio < worst.ratio) worst = { ratio: res.ratio, bg, passes: res.passesAA };
  }
  return worst;
}

/** Parsed stop colors + interpolated samples; null when no stop parses (e.g. conic). */
function gradientCandidates(css: string, samples: number): string[] | null {
  const parsed: { r: number; g: number; b: number }[] = [];
  for (const token of parseGradientStops(css)) {
    try {
      parsed.push(parseColor(token));
    } catch {
      // direction/angle/shape token or unsupported color — skip
    }
  }
  if (parsed.length === 0) return null;
  if (parsed.length === 1) return [rgb(parsed[0]!.r, parsed[0]!.g, parsed[0]!.b)];
  const out: string[] = [];
  for (let i = 0; i < parsed.length - 1; i += 1) {
    const a = parsed[i]!;
    const b = parsed[i + 1]!;
    out.push(rgb(a.r, a.g, a.b));
    for (let s = 1; s <= samples; s += 1) {
      const t = s / (samples + 1);
      out.push(rgb(Math.round(a.r + (b.r - a.r) * t), Math.round(a.g + (b.g - a.g) * t), Math.round(a.b + (b.b - a.b) * t)));
    }
  }
  const last = parsed[parsed.length - 1]!;
  out.push(rgb(last.r, last.g, last.b));
  return out;
}

export function runContrastIssue(run: TextRun, opts: RunContrastOptions): AuditIssue | null {
  // Fully transparent / unparseable text cannot be adjudicated.
  try {
    if (parseColorAlpha(run.fg).a === 0) return review(`Text color ${run.fg} is fully transparent; manual review needed.`);
  } catch {
    return review(`Text color ${run.fg} could not be parsed; manual review needed.`);
  }

  const bg: ResolvedBackground = run.background;
  switch (bg.kind) {
    case 'layers': {
      let solid: string;
      try {
        solid = compositeLayers(bg.layers);
      } catch {
        return review('Background color could not be resolved; manual review needed.');
      }
      const fgSolid = compositeLayers([run.fg, solid]);
      const res = checkContrast(fgSolid, solid, run.size);
      if (res.passesAA) return null;
      return fail(
        opts.failSeverity,
        `Text contrast ${res.ratio}:1 is below the WCAG AA minimum of ${minFor(run.size)}:1 for ${run.size} text (${run.fg} on ${solid}).`,
      );
    }
    case 'gradient': {
      const candidates = gradientCandidates(bg.css, opts.gradientSamples);
      if (!candidates) return review(`Gradient background "${bg.css}" could not be parsed; manual review needed.`);
      const w = worstAgainst(run.fg, candidates, run.size);
      if (w.passes) return null;
      return fail(
        opts.failSeverity,
        `Worst-case text contrast over the gradient is ${w.ratio}:1, below the WCAG AA minimum of ${minFor(run.size)}:1 for ${run.size} text (${run.fg} on ${w.bg}).`,
      );
    }
    case 'image': {
      if (bg.swatches.length === 0) return review('Background-image contrast could not be sampled; manual review needed.');
      const w = worstAgainst(run.fg, bg.swatches, run.size);
      if (w.passes) return null;
      return fail(
        opts.imageFailSeverity,
        `Worst-case text contrast over the background image is ${w.ratio}:1 (estimated from rendered pixels), below the WCAG AA minimum of ${minFor(run.size)}:1 for ${run.size} text (${run.fg} on ${w.bg}).`,
      );
    }
    case 'unresolvable':
    default:
      return review(`Contrast for ${run.fg} could not be computed (${bg.kind === 'unresolvable' ? bg.reason : 'unknown'}); manual review needed.`);
  }
}
