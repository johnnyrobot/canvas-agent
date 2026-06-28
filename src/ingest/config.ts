/**
 * Loads Docling ingestion config from the environment (PRD Appendix H).
 * Pure and dependency-free.
 */
import type { ExportFormat, IngestConfig, PipelineMode } from './types.js';

export type Env = Record<string, string | undefined>;

const VALID_FORMATS: readonly ExportFormat[] = ['md', 'json', 'html', 'text', 'doctags'];
const VALID_PIPELINES: readonly PipelineMode[] = ['standard', 'vlm'];

function str(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${key}: ${JSON.stringify(v)}`);
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Parse a comma list of export formats, validating each. */
export function parseExportFormats(value: string): ExportFormat[] {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (!VALID_FORMATS.includes(p as ExportFormat)) {
      throw new Error(`Unknown DOCLING_EXPORT format: ${p} (allowed: ${VALID_FORMATS.join(', ')})`);
    }
  }
  return parts.length > 0 ? (parts as ExportFormat[]) : ['html', 'json'];
}

/** Validate the requested pipeline mode (`standard` | `vlm`). */
export function parsePipeline(value: string): PipelineMode {
  if (!VALID_PIPELINES.includes(value as PipelineMode)) {
    throw new Error(`Unknown INGEST_PIPELINE: ${value} (allowed: ${VALID_PIPELINES.join(', ')})`);
  }
  return value as PipelineMode;
}

export function loadIngestConfig(env: Env = process.env): IngestConfig {
  const ocrEngine = str(env, 'DOCLING_OCR_ENGINE', '');
  const config: IngestConfig = {
    baseUrl: str(env, 'DOCLING_SERVE_URL', 'http://localhost:5001').replace(/\/$/, ''),
    healthPath: str(env, 'DOCLING_HEALTH_PATH', '/health'),
    exportFormats: parseExportFormats(str(env, 'DOCLING_EXPORT', 'html,json')),
    ocrEnabled: bool(env, 'DOCLING_OCR_ENABLED', true),
    // Classic pipeline by default; opt into the Granite-Docling VLM with
    // INGEST_PIPELINE=vlm (preset overridable via INGEST_VLM_PRESET).
    pipeline: parsePipeline(str(env, 'INGEST_PIPELINE', 'standard')),
    vlmPreset: str(env, 'INGEST_VLM_PRESET', 'granite_docling'),
    timeoutMs: num(env, 'DOCLING_TIMEOUT_MS', 300000),
    manageProcess: bool(env, 'DOCLING_MANAGE_PROCESS', true),
  };
  if (ocrEngine) config.ocrEngine = ocrEngine;
  // Persistent model store for the first-run download (set by the app to the
  // per-user data dir). Omitted in dev/tests → the bundled launcher's defaults.
  const modelsDir = str(env, 'DOCLING_MODELS_DIR', '');
  if (modelsDir) config.modelsDir = modelsDir;
  return config;
}
