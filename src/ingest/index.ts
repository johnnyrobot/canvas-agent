/**
 * Document ingestion sidecar — public surface.
 *
 * Read-only conversion of user-supplied DOCX/PPTX/XLSX/PDF/images → structured
 * content via a bundled local `docling-serve` (PRD §16). No cloud, no external
 * API; the app does not tag or remediate the source document.
 */
export { createDoclingSidecar, DoclingSidecar } from './sidecar.js';
export { resolveStagedPath, IngestPathError } from './safe-path.js';
export { DoclingClient, DoclingError } from './client.js';
export { DoclingProcess } from './process.js';
export { loadIngestConfig, parseExportFormats } from './config.js';
export { buildConvertOptions, buildFileRequest, buildUrlRequest, normalizeResponse } from './payload.js';
export type {
  ExportFormat,
  ConvertOptions,
  ConvertedDocument,
  FileSource,
  IngestConfig,
} from './types.js';
