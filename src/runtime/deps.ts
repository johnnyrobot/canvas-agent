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
import { createDoclingSidecar, resolveStagedPath } from '../ingest/index.js';
import type { ConvertedDocument } from '../ingest/index.js';
import { resolveAppPaths } from '../storage/index.js';
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
 * The on-device model the runtime selects by default.
 *
 * Permissively licensed, by rule (ADR-0007): every default the app pulls on a
 * user's behalf must be Apache-2.0 or MIT, so that running an Apache-2.0
 * accessibility tool never obliges an instructor — or the district reviewing it
 * — to accept a third-party acceptable-use policy. That rule, not benchmark
 * scores, is what moved this off Gemma; `SHIPPED_MODEL_LICENCES` below is the
 * declaration the guard test checks.
 *
 * Sized for the machines this ships to, not for the dev box: `granite4.1:8b` is
 * ~5.3 GB and runs on 16 GB Macs with Chromium alongside it. That argument only
 * got stronger — the previous default was ~7 GB, and the one before that
 * (`gemma4:31b`, ~20 GB) excluded most target hardware outright.
 *
 * The trade is real and bounded, and the warning is unchanged by the switch: a
 * general-purpose model is pass-biased on unaided WCAG judgment (it under-reports
 * violations), so it must never be the sole arbiter of whether content conforms.
 * That is already the design — axe-core detects issues deterministically and the
 * gate re-scans every proposed fix. The exposed surfaces are the ones where the
 * model *is* the judge — contrast adjudication and alt-text suggestion — which is
 * why those are the ones being measured before any further promotion. Evidence:
 * `scripts/model-eval/`.
 *
 * We never edit `src/llm`; we steer model selection through the existing
 * env-override mechanism (`MODEL_TEXT` → every role; see `src/llm/config.ts`).
 */
export const RUNTIME_DEFAULT_MODEL = 'granite4.1:8b';

/**
 * The on-device VISION model the runtime selects by default — the second half of
 * the required set (ADR-0009), and the reason alt-text *suggestion* works at all.
 *
 * This role used to inherit `MODEL_TEXT`, which was harmless only while the text
 * default happened to be multimodal. `granite4.1:8b` is not: `ollama show`
 * reports `completion, tools` and no `vision`, so a real `describeImage` call
 * against it fails outright with `Ollama /api/chat returned 400`. Pointing the
 * role at a model that cannot see is not a degradation to tolerate — it is a
 * broken flagship path, and giving vision its own default is what closes it.
 *
 * This tag is no longer provisional. It was chosen by running
 * `scripts/alt-gate/` — the reduced alt-SUGGESTION gate — against the
 * previously-declared candidate, and the previous candidate LOST:
 *
 *   qwen3-vl:4b                              floor PASS, 3 runs of 3
 *   hf.co/…/granite-vision-4.1-4b-GGUF:Q4_K_M  floor FAIL, 0 runs of 2
 *   granite4.1:8b (text-only control)        floor FAIL, 10/10 fixtures, every run
 *
 * The incumbent failed two ways that matter to an instructor. It narrated a
 * DECORATIVE divider instead of returning empty alt, every run. And it
 * intermittently echoed the surrounding page text back as the alt text rather
 * than reading the image — on one run it returned the supplied page context
 * verbatim for a screenshot and never read the word rendered in the pixels.
 * Alt text that repeats what the screen-reader user just heard is not a text
 * alternative.
 *
 * Four things were verified before declaring it, and ALL FOUR must be redone for
 * any replacement:
 *   1. It RESOLVES and pulls. Note this is a plain library tag, which the
 *      previous default was not: the obvious-looking `granite-vision-4.1-4b`
 *      404s on registry.ollama.ai, which forced an `hf.co/…` form whose upstream
 *      repo can be renamed out from under a shipped `ollama pull` recovery
 *      command. A library tag removes that exposure and is the documented
 *      tiebreak.
 *   2. It reports `vision` in `ollama show` capabilities. Pulling is not the bar
 *      — the text default pulls fine and cannot see. Now also asserted at
 *      runtime per ROLE (ADR-0010), not just here.
 *   3. Its licence is permissive, read from the model's own bundled licence text
 *      rather than a summary: Apache License 2.0 (`ollama show --license`).
 *   4. It clears the alt-suggestion floor (`npx tsx scripts/alt-gate/run.ts`),
 *      with the text-only control arm failing in the same run. A gate that
 *      cannot show it detects an incapable model proves nothing when it passes.
 *
 * WHAT THE GATE DID NOT ESTABLISH, so nobody quotes it as more than it is: ten
 * RENDERED images cannot tell reliable from lucky, and a real phone photo of a
 * syllabus is a harder read than crisp vector text. Two known quality gaps
 * survive it — this model answers an equation fixture in LaTeX (passes the
 * floor, unusable read aloud), and it advertises a `thinking` capability, the
 * class of model that can spend its whole token budget reasoning and return
 * empty. Neither appeared across 30 live calls through the app's own
 * `describeImage`. Both belong to the full gate (#42/#43).
 *
 * ~3.3 GB — the same as the tag it replaces. The required set still totals
 * ~8.6 GB, but first run no longer spends it all: since ADR-0012 these weights
 * are fetched the first time alt-text suggestion is used, so the figure quoted
 * before the user commits is the text model's 5.3 GB, with the rest named
 * separately (`MODEL_DOWNLOAD_SIZES_GB`).
 */
