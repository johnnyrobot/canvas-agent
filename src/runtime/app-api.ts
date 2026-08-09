/**
 * `createAppApi` — the runtime keystone. Implements the FROZEN `AppApi`
 * (`src/contracts`): the product-layer turn pipeline (intent routing → scripted-
 * or-real model → real tools → the unconditional output gate), streaming, the
 * Remediate repair flow, session persistence, brand-kit theme resolution, the
 * read-only Canvas importer + page readers, and a best-effort sidecar health
 * probe. The Electron app-shell track consumes this surface over IPC and uses a
 * fake `AppApi` in its own tests.
 *
 * Everything is injectable so `npm test` runs fully offline: a scripted
 * `chatRunner`, fake sidecars, a scripted retriever, an in-process auditor, and
 * in-memory / injected stores — but the REAL engine (allowlist + contrast),
 * theme, templates, knowledge, gate, router, and mode prompts. The defaults wire
 * the real model + sidecars + on-device SQLite for production.
 */
import { validateAllowlist } from '../engine/index.js';
import { createAuditor, createPlaywrightRunner } from '../engine/render/index.js';
import { createRetriever } from '../knowledge/index.js';
import { importCourse, fetchPageBody as defaultFetchPageBody, listPages as defaultListPages } from '../canvas/index.js';
import type { PageReader } from '../canvas/index.js';
import { createCatalogClient } from '../catalog/index.js';
import type { CatalogClient } from '../catalog/index.js';
import { resolveTheme as defaultResolveTheme } from '../theme/index.js';
import { createOllamaSidecar, reportedModels } from '../llm/index.js';
import type {
  ChatMessage,
  ModelStatusState,
  OllamaSidecar,
  RequiredModelRole,
  RequiredModelStatus,
} from '../llm/index.js';
import { REQUIRED_ROLES } from '../llm/index.js';
import { noopActivityTracker, type ActivityTracker } from './activity.js';
import type { LazyDatabase } from './database.js';
import { createDoclingSidecar } from '../ingest/index.js';
import type { ConvertedDocument, FileSource } from '../ingest/index.js';
import {
  Orchestrator,
  ToolRegistry,
  createCanonicalTools,
  enforceGate,
  routeIntent,
  systemPromptForMode,
} from '../orchestrator/index.js';
import type {
  ChatRunner,
  OrchestratorOptions,
  ToolContext,
  TurnInput,
  TurnResult,
} from '../orchestrator/index.js';
import {
  createBrandKitStore,
  createKeychainSecretStore,
  createSessionStore,
  ensureAppDirs,
  migrate,
  openDatabase,
  resolveAppPaths,
} from '../storage/index.js';
import type { BrandKitStore, SessionStore } from '../storage/index.js';
import {
  createEngineDeps,
  runtimeLlmEnv,
  type DocConverter,
  type LlmDescriber,
  type RuntimeEnv,
} from './deps.js';
import type {
  AppApi,
  AuditIssue,
  Auditor,
  CanvasConfig,
  CanvasImporter,
  Database,
  DocumentConversionResult,
  SecretStore,
  GateDeps,
  GateResult,
  IssueFix,
  KbRetriever,
  ModelHealth,
  ModelPullProgress,
  OnModelPullProgress,
  OnTurnChunk,
  ProductMode,
  RemediateResult,
  RuntimeHealth,
  SessionMessage,
  ThemeResolver,
  TurnFragment,
  TurnRequest,
  TurnView,
  UploadedDocument,
} from '../contracts/index.js';

/** LLM capability the runtime needs: vision drafting + a health probe. */
export interface LlmRuntime extends LlmDescriber {
  isHealthy(): Promise<boolean>;
  /**
   * Presence of the required models (ADR-0009). `models` is the per-role
   * breakdown the real sidecar returns; it is optional here because injected
   * doubles and externally-managed daemons may only be able to answer in
   * aggregate, in which case `health()` applies the one answer to both required
   * roles using the configured tags.
   */
  modelStatus?(): Promise<{ ready: boolean; models?: RequiredModelStatus[] }>;
  /** Download the configured model, reporting progress. First-run provisioning. */
  pullModel?(onProgress?: (p: ModelPullProgress) => void): Promise<void>;
}

/** Docling capability the runtime needs: conversion + a health probe. */
export interface IngestRuntime extends DocConverter {
  isHealthy(): Promise<boolean>;
  convert?(file: FileSource): Promise<ConvertedDocument>;
  /** Whether the conversion models are present locally (first-run provisioning). */
  modelStatus?(): Promise<{ available: boolean }>;
  /** Download the conversion models, reporting progress. First-run provisioning. */
  pullModel?(onProgress?: (p: ModelPullProgress) => void): Promise<void>;
}

