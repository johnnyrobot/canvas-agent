/**
 * Builds docling-serve `/v1/convert/source` request bodies and normalizes the
 * response. Pure and testable.
 *
 * We use the `source` endpoint (JSON) with `file_sources` (base64) for
 * user-supplied files and `http_sources` for URLs — the documented payload
 * shape. Options map to docling-serve fields: `to_formats`, `do_ocr`,
 * `force_ocr`. NOTE: `ocr_engine` is deprecated upstream in favor of
 * `ocr_preset`; we pass it through only if explicitly configured and leave the
 * preset mapping as a follow-up (see README).
 */
import type { ConvertOptions, ConvertedDocument, FileSource, IngestConfig } from './types.js';

export interface ConvertRequest {
  options: {
    to_formats: string[];
    do_ocr: boolean;
    force_ocr: boolean;
    ocr_engine?: string;
  };
  http_sources?: { url: string }[];
  file_sources?: { base64_string: string; filename: string }[];
}

export function buildConvertOptions(opts: ConvertOptions, config: IngestConfig): ConvertRequest['options'] {
  const options: ConvertRequest['options'] = {
    to_formats: opts.toFormats ?? config.exportFormats,
    do_ocr: opts.doOcr ?? config.ocrEnabled,
    force_ocr: opts.forceOcr ?? false,
  };
  if (config.ocrEngine) options.ocr_engine = config.ocrEngine;
  return options;
}

export function buildFileRequest(file: FileSource, opts: ConvertOptions, config: IngestConfig): ConvertRequest {
  return {
    options: buildConvertOptions(opts, config),
    file_sources: [{ base64_string: file.base64, filename: file.filename }],
  };
}

export function buildUrlRequest(url: string, opts: ConvertOptions, config: IngestConfig): ConvertRequest {
  return {
    options: buildConvertOptions(opts, config),
    http_sources: [{ url }],
  };
}

/** Raw docling-serve response shape (the bits we consume). */
interface RawConvertResponse {
  document?: {
    md_content?: string;
    html_content?: string;
    text_content?: string;
    json_content?: unknown;
    doctags_content?: string;
  };
  status?: string;
  processing_time?: number;
}

/** Normalize a docling-serve response into a ConvertedDocument. */
export function normalizeResponse(raw: unknown): ConvertedDocument {
  const r = (raw ?? {}) as RawConvertResponse;
  const doc = r.document ?? {};
  const out: ConvertedDocument = {
    status: r.status ?? 'failure',
    processingTimeMs: Math.round((r.processing_time ?? 0) * 1000),
  };
  if (doc.md_content) out.markdown = doc.md_content;
  if (doc.html_content) out.html = doc.html_content;
  if (doc.text_content) out.text = doc.text_content;
  if (doc.json_content !== undefined) out.json = doc.json_content;
  if (doc.doctags_content) out.doctags = doc.doctags_content;
  return out;
}
