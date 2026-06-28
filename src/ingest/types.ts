/**
 * Types for the local Docling ingestion sidecar.
 *
 * Read-only document conversion (DOCX/PPTX/XLSX/PDF/images → structured content)
 * via a bundled `docling-serve` HTTP sidecar. No cloud, no external API, no
 * tagging/remediation of the source (PRD §16).
 */

/** Docling output formats (subset of docling-serve `to_formats`). */
export type ExportFormat = 'md' | 'json' | 'html' | 'text' | 'doctags';

/**
 * Which docling-serve processing pipeline to use.
 * - `standard` — the classic multi-model pipeline (layout + TableFormer + OCR +
 *   code/formula + picture classifier). docling-serve's own default.
 * - `vlm` — a single vision-language model does full-page conversion. Pair with
 *   a `vlmPreset` (default `granite_docling`, the MLX build on Apple Silicon).
 *
 * Per the 2026-06-27 deep-research pass, the VLM does NOT cleanly replace the
 * classic stack (table-structure + alt-text fidelity), so `standard` stays the
 * default and `vlm` is opt-in via `INGEST_PIPELINE=vlm`.
 */
export type PipelineMode = 'standard' | 'vlm';

export interface ConvertOptions {
  /** Which representations to return. Defaults to config `exportFormats`. */
  toFormats?: ExportFormat[];
  /** Run OCR on scanned/image pages. Defaults to config `ocrEnabled`. */
  doOcr?: boolean;
  /** Force OCR even on pages with a text layer. */
  forceOcr?: boolean;
  /** Pipeline for this call; defaults to config `pipeline`. */
  pipeline?: PipelineMode;
  /** VLM preset for this call (only used when the effective pipeline is `vlm`); defaults to config `vlmPreset`. */
  vlmPreset?: string;
  signal?: AbortSignal;
}

/** A file to convert, provided by the user (never fetched by the app). */
export interface FileSource {
  /** Raw base64 (no `data:` prefix) of the file bytes. */
  base64: string;
  /** Filename incl. extension, e.g. `syllabus.docx` (drives format detection). */
  filename: string;
}

/**
 * Progress for a first-run model download, emitted by the download driver per
 * model. Unlike Ollama's byte-level `/api/pull`, Docling has no streaming pull
 * API, so `download_models()` is driven as a subprocess that emits one coarse
 * step per model: `completed`/`total` are model COUNTS (not bytes); `percent` is
 * derived [0..100]. `model` is the current model's label.
 */
export interface IngestPullProgress {
  /** e.g. 'downloading' | 'success' | a per-model label line. */
  status: string;
  /** Label of the model currently downloading (e.g. 'granite_docling'). */
  model?: string;
  /** Models completed so far. */
  completed?: number;
  /** Total models to download. */
  total?: number;
  /** Derived [0..100] when completed/total are known. */
  percent?: number;
}

/** Normalized result of a conversion. */
export interface ConvertedDocument {
  status: 'success' | 'partial_success' | 'skipped' | 'failure' | string;
  processingTimeMs: number;
  markdown?: string;
  html?: string;
  text?: string;
  json?: unknown;
  doctags?: string;
}

export interface IngestConfig {
  /** docling-serve base, e.g. http://localhost:5001 (PRD Appendix H). */
  baseUrl: string;
  /** Reachability path (docling-serve health is undocumented; any HTTP response = up). */
  healthPath: string;
  /** Default output formats. */
  exportFormats: ExportFormat[];
  /** Default OCR on/off. */
  ocrEnabled: boolean;
  /** Optional OCR engine hint passed through (e.g. `ocrmac`); see notes in payload.ts. */
  ocrEngine?: string;
  /** Default processing pipeline. `standard` (classic) unless `INGEST_PIPELINE=vlm`. */
  pipeline: PipelineMode;
  /** Default VLM preset when `pipeline` is `vlm` (docling-serve `vlm_pipeline_preset`). */
  vlmPreset: string;
  /**
   * Persistent dir holding the downloaded conversion models. When set, the
   * sidecar serves OFFLINE against it (`DOCLING_SERVE_ARTIFACTS_PATH` +
   * `HF_HUB_OFFLINE`) and the first-run download writes here. Unset in dev/tests
   * (the bundled launcher's own `models/` or HF cache is used). Absolute path.
   */
  modelsDir?: string;
  /** Per-request timeout (ms). Conversions can be slow on big PDFs. */
  timeoutMs: number;
  /** If false, never spawn `docling-serve` — assume an external instance. */
  manageProcess: boolean;
}
