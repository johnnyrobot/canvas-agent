/**
 * `createEngineDeps` — assemble the orchestrator's `EngineDeps` from the REAL
 * modules (engine, theme, templates, knowledge) and the local sidecars (LLM,
 * Docling), adapting each implementation's signature onto the orchestrator's
 * loosely-typed tool-dependency surface (PRD §15.3).
 *
 * Every dependency is injectable so tests can run fully offline (fake sidecars,
 * a scripted retriever, an in-process auditor); the defaults wire the real
 * implementations. The pure engine pieces (allowlist, contrast, theme,
 * templates) are always the real ones — they are offline and fast.
 */
import { checkContrast, validateAllowlist } from '../engine/index.js';
import { audit as renderAudit } from '../engine/render/index.js';
import { resolveTheme } from '../theme/index.js';
import { renderTemplate } from '../templates/index.js';
import { createRetriever } from '../knowledge/index.js';
import { createOllamaSidecar } from '../llm/index.js';
import type { ChatResult, DescribeImageOptions } from '../llm/index.js';
import { createDoclingSidecar } from '../ingest/index.js';
import type { ConvertedDocument } from '../ingest/index.js';
import type { EngineDeps } from '../orchestrator/index.js';
import type {
  Auditor,
  KbRetriever,
  TemplateType,
  TextSize,
  ThemeResult,
} from '../contracts/index.js';

/** The minimal LLM capability the `describe_image` tool needs. */
export interface LlmDescriber {
  describeImage(opts: DescribeImageOptions): Promise<ChatResult>;
}

/** The minimal Docling capability the `ingest_document` tool needs. */
export interface DocConverter {
  convertPath(path: string): Promise<ConvertedDocument>;
}

export type RuntimeEnv = Record<string, string | undefined>;

/**
 * The on-device model the runtime selects by default. `gemma4:12b-mlx` (the
 * `src/llm` default) is NOT installed on this machine; `gemma4:31b` and
 * `gemma4:e2b` are. We never edit `src/llm`; we steer model selection through
 * the existing env-override mechanism (`MODEL_TEXT` → every role; see
 * `src/llm/config.ts`).
 */
export const RUNTIME_DEFAULT_MODEL = 'gemma4:31b';

/** Build an env that points the LLM sidecar at an installed model (override-safe). */
export function runtimeLlmEnv(base: RuntimeEnv = process.env): RuntimeEnv {
  const text = base.MODEL_TEXT && base.MODEL_TEXT !== '' ? base.MODEL_TEXT : RUNTIME_DEFAULT_MODEL;
  return { ...base, MODEL_TEXT: text };
}

export interface EngineDepsOptions {
  /** Render-and-scan auditor for `audit_html`. Default: the real Chromium audit. */
  audit?: Auditor;
  /** Knowledge-Pack retriever for `retrieve_kb`. Default: bundled packs. */
  retriever?: KbRetriever;
  /** Vision sidecar for `describe_image`. Default: a real Ollama sidecar. */
  llm?: LlmDescriber;
  /** Docling sidecar for `ingest_document`. Default: a real Docling sidecar. */
  ingest?: DocConverter;
  /** Env override used only when constructing the default LLM sidecar. */
  llmEnv?: RuntimeEnv;
}

/** The eight canonical Canvas templates (frozen `TemplateType`). */
const TEMPLATE_TYPES: ReadonlySet<TemplateType> = new Set<TemplateType>([
  'syllabus', 'module-overview', 'assignment', 'discussion',
  'page-content', 'lecture-notes', 'study-guide', 'rubric',
]);

function isTemplateType(type: string): type is TemplateType {
  return TEMPLATE_TYPES.has(type as TemplateType);
}

/** Normalize the loosely-typed `size` arg onto the WCAG text-size class. */
function normalizeSize(size: string): TextSize {
  return size === 'large' ? 'large' : 'normal';
}

/**
 * Wire the real implementations onto `EngineDeps`. Returns a `Partial` (the
 * orchestrator's contract) though in practice every dependency is populated.
 */
export function createEngineDeps(opts: EngineDepsOptions = {}): Partial<EngineDeps> {
  const auditor = opts.audit ?? renderAudit;
  const retriever = opts.retriever ?? createRetriever();
  const llm = opts.llm ?? createOllamaSidecar({ env: runtimeLlmEnv(opts.llmEnv) });
  const ingest = opts.ingest ?? createDoclingSidecar();

  return {
    auditHtml: (html) => auditor(html),
    validateAllowlist: (html) => validateAllowlist(html),
    checkContrast: async (fg, bg, size) => checkContrast(fg, bg, normalizeSize(size)),
    resolveTheme: async (color1, color2, roles) =>
      resolveTheme(color1, color2, roles.length > 0 ? roles : undefined),
    renderTemplate: async (type, slots, theme) =>
      renderTemplate(
        // Validated against the 8 frozen TemplateTypes; an unrecognized type is
        // forwarded so renderTemplate emits its safe warning fragment (no throw).
        isTemplateType(type) ? type : (type as TemplateType),
        slots,
        theme == null ? undefined : (theme as ThemeResult),
      ),
    ingestDocument: (fileRef) => ingest.convertPath(fileRef),
    describeImage: (args) => llm.describeImage(args).then((r) => r.content),
    retrieveKb: (query, packs) => retriever(query, packs),
  };
}