export interface AppApiOptions {
  /** The model. Defaults to a real Ollama sidecar (shared with `llm`). */
  chatRunner?: ChatRunner;
  /** Vision + health sidecar. Defaults to the same real Ollama sidecar. */
  llm?: LlmRuntime;
  /** Docling sidecar (ingest + health). Defaults to a real Docling sidecar. */
  ingest?: IngestRuntime;
  /** Knowledge-Pack retriever (tool + prompt grounding). Default: bundled packs. */
  retriever?: KbRetriever;
  /** Read-only Canvas importer. Default: the real `importCourse`. */
  importer?: CanvasImporter;
  /** Full gate override. Default: real engine `validateAllowlist` + `audit`. */
  gate?: GateDeps;
  /** Render-and-scan auditor (tool + gate). Default: the real Chromium audit. */
  audit?: Auditor;
  /** Bounded tool-loop cap. Default 5. */
  maxToolIterations?: number;
  /** Citations grounded into the system prompt. Default 3. */
  maxCitations?: number;
  /**
   * App-level system-prompt override. Per turn the base prompt is
   * `req.system ?? systemPrompt ?? systemPromptForMode(mode)` — so a request
   * override wins, then this, then the per-mode prompt. Default: per-mode.
   */
  systemPrompt?: string;
  /** Env override for the default LLM sidecar (model selection). */
  llmEnv?: RuntimeEnv;
  /**
   * The app database (sessions + brand kits). When omitted, the real on-device
   * SQLite DB is opened + migrated LAZILY on first session/brand-kit use, so
   * offline tests that inject stores or never touch persistence need no file.
   */
  db?: Database;
  /** Session store override (else built lazily from `db`). */
  sessionStore?: SessionStore;
  /** Brand-kit store override (else built lazily from `db`). */
  brandKitStore?: BrandKitStore;
  /** Theme resolver for `resolveBrandTheme` (pure WCAG math, NO LLM). Default: real `resolveTheme`. */
  resolveTheme?: ThemeResolver;
  /** Read-only single-page fetch (Remediate import). Default: real `fetchPageBody`. */
  fetchPageBody?: PageReader['fetchPageBody'];
  /** Read-only course page list. Default: real `listPages`. */
  listPages?: PageReader['listPages'];
  /** Secret store for the Canvas token. Default: the macOS Keychain-backed store. */
  secrets?: SecretStore;
  /**
   * Catalog enrichment client (OPTIONAL; see `src/catalog/README.md`). Default:
   * a real `createCatalogClient()` resolving `laccd-courses-pp-cli` off PATH.
   * `catalogAvailable()` degrades to `false` rather than throwing when the CLI
   * isn't installed — this is never a hard runtime dependency.
   */
  catalog?: CatalogClient;
  /**
   * Owns the on-device SQLite handle's open AND close. Supplied by
   * `createRuntime` so shutdown can close it (ADR-0006). Omitted elsewhere, in
   * which case the inline lazy open below applies and nothing closes it --
   * unchanged from before.
   */
  database?: LazyDatabase;
  /**
   * Turn-activity bracket, so shutdown can drain an in-flight turn. Default: a
   * no-op tracker, so a `createAppApi` built without `createRuntime` behaves
   * exactly as it did.
   */
  activity?: ActivityTracker;
}

/**
 * The runtime's hard-rule system prompt (PRD §15). Retained as the documented
 * baseline; per-turn the runtime defaults to the per-mode prompt
 * (`systemPromptForMode`), which embeds these same hard rules plus a specialty.
 */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are the Canvas Course Design & Accessibility Assistant, running fully on-device.',
  'Hard rules (never violate):',
  '- Produce only Canvas-allowlist-safe HTML and aim for WCAG 2.2 AA; the server-side',
  '  output gate re-checks every fragment, so never claim something "passes" yourself.',
  '- Use the provided tools (render_template, audit_html, validate_allowlist, check_contrast,',
  '  resolve_theme, retrieve_kb, describe_image, ingest_document) instead of guessing.',
  '- Never fetch remote resources; only describe user-supplied images.',
  '- Ground claims in the retrieved Knowledge-Pack sources and cite them.',
].join('\n');

/**
 * Rule for what counts as an emitted HTML fragment (gated before it reaches a
 * UI): (1) any tool result carrying a string `html` field — `render_template`
 * and `validate_allowlist` — and (2) any ```html fenced block in the model's
 * final text. Each is run through `enforceGate`; everything else is ignored.
 */
function extractHtmlFragments(turn: TurnResult): string[] {
  const out: string[] = [];
  for (const inv of turn.toolInvocations) {
    const r = inv.result;
    if (r && typeof r === 'object' && typeof (r as { html?: unknown }).html === 'string') {
      out.push((r as { html: string }).html);
    }
  }
  out.push(...extractFencedHtml(turn.text));
  return out;
}

const FENCED_HTML = /```html\s*\n?([\s\S]*?)```/gi;

function extractFencedHtml(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  FENCED_HTML.lastIndex = 0;
  while ((m = FENCED_HTML.exec(text)) !== null) {
    const body = m[1];
    if (body !== undefined && body.trim() !== '') out.push(body.trim());
  }
  return out;
}

function dedupe(names: string[]): string[] {
  return [...new Set(names)];
}

/** Probe a sidecar's health without ever throwing (false ⇒ unreachable). */
async function reachable(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await probe()) === true;
  } catch {
    return false;
  }
}

