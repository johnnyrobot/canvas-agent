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
import { audit as renderAudit } from '../engine/render/index.js';
import { createRetriever } from '../knowledge/index.js';
import { importCourse, fetchPageBody as defaultFetchPageBody, listPages as defaultListPages } from '../canvas/index.js';
import type { PageReader } from '../canvas/index.js';
import { resolveTheme as defaultResolveTheme } from '../theme/index.js';
import { createOllamaSidecar } from '../llm/index.js';
import type { ChatMessage, OllamaSidecar } from '../llm/index.js';
import { createDoclingSidecar } from '../ingest/index.js';
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
  SecretStore,
  GateDeps,
  GateResult,
  IssueFix,
  KbRetriever,
  OnTurnChunk,
  ProductMode,
  RemediateResult,
  RuntimeHealth,
  SessionMessage,
  ThemeResolver,
  TurnFragment,
  TurnRequest,
  TurnView,
} from '../contracts/index.js';

/** LLM capability the runtime needs: vision drafting + a health probe. */
export interface LlmRuntime extends LlmDescriber {
  isHealthy(): Promise<boolean>;
}

/** Docling capability the runtime needs: conversion + a health probe. */
export interface IngestRuntime extends DocConverter {
  isHealthy(): Promise<boolean>;
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
  const auditor: Auditor = opts.audit ?? renderAudit;
  const importer: CanvasImporter = opts.importer ?? importCourse;
  const gateDeps: GateDeps = opts.gate ?? { validateAllowlist, audit: auditor };
  const maxToolIterations = opts.maxToolIterations ?? 5;
  const systemPromptOverride = opts.systemPrompt;
  const resolveThemeFn: ThemeResolver = opts.resolveTheme ?? defaultResolveTheme;
  const fetchPageBodyFn: PageReader['fetchPageBody'] = opts.fetchPageBody ?? defaultFetchPageBody;
  const listPagesFn: PageReader['listPages'] = opts.listPages ?? defaultListPages;
  const secrets: SecretStore = opts.secrets ?? createKeychainSecretStore();

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

  // The orchestrator is wired identically every turn (real or injected parts).
  const buildOrchestrator = (): Orchestrator => {
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
    onChunk?: OnTurnChunk,
  ): Promise<TurnView> => {
    const orch = buildOrchestrator();

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
  const runRemediate = async (req: TurnRequest, onChunk?: OnTurnChunk): Promise<TurnView> => {
    const orch = buildOrchestrator();
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
      const { mode } = routeIntent(req.user, req.mode);
      if (mode === 'remediate' && req.remediateInput) return runRemediate(req, onChunk);
      return runStandardTurn(req, mode, onChunk);
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

    async health(): Promise<RuntimeHealth> {
      return {
        llm: await reachable(() => llm.isHealthy()),
        ingest: await reachable(() => ingest.isHealthy()),
      };
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
  };
}
