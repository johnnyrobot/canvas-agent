/**
 * The expected size of everything this app ships, and the band each one has to
 * land in (#48).
 *
 * The gate used to check bundled payloads with a FLOOR, which can only express
 * "too small". That caught a genuinely modelless docling bundle and blocked the
 * build, so the floor was doing real work — but it is blind in the other
 * direction, and the other direction is where the product constraint lives. The
 * DMG went from 966 MB (0.3.0) to 2.86 GB (0.4.0) with every gate green, because
 * the bundled document models came in at 1.8 GB against a stated ~1.2 GB. The
 * growth was legitimate; the silence was not. Nobody found out from the tooling.
 *
 * Download size is a product constraint here, not a detail. ADR-0009 spends its
 * whole argument on keeping the model set within reach of a 16 GB Mac, and the
 * first-run screen quotes a figure to the instructor before they commit to it.
 * A number that only ever appears in prose cannot hold that line: `~1.2 GB` was
 * written in four places and all four were wrong together.
 *
 * So the figures live HERE, once, each with the build it was measured from —
 * and prose that quotes them carries a `payload:<id>` marker that
 * `release-payload-sizes.test.ts` checks against these constants. A stale figure
 * fails a test instead of reading plausibly.
 *
 * Updating a figure is a deliberate act: change it here, say which build you
 * measured, and the drift test will tell you every other place that now
 * disagrees. That is the whole mechanism — an unexplained change fails, an
 * explained one is a one-line edit.
 */

/** A payload whose shipped size is gated. */
export interface ExpectedPayload {
  /** How the gate names this row. */
  readonly label: string;
  /** Measured size in MB (1 MB = 1048576 bytes, matching the gate's arithmetic). */
  readonly expectedMb: number;
  /**
   * Allowed deviation either side, as a fraction. Below the band means partial
   * or missing; above means something grew and nobody said so. Both fail.
   */
  readonly tolerance: number;
  /** Which build this figure was measured from — so a stale number is traceable. */
  readonly measuredAt: string;
  /** What the operator should do when the check fails. */
  readonly remedy: string;
}

export const EXPECTED_PAYLOADS = {
  doclingModels: {
    label: 'docling models bundled: sidecars/docling-serve/models',
    // The figure that was wrong for two releases. `download_models` fetches
    // several models in sequence, so an interrupted fetch leaves a populated
    // but incomplete dir; the classic pipeline plus Granite-Docling MLX is the
    // complete set, and it is 1.8 GB, not the ~1.2 GB long stated.
    expectedMb: 1852,
    tolerance: 0.1,
    measuredAt: '0.5.0 (2026-08-14), `pre-release --strict`',
    remedy: 're-stage with `DOCLING_BUNDLE_MODELS=1 bash scripts/build-docling-bundle.sh` then `npm run stage:sidecars`',
  },
  catalogSeed: {
    label: 'catalog seed present: sidecars/laccd-courses-pp-cli/seed/data.db',
    // A HALF catalog searches fine and silently misses whole colleges — an
    // aborted mirror once produced 461 MB at 4,700 of 9,701 courses. This is the
    // cheap backstop; the real completeness gate is in build-catalog-seed.mjs.
    expectedMb: 937,
    tolerance: 0.1,
    measuredAt: '0.5.0 (2026-08-14), 9,701/9,701 courses',
    remedy: 'rebuild with `CATALOG_CLI_BIN=… node scripts/build-catalog-seed.mjs`',
  },
  dmg: {
    label: 'installer size: release/*.dmg',
    expectedMb: 2726,
    tolerance: 0.1,
    measuredAt: '0.5.0 (2026-08-14), notarized + stapled',
    remedy: 'if the change is intended, update EXPECTED_PAYLOADS.dmg and say which build you measured',
  },
  zip: {
    label: 'update artifact size: release/*-mac.zip',
    expectedMb: 2538,
    tolerance: 0.1,
    measuredAt: '0.5.0 (2026-08-14), notarized + stapled',
    remedy: 'if the change is intended, update EXPECTED_PAYLOADS.zip and say which build you measured',
  },
} as const satisfies Record<string, ExpectedPayload>;

export type PayloadId = keyof typeof EXPECTED_PAYLOADS;

export const PAYLOAD_IDS = Object.keys(EXPECTED_PAYLOADS) as readonly PayloadId[];

/**
 * Render a size the way this project writes it in prose: MB below a gigabyte,
 * GB with one decimal above. The drift test compares quoted figures against
 * this, so it is the single definition of what "1.8 GB" means here.
 */
export function formatPayloadSize(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The inclusive band a payload has to land in. */
export function payloadBand(id: PayloadId): { minMb: number; maxMb: number } {
  const { expectedMb, tolerance } = EXPECTED_PAYLOADS[id];
  return {
    minMb: Math.round(expectedMb * (1 - tolerance)),
    maxMb: Math.round(expectedMb * (1 + tolerance)),
  };
}

/**
 * Check one measured payload against its band.
 *
 * The detail string always names the band, in both directions. A gate that
 * reports only what it measured makes the operator guess whether 1852 MB is
 * good news, which is the position everyone was in before this existed.
 */
export function checkPayloadSize(id: PayloadId, actualMb: number): { ok: boolean; detail: string } {
  const { minMb, maxMb } = payloadBand(id);
  const { remedy } = EXPECTED_PAYLOADS[id];
  const seen = `${Math.round(actualMb)} MB`;
  const band = `expected ${formatPayloadSize(minMb)}–${formatPayloadSize(maxMb)}`;
  if (actualMb < minMb) {
    return { ok: false, detail: `MISSING/PARTIAL (${seen}, ${band}) — ${remedy}` };
  }
  if (actualMb > maxMb) {
    return {
      ok: false,
      detail:
        `GREW UNEXPECTEDLY (${seen}, ${band}) — download size is a shipped constraint; ` +
        `find out what got bigger, then ${remedy}`,
    };
  }
  return { ok: true, detail: `present (${seen}, ${band})` };
}