/** Every issue a gate surfaced (blockers + warnings + items needing review). */
/** Keychain account key for a Canvas instance's token (namespaced by base URL). */
function canvasSecretKey(baseUrl: string): string {
  return `canvas-token:${baseUrl}`;
}

function gateIssues(gate: GateResult): AuditIssue[] {
  const c = gate.conformance;
  return [...c.blockers, ...c.warnings, ...c.needsHumanReview];
}

/** Keep the first issue per distinct `id` (the diff is keyed by `AuditIssue.id`). */
function uniqueById(issues: AuditIssue[]): AuditIssue[] {
  const seen = new Set<string>();
  const out: AuditIssue[] = [];
  for (const issue of issues) {
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      out.push(issue);
    }
  }
  return out;
}

/** The model's emitted corrected HTML for a turn = its last gate-eligible fragment. */
function lastFragment(turn: TurnResult): string | undefined {
  const frags = extractHtmlFragments(turn);
  return frags.length > 0 ? frags[frags.length - 1] : undefined;
}

/**
 * C11 enforcement (the half the arc left unwired): a final answer truncated at
 * `num_predict` (`doneReason==='length'`) must never be surfaced as a finished
 * draft. The frozen `TurnView` has no structured field for this, so we flag it
 * honestly in the user-visible prose — the gate still re-audits any HTML fragment
 * independently, so this only governs how the *prose* is presented.
 */
const TRUNCATION_NOTICE =
  '⚠️ This response was cut off before it finished (the model reached its output limit), ' +
  'so it may be incomplete — ask me to continue or regenerate it.';

const SCREENSHOT_PROMPT = [
  'You are helping answer a Canvas LMS question from a screenshot.',
  'Describe the relevant UI state, visible Canvas controls, error messages, selected content,',
  'and accessibility/course-design clues. Do not invent hidden information. Keep it concise.',
].join(' ');

const MAX_DOCUMENT_UPLOAD_BYTES = 25 * 1024 * 1024;

function withTruncationNotice(text: string, doneReason: string | undefined): string {
  if (doneReason !== 'length') return text;
  return text.trim().length > 0 ? `${TRUNCATION_NOTICE}\n\n${text}` : TRUNCATION_NOTICE;
}

/**
 * The model is instructed never to self-certify — only the server-side gate may
 * grant the "passed checks" badge. But `view.text` is ungated prose, so a
 * prompt-injected or over-eager draft can still ASSERT achieved conformance
 * ("this page is WCAG 2.2 AA certified", "fully accessible", "508 compliant").
 * That over-claim could mislead a user into trusting the prose over the badge —
 * exactly the overlay-style dishonesty the gate exists to prevent.
 *
 * We LABEL (never scrub) such claims: a prepended disclaimer makes clear the prose
 * is the assistant's wording and only the per-fragment badge is authoritative. The
 * author's text is preserved verbatim. This is purely a text-honesty guard — prose
 * renders as `textContent`, never an `innerHTML` sink, so this is not sanitization.
 */
const CONFORMANCE_CLAIM = new RegExp(
  [
    'wcag\\s*2(?:\\.\\d)?\\s*(?:level\\s*)?a{1,3}\\b', // "WCAG 2.2 AA", "WCAG 2 A"
    '\\bcertified\\b',
    '\\bcompliant\\b',
    '\\bconforms?\\s+to\\b',
    '\\b(?:fully|100%)\\s+accessible\\b',
    '\\bmeets?\\s+(?:all\\s+)?(?:the\\s+)?(?:wcag|accessibility)\\b',
    '\\bpass(?:es|ed)?\\s+(?:all\\s+)?(?:the\\s+)?(?:accessibility|wcag|a11y)\\b',
    '\\b(?:section\\s*508|ada)\\s+complian\\w*', // (also caught by 'compliant' above)
  ].join('|'),
  'i',
);

const CONFORMANCE_DISCLAIMER =
  'ℹ️ Only the accessibility badge on each generated fragment is an authoritative WCAG check. ' +
  'Any "certified" / "compliant" / "passes" wording below is the assistant\'s phrasing, not a verified result.';

function withConformanceDisclaimer(text: string): string {
  return CONFORMANCE_CLAIM.test(text) ? `${CONFORMANCE_DISCLAIMER}\n\n${text}` : text;
}

/** Honesty annotations applied to the ungated prose of a turn (truncation + conformance over-claim). */
function annotateProse(text: string, doneReason: string | undefined): string {
  return withTruncationNotice(withConformanceDisclaimer(text), doneReason);
}

function escapeHtmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fallbackHtmlFromText(filename: string, text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 80);
  const body = paragraphs.length > 0
    ? paragraphs.map((part) => `<p>${escapeHtmlText(part).replace(/\n/g, '<br>')}</p>`).join('\n')
    : '<p>No readable document text was returned.</p>';
  return `<h2>${escapeHtmlText(filename)}</h2>\n${body}`;
}

function base64FromDataUrl(dataUrl: string): string {
  const match = /^data:[^,]*;base64,(?<base64>[A-Za-z0-9+/=\s]+)$/u.exec(dataUrl);
  const base64 = match?.groups?.base64?.replace(/\s/g, '');
  if (!base64) throw new Error('Document upload must be a base64 data URL.');
  return base64;
}

