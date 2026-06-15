/**
 * Pure contrast adjudicator: one TextRun → an AuditIssue (or null when it passes).
 * Handles every ResolvedBackground kind, reusing engine-core's WCAG math. No DOM,
 * no browser — fully unit-tested with hand-built TextRun fixtures.
 */
import { checkContrast, parseColorAlpha, compositeLayers, parseGradientStops } from '../contrast.js';
import type { Rgba } from '../contrast.js';
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

/** Lowest-ratio background among candidates (for the message) + an all-must-pass verdict. */
function worstAgainst(fg: string, candidates: string[], size: TextSize): { ratio: number; bg: string; passes: boolean } {
  let minRatio = Infinity;
  let worstBg = candidates[0] ?? 'rgb(255, 255, 255)';
  let passes = true;
  for (const bg of candidates) {
    const fgSolid = compositeLayers([fg, bg]); // composite the (possibly translucent) text over this bg
    const res = checkContrast(fgSolid, bg, size);
    if (!res.passesAA) passes = false; // passes only if every sampled bg passes (no rounding-tie escape)
    if (res.ratio < minRatio) {
      minRatio = res.ratio;
      worstBg = bg;
    }
  }
  return { ratio: minRatio, bg: worstBg, passes };
}

/**
 * Composite a straight-alpha gradient stop over the engine's opaque base (white,
 * matching `compositeLayers`) → an opaque `rgb(...)`. A TRANSLUCENT stop is scored
 * against what actually shows through, not the alpha-dropped opaque color.
 */
function flattenStop(r: number, g: number, b: number, a: number): string {
  const mix = (c: number): number => Math.round(c * a + 255 * (1 - a));
  return rgb(mix(r), mix(g), mix(b));
}

/**
 * Parsed stop colors + interpolated samples, each composited over the opaque base;
 * null when no stop parses (e.g. conic). Parsing now keeps ALPHA (`parseColorAlpha`)
 * and flattens each stop/sample over white — mirroring the layers case — so a
 * `linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0))` no longer collapses to opaque
 * black and pass ~21:1 against light text (the closed fail-OPEN); the transparent
 * end correctly flattens to white and is scored as such.
 */
function gradientCandidates(css: string, samples: number): string[] | null {
  const parsed: Rgba[] = [];
  for (const token of parseGradientStops(css)) {
    try {
      parsed.push(parseColorAlpha(token));
    } catch {
      // direction/angle/shape token or unsupported color — skip
    }
  }
  if (parsed.length === 0) return null;
  if (parsed.length === 1) {
    const s = parsed[0]!;
    return [flattenStop(s.r, s.g, s.b, s.a)];
  }
  const out: string[] = [];
  for (let i = 0; i < parsed.length - 1; i += 1) {
    const a = parsed[i]!;
    const b = parsed[i + 1]!;
    out.push(flattenStop(a.r, a.g, a.b, a.a));
    for (let s = 1; s <= samples; s += 1) {
      const t = s / (samples + 1);
      // Interpolate straight-alpha r/g/b/a between adjacent stops, then composite.
      out.push(
        flattenStop(
          a.r + (b.r - a.r) * t,
          a.g + (b.g - a.g) * t,
          a.b + (b.b - a.b) * t,
          a.a + (b.a - a.a) * t,
        ),
      );
    }
  }
  const last = parsed[parsed.length - 1]!;
  out.push(flattenStop(last.r, last.g, last.b, last.a));
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
