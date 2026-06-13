/**
 * Pure worst-case background sampling for text-over-image contrast. Given the
 * decoded pixels of a text run's box and the run's foreground color, drop the
 * glyph-ink and anti-aliased-edge pixels (those close to `fg`) and return the
 * single lowest-contrast remaining background pixel as an opaque `rgb(...)` swatch.
 *
 * Known limitation: separation is by color distance, so when the text color is
 * very close to the background color, the background pixels are dropped too and
 * [] is returned — the caller then defers that run to a needs-review alert rather
 * than guessing. (Color-distant but low-luminance-contrast pairs sample fine.)
 */
import { parseColor } from '../contrast.js';
import type { DecodedImage } from './png.js';

function linear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function ratio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export interface SampleOptions {
  /** Manhattan RGB distance to `fg` at/below which a pixel is treated as text/AA-edge. */
  textBand?: number;
}

export function sampleBackground(image: DecodedImage, fg: string, opts: SampleOptions = {}): string[] {
  const textBand = opts.textBand ?? 120;
  const f = parseColor(fg);
  const fgLum = luminance(f.r, f.g, f.b);
  const { width, height, rgba } = image;
  let worst: { r: number; g: number; b: number; ratio: number } | null = null;
  for (let i = 0; i < width * height; i += 1) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const a = rgba[i * 4 + 3]!;
    if (a < 255) continue; // only fully-opaque background pixels
    const dist = Math.abs(f.r - r) + Math.abs(f.g - g) + Math.abs(f.b - b);
    if (dist <= textBand) continue; // glyph ink or its anti-aliased halo
    const rt = ratio(fgLum, luminance(r, g, b));
    if (!worst || rt < worst.ratio) worst = { r, g, b, ratio: rt };
  }
  return worst ? [`rgb(${worst.r}, ${worst.g}, ${worst.b})`] : [];
}