function documentConversionResult(document: UploadedDocument, converted: ConvertedDocument): DocumentConversionResult {
  const html = converted.html
    ?? (converted.markdown ? fallbackHtmlFromText(document.filename, converted.markdown) : undefined)
    ?? (converted.text ? fallbackHtmlFromText(document.filename, converted.text) : undefined);
  const out: DocumentConversionResult = {
    filename: document.filename,
    status: converted.status,
    processingTimeMs: converted.processingTimeMs,
  };
  if (html) out.html = html;
  if (converted.markdown) out.markdown = converted.markdown;
  if (converted.text) out.text = converted.text;
  return out;
}

/** Map a persisted `SessionMessage` onto an LLM `ChatMessage` for history replay. */
function toChatMessage(m: SessionMessage): ChatMessage {
  return { role: m.role, content: m.content };
}

/** The user content for a Remediate orchestrator turn: the HTML + the gate's issues. */
function remediateUserPrompt(html: string, issues: AuditIssue[]): string {
  const issueLines =
    issues.length > 0
      ? issues.map((i) => `- [${i.severity}] ${i.id}: ${i.message}`).join('\n')
      : '- (the gate found no blocking issues; double-check accessibility + allowlist safety)';
  return [
    'Repair the Canvas page HTML below so it is accessible (WCAG 2.2 AA) and',
    "Canvas-allowlist-safe. Preserve the author's content and intent — change only",
    'what is necessary. Return the corrected page as a single ```html fenced block.',
    '',
    'Issues the server-side gate detected:',
    issueLines,
    '',
    'Source HTML to repair:',
    '```html',
    html,
    '```',
  ].join('\n');
}

async function userWithScreenshotContext(req: TurnRequest, llm: LlmRuntime): Promise<string> {
  const screenshots = (req.attachments ?? []).filter((a) => a.kind === 'screenshot');
  if (screenshots.length === 0) return req.user;

  const summaries: string[] = [];
  for (const [idx, screenshot] of screenshots.entries()) {
    try {
      const described = await llm.describeImage({
        image: screenshot.dataUrl,
        prompt: SCREENSHOT_PROMPT,
      });
      summaries.push(
        `Screenshot ${idx + 1} (${screenshot.label}, captured ${screenshot.capturedAt}): ${described.content.trim()}`,
      );
    } catch (err) {
      throw new Error(`Could not describe screenshot "${screenshot.label}": ${(err as Error).message}`);
    }
  }

  return [
    req.user,
    '',
    'Screenshot context (summarized locally; raw pixels were not stored in the session):',
    ...summaries.map((summary) => `- ${summary}`),
  ].join('\n');
}

