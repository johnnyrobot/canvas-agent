/**
 * Types for the local Docling ingestion sidecar.
 *
 * Read-only document conversion (DOCX/PPTX/XLSX/PDF/images → structured content)
 * via a bundled `docling-serve` HTTP sidecar. No cloud, no external API, no
 * tagging/remediation of the source (PRD §16).
 */

/** Docling output formats (subset of docling-serve `to_formats`). */
export type ExportFormat = 'md' | 'json' | 'html' | 'text' | 'doctags';

export interface ConvertOptions {
  /** Which representations to return. Defaults to config `exportFormats`. */
  toFormats?: ExportFormat[];
  /** Run OCR on scanned/image pages. Defaults to config `ocrEnabled`. */
  doOcr?: boolean;
  /** Force OCR even on pages with a text layer. */
  forceOcr?: boolean;
  signal?: AbortSignal;
}

/** A file to convert, provided by the user (never fetched by the app). */
export interface FileSource {
  /** Raw base64 (no `data:` prefix) of the file bytes. */
  base64: string;
  /** Filename incl. extension, e.g. `syllabus.docx` (drives format detection). */
  filename: string;
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
  /** Per-request timeout (ms). Conversions can be slow on big PDFs. */
  timeoutMs: number;
  /** If false, never spawn `docling-serve` — assume an external instance. */
  manageProcess: boolean;
}