export const RUNTIME_DEFAULT_VISION_MODEL = 'qwen3-vl:4b';

/** The only licences a shipped default may carry (ADR-0007). */
export const PERMISSIVE_LICENCES = ['Apache-2.0', 'MIT'] as const;
export type PermissiveLicence = (typeof PERMISSIVE_LICENCES)[number];

/**
 * Every model tag this app ships as a default, with the licence its weights are
 * under. Adding a default without adding it here fails the guard test in
 * `deps.test.ts` — which is the point: a model tag is only a string, so the
 * licence constraint of ADR-0007 is invisible in the code it governs and has to
 * be asserted somewhere. Licences are verified from each model's card.
 *
 * The value type is the permissive union, so a non-permissive licence is a
 * COMPILE error here rather than a runtime assertion — you cannot declare
 * `'Gemma Terms of Use'` at all. The guard test still runs, because it catches
 * the other half: a default that was never declared here.
 */
export const SHIPPED_MODEL_LICENCES: Readonly<Record<string, PermissiveLicence>> = {
  'granite4.1:8b': 'Apache-2.0',
  [RUNTIME_DEFAULT_VISION_MODEL]: 'Apache-2.0',
};

/**
 * Build an env that points the LLM sidecar at the shipping defaults
 * (override-safe): one entry per role that has a default of its own.
 *
 * Both required roles are set here rather than left to `src/llm/config.ts`'s
 * inheritance, per ADR-0007 — shipping defaults live in the runtime, in one
 * place the guard tests can assert against. Setting `MODEL_VISION` explicitly is
 * also what severs the inheritance: with only `MODEL_TEXT` set, an operator
 * overriding the text model would silently move the vision role onto a tag that
 * may not be multimodal at all.
 *
 * An explicit override always wins, for each role independently; empty means
 * unset, matching how `src/llm/config.ts` reads env.
 */
export function runtimeLlmEnv(base: RuntimeEnv = process.env): RuntimeEnv {
  const pick = (value: string | undefined, fallback: string): string =>
    value !== undefined && value !== '' ? value : fallback;
  return {
    ...base,
    MODEL_TEXT: pick(base.MODEL_TEXT, RUNTIME_DEFAULT_MODEL),
    MODEL_VISION: pick(base.MODEL_VISION, RUNTIME_DEFAULT_VISION_MODEL),
  };
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
  /**
   * Uploads/staging dir that `ingest_document` refs are confined to (C6). The
   * model-supplied `fileRef` is resolved strictly inside this dir, so a
   * prompt-injected absolute path or `..` traversal cannot read arbitrary files.
   * Default: the app's resolved uploads dir.
   */
  uploadsDir?: string;
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
  const uploadsDir = opts.uploadsDir ?? resolveAppPaths().uploadsDir;

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
    // Confine the model-supplied fileRef to the uploads dir before any fs read (C6).
    // `async` so a containment failure surfaces as a rejection, not a sync throw.
    ingestDocument: async (fileRef) => ingest.convertPath(resolveStagedPath(uploadsDir, fileRef)),
    describeImage: (args) => llm.describeImage(args).then((r) => r.content),
    retrieveKb: (query, packs) => retriever(query, packs),
  };
}