/** Build the frozen `AppApi` from real (or injected) parts. */
export function createAppApi(opts: AppApiOptions = {}): AppApi {
  // A single real Ollama sidecar backs both the chat runner and vision/health
  // when neither is injected (single-user, single local model).
  let shared: OllamaSidecar | undefined;
  const sidecar = (): OllamaSidecar => (shared ??= createOllamaSidecar({ env: runtimeLlmEnv(opts.llmEnv) }));

  const chatRunner: ChatRunner = opts.chatRunner ?? sidecar();
  const llm: LlmRuntime = opts.llm ?? sidecar();
  const ingest: IngestRuntime = opts.ingest ?? createDoclingSidecar();
  const retriever: KbRetriever = opts.retriever ?? createRetriever();
  const importer: CanvasImporter = opts.importer ?? importCourse;
  const gateDepsFor = (auditor: Auditor): GateDeps => opts.gate ?? { validateAllowlist, audit: auditor };
  const maxToolIterations = opts.maxToolIterations ?? 5;
  const systemPromptOverride = opts.systemPrompt;
  const resolveThemeFn: ThemeResolver = opts.resolveTheme ?? defaultResolveTheme;
  const fetchPageBodyFn: PageReader['fetchPageBody'] = opts.fetchPageBody ?? defaultFetchPageBody;
  const listPagesFn: PageReader['listPages'] = opts.listPages ?? defaultListPages;
  const secrets: SecretStore = opts.secrets ?? createKeychainSecretStore();
  const catalog: CatalogClient = opts.catalog ?? createCatalogClient();
  const activity: ActivityTracker = opts.activity ?? noopActivityTracker;
  // The required roles + the tags they resolve to (ADR-0009), used when the LLM
  // runtime can't break its answer out per role. The required set is defined in
  // `src/llm/config.ts`; this must not grow a second definition of it.
  const configuredRequiredModels = reportedModels(sidecar().config);

  // Resolve the saved Canvas token for `baseUrl` from the OS Keychain and build the
  // full config the read-only canvas readers expect. The token never reaches (or
  // returns through) the renderer — only the baseUrl crosses IPC for read calls.
  const canvasConfigFor = async (baseUrl: string): Promise<CanvasConfig> => {
    const token = await secrets.get(canvasSecretKey(baseUrl));
    if (token == null) {
      throw new Error(
        `No saved Canvas credentials for ${baseUrl}. Call saveCanvasAuth({ baseUrl, token }) first.`,
      );
    }
    return { baseUrl, token };
  };

  // Lazily-opened on-device DB + stores. Never touched by offline tests that
  // inject `db`/stores or never call a session/brand-kit method.
  let dbPromise: Promise<Database> | undefined;
  const database = (): Promise<Database> => {
    if (opts.db) return Promise.resolve(opts.db);
    if (opts.database) return opts.database.open();
    return (dbPromise ??= (async () => {
      const paths = resolveAppPaths();
      await ensureAppDirs(paths); // create the app-data dir before SQLite opens the file
      const db = await openDatabase(paths.dbPath);
      await migrate(db);
      return db;
    })());
  };

  let sessionStorePromise: Promise<SessionStore> | undefined;
  const sessions = (): Promise<SessionStore> => {
    if (opts.sessionStore) return Promise.resolve(opts.sessionStore);
    return (sessionStorePromise ??= database().then(createSessionStore));
  };

  let brandKitStorePromise: Promise<BrandKitStore> | undefined;
  const brandKits = (): Promise<BrandKitStore> => {
    if (opts.brandKitStore) return Promise.resolve(opts.brandKitStore);
    return (brandKitStorePromise ??= database().then(createBrandKitStore));
  };

  /**
   * Run `fn` with an auditor whose Chromium process lives exactly as long as
   * the turn (ADR-0005).
   *
   * A remediate turn audits up to five times — source gate, first repair, then
   * up to three re-audits — and each of those used to launch and close its own
   * browser. One browser now covers the whole turn and is disposed in the
   * `finally`. It is NOT kept warm between turns: ADR-0005 chose per-turn
   * lifetime on the measured win (five launches to one, all inside one turn).
   * The app now has a shutdown path (ADR-0006, #13), so that is no longer the
   * blocker it was — but a warm browser *between* turns was never measured,
   * and reopening the choice needs its own measurement.
   *
   * An injected `opts.audit` short-circuits the whole thing, so offline tests
   * never construct a runner. Even when one IS constructed it launches lazily —
   * a turn that never audits pays nothing, and disposing an unlaunched runner
   * is a no-op.
   */
  const withTurnAuditor = async <T>(fn: (auditor: Auditor) => Promise<T>): Promise<T> => {
    const endTurn = activity.begin();
    try {
      // `await` is load-bearing: `return fn(...)` would run the outer `finally`
      // at return time, closing the activity bracket mid-turn.
      if (opts.audit) return await fn(opts.audit);
      const runner = createPlaywrightRunner();
      try {
        return await fn(createAuditor(runner));
      } finally {
        await runner.dispose();
      }
    } finally {
      endTurn();
    }
  };

  // The orchestrator is wired identically every turn (real or injected parts).
  const buildOrchestrator = (auditor: Auditor): Orchestrator => {
    const deps = createEngineDeps({ retriever, llm, ingest, audit: auditor });
    const registry = new ToolRegistry().registerAll(createCanonicalTools(deps));
    const orchOpts: OrchestratorOptions = { maxToolIterations, retrieveKb: retriever };
    if (opts.maxCitations !== undefined) orchOpts.maxCitations = opts.maxCitations;
    return new Orchestrator(chatRunner, registry, orchOpts);
  };

  // A ToolContext whose onEvent bridges orchestrator events → contract TurnChunks.
  const streamingCtx = (onChunk?: OnTurnChunk): ToolContext => {
    if (!onChunk) return {};
    return {
      onEvent: (e) => {
        if (e.type === 'text') onChunk({ type: 'text', delta: e.delta });
        else onChunk({ type: 'tool', name: e.name });
      },
    };
  };

  // Resolve the base system prompt for a turn (request > app > per-mode).
  const baseSystemFor = (req: TurnRequest, mode: ProductMode): string =>
    req.system ?? systemPromptOverride ?? systemPromptForMode(mode);

  // Persist a turn's user+assistant messages when a session is in play. The
  // assistant message carries its gated fragments (HTML + badge/conformance +
  // remediate diff) so resuming the session restores the work product, not just
  // the prose (the fragments are never replayed into LLM history — see toChatMessage).
  const persistTurn = async (sessionId: string, user: string, view: TurnView): Promise<void> => {
    const store = await sessions();
    const assistant: SessionMessage = { role: 'assistant', content: view.text };
    if (view.fragments.length > 0) assistant.fragments = view.fragments;
    await store.appendMessages(sessionId, [{ role: 'user', content: user }, assistant]);
  };

  // ── Standard turn: guidance / build (and remediate without remediateInput) ──
  const runStandardTurn = async (
    req: TurnRequest,
    mode: ProductMode,
    auditor: Auditor,
    onChunk?: OnTurnChunk,
  ): Promise<TurnView> => {
    const orch = buildOrchestrator(auditor);
    const gateDeps = gateDepsFor(auditor);

    const input: TurnInput = { user: req.user, mode };
    const base = baseSystemFor(req, mode);
    if (base) input.system = base;

    if (req.sessionId) {
      const state = await (await sessions()).loadSession(req.sessionId);
      if (state && state.messages.length > 0) input.history = state.messages.map(toChatMessage);
    }

    const turn = await orch.handleTurn(input, streamingCtx(onChunk));

    // Unconditional, server-side gate: EVERY emitted fragment passes through
    // enforceGate — no mode bypasses it; a residual blocker withholds the badge.
    const fragments: TurnFragment[] = [];
    for (const html of extractHtmlFragments(turn)) {
      const gate = await enforceGate(html, gateDeps);
      const fragment: TurnFragment = { html: gate.html, gate };
      fragments.push(fragment);
      onChunk?.({ type: 'fragment', fragment });
    }

    const view: TurnView = {
      text: annotateProse(turn.text, turn.doneReason),
      fragments,
      toolsUsed: dedupe(turn.toolInvocations.map((i) => i.call.name)),
      iterations: turn.iterations,
      mode,
    };

    if (req.sessionId) await persistTurn(req.sessionId, req.user, view);
    return view;
  };

  // ── Remediate flow: repair user-supplied HTML; Canvas is never written to. ──
  const runRemediate = async (
    req: TurnRequest,
    auditor: Auditor,
    onChunk?: OnTurnChunk,
  ): Promise<TurnView> => {
    const orch = buildOrchestrator(auditor);
    const gateDeps = gateDepsFor(auditor);
    const ctx = streamingCtx(onChunk);
    const system = baseSystemFor(req, 'remediate');
    const sourceHtml = req.remediateInput!.sourceHtml;

    const toolNames: string[] = [];
    let iterations = 0;
    let finalText = '';
    let finalDoneReason: string | undefined;

    // One repair turn: ask the model to correct `html` given its `issues`.
    const repairOnce = async (html: string, issues: AuditIssue[]): Promise<string | undefined> => {
      const input: TurnInput = { user: remediateUserPrompt(html, issues), mode: 'remediate' };
      if (system) input.system = system;
      const turn = await orch.handleTurn(input, ctx);
      toolNames.push(...turn.toolInvocations.map((i) => i.call.name));
      iterations += turn.iterations;
      finalText = turn.text;
      finalDoneReason = turn.doneReason;
      return lastFragment(turn);
    };

    // 1) Gate the source HTML and capture its issues.
    const before = await enforceGate(sourceHtml, gateDeps);

    // 2) First repair turn → the model's HTML → gate it.
    const firstHtml = (await repairOnce(sourceHtml, gateIssues(before))) ?? sourceHtml;
    let after = await enforceGate(firstHtml, gateDeps);

    // 3) Bounded re-audit loop (max 3) while the badge is withheld and each pass
    //    still improves (clears the badge, or strictly reduces issue count).
    const MAX_REAUDITS = 3;
    for (let attempt = 0; attempt < MAX_REAUDITS && after.badgeWithheld; attempt++) {
      const prevCount = gateIssues(after).length;
      const retryHtml = await repairOnce(after.html, gateIssues(after));
      if (retryHtml === undefined) break;
      const retryGate = await enforceGate(retryHtml, gateDeps);
      const improved = !retryGate.badgeWithheld || gateIssues(retryGate).length < prevCount;
      if (!improved) break;
      after = retryGate;
    }

    // 4) Diff before→after by AuditIssue.id (fixed = present-before && absent-after).
    const afterIds = new Set(gateIssues(after).map((i) => i.id));
    const issueDiffs: IssueFix[] = uniqueById(gateIssues(before)).map((issue) => ({
      issue,
      fixed: !afterIds.has(issue.id),
    }));

    const remediateResult: RemediateResult = {
      before: sourceHtml,
      after: after.html,
      issueDiffs,
      gate: after,
    };
    const fragment: TurnFragment = { html: after.html, gate: after, remediateResult };
    onChunk?.({ type: 'fragment', fragment });

    const view: TurnView = {
      text: annotateProse(finalText, finalDoneReason),
      fragments: [fragment],
      toolsUsed: dedupe(toolNames),
      iterations,
      mode: 'remediate',
    };

    if (req.sessionId) await persistTurn(req.sessionId, req.user, view);
    return view;
  };

  return {
    async runTurn(req: TurnRequest, onChunk?: OnTurnChunk): Promise<TurnView> {
      const user = await userWithScreenshotContext(req, llm);
      const prepared: TurnRequest = { ...req, user };
      delete prepared.attachments;
      const { mode } = routeIntent(user, req.mode);
      // ONE Chromium for the whole turn, disposed when it ends (ADR-0005).
      return withTurnAuditor((auditor) =>
        mode === 'remediate' && prepared.remediateInput
          ? runRemediate(prepared, auditor, onChunk)
          : runStandardTurn(prepared, mode, auditor, onChunk),
      );
    },

    async saveCanvasAuth(auth) {
      // The token's one and only trip across the boundary → straight into the Keychain.
      await secrets.set(canvasSecretKey(auth.baseUrl), auth.token);
    },

    async importCanvas(baseUrl, courseId) {
      const result = await importer(await canvasConfigFor(baseUrl), courseId);
      // Record local provenance of this read-only import (course → last-imported
      // summary). This writes ONLY to the on-device DB; Canvas is never mutated.
      // Re-importing the same course updates the row (UPSERT on the course_id PK).
      //
      // BEST-EFFORT (robustness regression fix): the import has already completed
      // successfully by the time we get here. A provenance-write failure (locked
      // DB, disk full, migration error) must NOT throw away that completed import —
      // IPC would turn the rejection into an error envelope and the user would lose
      // a successful read-only crawl over a local bookkeeping hiccup. So the write
      // is wrapped: on failure we drop the provenance row (recoverable via an
      // idempotent re-import) and still return the import result.
      try {
        const db = await database();
        await db.run(
          `INSERT INTO canvas_imports (course_id, name, imported_at, summary_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(course_id) DO UPDATE SET
             name = excluded.name, imported_at = excluded.imported_at, summary_json = excluded.summary_json`,
          [
            result.courseId,
            result.name,
            result.importedAt,
            JSON.stringify({
              pages: result.pages,
              assignments: result.assignments,
              files: result.files,
              warnings: result.warnings,
            }),
          ],
        );
      } catch {
        // Swallow: provenance is local bookkeeping, not the import itself. (No
        // console logging in this layer by convention; the row is re-creatable.)
      }
      return result;
    },

    async convertDocument(document) {
      const filename = document.filename.trim();
      if (!filename) throw new Error('Choose a document with a filename first.');
      if (document.sizeBytes > MAX_DOCUMENT_UPLOAD_BYTES) {
        throw new Error('Choose a document under 25 MB for this first pass.');
      }
      if (typeof ingest.convert !== 'function') {
        throw new Error('Document conversion is not available in this runtime.');
      }
      const converted = await ingest.convert({
        filename,
        base64: base64FromDataUrl(document.dataUrl),
      });
      return documentConversionResult({ ...document, filename }, converted);
    },

    async health(): Promise<RuntimeHealth> {
      const { text, vision } = await requiredModelHealth(llm, configuredRequiredModels);
      const health: RuntimeHealth = {
        llm: await reachable(() => llm.isHealthy()),
        ingest: await reachable(() => ingest.isHealthy()),
        model: text,
        visionModel: vision,
      };
      // Report whether the Docling models are present so the UI can offer a
      // first-run download. Only when the runtime can answer (real sidecar).
      if (typeof ingest.modelStatus === 'function') {
        try {
          health.ingestModel = { available: (await ingest.modelStatus()).available };
        } catch {
          health.ingestModel = { available: false };
        }
      }
      return health;
    },

    async pullModel(onProgress?: OnModelPullProgress): Promise<void> {
      // First-run provisioning: download the configured model into the bundled
      // Ollama. Throws a clear error if the active runtime can't self-install
      // (e.g. an injected test double, or an externally-managed daemon shape).
      if (typeof llm.pullModel !== 'function') {
        throw new Error('In-app model download is not available in this runtime.');
      }
      await llm.pullModel(onProgress);
    },

    async pullIngestModel(onProgress?: OnModelPullProgress): Promise<void> {
      // First-run provisioning: download the Docling conversion models into the
      // per-user store. Throws a clear error if the active runtime can't
      // self-install (e.g. a test double or an externally-managed sidecar).
      if (typeof ingest.pullModel !== 'function') {
        throw new Error('In-app document-model download is not available in this runtime.');
      }
      await ingest.pullModel(onProgress);
    },

    // ── Sessions (storage-backed; the runtime persists each turn) ──
    async createSession(init) {
      return (await sessions()).createSession(init);
    },
    async listSessions() {
      return (await sessions()).listSessions();
    },
    async loadSession(sessionId) {
      return (await sessions()).loadSession(sessionId);
    },
    async deleteSession(sessionId) {
      return (await sessions()).deleteSession(sessionId);
    },

    // ── Brand kits (resolveBrandTheme is pure engine math — no LLM) ──
    async resolveBrandTheme(primary, secondary) {
      return resolveThemeFn(primary, secondary);
    },
    async listBrandKits() {
      return (await brandKits()).listBrandKits();
    },
    async saveBrandKit(kit) {
      return (await brandKits()).saveBrandKit(kit);
    },
    async deleteBrandKit(id) {
      return (await brandKits()).deleteBrandKit(id);
    },

    // ── Read-only Canvas page access (Remediate import; GET-only) ──
    async fetchCanvasPage(baseUrl, courseId, pageId) {
      return fetchPageBodyFn(await canvasConfigFor(baseUrl), courseId, pageId);
    },
    async listCanvasPages(baseUrl, courseId) {
      return listPagesFn(await canvasConfigFor(baseUrl), courseId);
    },

    async screenshotPermissionStatus() {
      return 'unknown';
    },
    async listScreenshotSources() {
      throw new Error('Screenshot capture is only available in the Electron app shell.');
    },
    async captureScreenshot() {
      throw new Error('Screenshot capture is only available in the Electron app shell.');
    },

    // ── Catalog enrichment (OPTIONAL; degrades to absent when the CLI isn't installed) ──
    async catalogAvailable() {
      return catalog.available();
    },
    async catalogSearch(query) {
      return catalog.searchCourses(query);
    },
    async catalogGet(id) {
      return catalog.getCourse(id);
    },
  };
}

