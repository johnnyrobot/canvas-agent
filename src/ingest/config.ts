/**
 * Loads Docling ingestion config from the environment (PRD Appendix H).
 * Pure and dependency-free.
 */
import type { ExportFormat, IngestConfig } from './types.js';

export type Env = Record<string, string | undefined>;

const VALID_FORMATS: readonly ExportFormat[] = ['md', 'json', 'html', 'text', 'doctags'];

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

export function loadIngestConfig(env: Env = process.env): IngestConfig {
  const ocrEngine = str(env, 'DOCLING_OCR_ENGINE', '');
  const config: IngestConfig = {
    baseUrl: str(env, 'DOCLING_SERVE_URL', 'http://localhost:5001').replace(/\/$/, ''),
    healthPath: str(env, 'DOCLING_HEALTH_PATH', '/health'),
    exportFormats: parseExportFormats(str(env, 'DOCLING_EXPORT', 'html,json')),
    ocrEnabled: bool(env, 'DOCLING_OCR_ENABLED', true),
    timeoutMs: num(env, 'DOCLING_TIMEOUT_MS', 300000),
    manageProcess: bool(env, 'DOCLING_MANAGE_PROCESS', true),
  };
  if (ocrEngine) config.ocrEngine = ocrEngine;
  return config;
}