/**
 * Health of BOTH required models (ADR-0009), reported per role so the UI can say
 * *which* one is missing rather than that something is.
 *
 * The per-role breakdown comes from the sidecar's probe when it has one. A
 * runtime that can only answer in aggregate — an injected double, an
 * externally-managed daemon — has that single answer applied to both configured
 * required tags; a runtime with no probe at all falls back to daemon
 * reachability. In every case both roles are reported, because a role that
 * quietly vanishes from the payload reads to the UI as "nothing missing".
 */
async function requiredModelHealth(
  llm: LlmRuntime,
  configured: ConfiguredRequiredModels,
): Promise<{ text: ModelHealth; vision: ModelHealth }> {
  const probed = await probeRequiredModels(llm, configured);
  const byRole = (role: RequiredModelRole): RequiredModelStatus =>
    probed.find((m) => m.role === role) ??
    // A probe that omitted a required role tells us nothing about it; report the
    // configured tag as missing rather than dropping it or assuming it is there.
    (() => {
      const cfg = configured.find((m) => m.role === role);
      return { role, tag: cfg?.tag ?? 'unknown', status: cfg?.required === false ? 'disabled' : 'missing' };
    })();
  const resolved = { text: byRole('text'), vision: byRole('vision') };

  // The manual-recovery path: one command covering EVERY missing required model,
  // deduplicated (both roles can be pointed at one multimodal tag, where a naive
  // list would tell the user to pull the same gigabytes twice).
  //
  // Derived from the RESOLVED roles, not from the raw probe: a role the probe
  // omitted is reported missing above, and a command that then failed to name it
  // would leave the user half-provisioned — the exact failure this exists to stop.
  //
  // ONLY the missing ones. An incapable tag is already installed, so listing it
  // in a pull command would send the user round a loop that cannot terminate
  // (ADR-0010); its recovery is a different sentence entirely.
  const missingTags = [
    ...new Set(
      Object.values(resolved)
        .filter((m) => m.status === 'missing')
        .map((m) => m.tag),
    ),
  ];
  const health = ({ role, tag, status }: RequiredModelStatus): ModelHealth => ({
    tag,
    status,
    recovery: recoveryFor(role, tag, status, missingTags),
  });
  return { text: health(resolved.text), vision: health(resolved.vision) };
}

/**
 * What the user must actually do, per state (ADR-0010).
 *
 * The states do not share a recovery, which is the reason the field stopped
 * being called `installCommand`: telling someone to pull a tag they already have
 * is worse than saying nothing, because it looks actionable and changes nothing.
 */
function recoveryFor(
  role: RequiredModelRole,
  tag: string,
  status: ModelStatusState,
  missingTags: readonly string[],
): string {
  const pulls = (tags: readonly string[]): string => tags.map((t) => `ollama pull ${t}`).join(' && ');
  switch (status) {
    case 'missing':
      // Every unsatisfied model, so following it once leaves the user fully
      // provisioned. Falls back to this model's own tag if the set is somehow
      // empty, so the field is never blank while something is wrong.
      return pulls(missingTags.length > 0 ? missingTags : [tag]);
    case 'incapable':
      return (
        `${tag} is installed but cannot do the ${role} role's job ` +
        `(needs: ${REQUIRED_ROLES[role].capabilities.join(', ')}). ` +
        `Set ${REQUIRED_ROLES[role].envVar} to a model that can — downloading ${tag} again will not help.`
      );
    case 'ready':
    case 'disabled':
      return '';
  }
}


/**
 * The required roles paired with their configured tags — what `requiredModels()`
 * returns. Named off `RequiredModelRole` rather than spelled out, so adding a
 * third required role in `src/llm/config.ts` surfaces here instead of compiling.
 */
type ConfiguredRequiredModels = ReadonlyArray<{ role: RequiredModelRole; tag: string; required: boolean }>;

/** Per-role presence of the required models, however coarsely the runtime can answer. */
async function probeRequiredModels(
  llm: LlmRuntime,
  configured: ConfiguredRequiredModels,
): Promise<RequiredModelStatus[]> {
  // A runtime that can only answer in aggregate knows nothing about capability,
  // so its coarse answer maps to the two states presence alone can justify.
  // A role this configuration does not require is `disabled` whatever the daemon
  // says — reachability cannot make a switched-off capability missing.
  const spread = (ok: boolean) =>
    configured.map(({ role, tag, required }) => ({
      role,
      tag,
      status: (!required ? 'disabled' : ok ? 'ready' : 'missing') as ModelStatusState,
    }));
  if (typeof llm.modelStatus !== 'function') {
    return spread(await reachable(() => llm.isHealthy()));
  }
  try {
    const status = await llm.modelStatus();
    // Prefer the probe's own per-role answer: those are the tags it actually
    // looked for. Only fall back to the configured set when it has none.
    return status.models?.length ? [...status.models] : spread(status.ready);
  } catch {
    return spread(false);
  }
}
