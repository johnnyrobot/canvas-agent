/**
 * FROZEN CROSS-TRACK CONTRACTS — the single source of truth for every interface
 * that crosses a track boundary in the parallel build.
 *
 * RULES FOR ALL AGENTS:
 *  1. Import shared types ONLY from `src/contracts` (this file). Never redefine
 *     a type that lives here, and never reach into another track's directory.
 *  2. Your track owns exactly one `src/<dir>`. Implement the port(s) assigned to
 *     you so their *signatures* match what is declared here. Internals are yours.
 *  3. Talk to other tracks through the function-type ports / interfaces below
 *     (dependency injection), never through concrete imports of their code.
 *  4. These signatures are FROZEN. If you believe one is wrong, STOP and write
 *     the reason to `.agent-status` as `BLOCKED: <reason>` — do not silently
 *     diverge. A divergent signature breaks auto-merge.
 *
 * The gate types are re-exported from the existing, tested orchestrator gate so
 * there is one canonical definition (the orchestrator track owns gate.ts).
 */

// ── Gate / audit (canonical defs live in orchestrator/gate.ts) ───────────────
export type {
  Severity,
  AuditIssue,
  IssueSet,
  AllowlistResult,
  GateDeps,
  Conformance,
  GateResult,
} from '../orchestrator/gate.js';

// Local import for use in the port aliases below.
import type { AllowlistResult, IssueSet } from '../orchestrator/gate.js';

// ── Contrast (engine-core: WCAG math; consumed by theme + templates) ─────────

/** WCAG text-size class. "large" = ≥18pt, or ≥14pt bold. */
export type TextSize = 'normal' | 'large';

/** Shared WCAG 2.2 contrast thresholds. Both engine-core and theme MUST use these. */
export const WCAG = {
  AA_NORMAL: 4.5,
  AA_LARGE: 3.0,
  AAA_NORMAL: 7.0,
  AAA_LARGE: 4.5,
} as const;

export interface ContrastResult {
  /** Contrast ratio, 1.0–21.0, rounded to 2 dp. */
  ratio: number;
  /** Highest WCAG level the pair satisfies at the given size. */
  level: 'AAA' | 'AA' | 'fail';
  passesAA: boolean;
  passesAAA: boolean;
  /** The size class the ratio was evaluated against. */
  size: TextSize;
}

/** Pure WCAG contrast checker. fg/bg are CSS colors (#rgb, #rrggbb, rgb(...), named). */
export type ContrastChecker = (fg: string, bg: string, size?: TextSize) => ContrastResult;

// ── Allowlist / audit ports (engine-core = allowlist; engine-render = audit) ──

/** Deterministic Canvas allowlist gate + safe repair (PRD Appendix B). */
export type AllowlistValidator = (html: string) => Promise<AllowlistResult>;

/** Deterministic render-and-scan accessibility audit (PRD §8). */
export type Auditor = (html: string) => Promise<IssueSet>;

// ── Theme (theme track; consumes ContrastChecker) ────────────────────────────

/** Canvas brand-color roles a theme can resolve foregrounds for. */
export type ThemeRole = string;

export interface ResolvedColor {
  /** The role/slot name (e.g. "heading", "accent", "button-bg"). */
  role: ThemeRole;
  /** Background color for this role (CSS color). */
  background: string;
  /** An accessible foreground chosen for `background` (CSS color). */
  foreground: string;
  contrast: ContrastResult;
}

export interface ThemeResult {
  /** Resolved, contrast-safe color assignments per requested role. */
  colors: ResolvedColor[];
  /** Human-readable warnings (e.g. "brand color too low-contrast; darkened"). */
  warnings: string[];
}

/** Resolve accessible foregrounds for a 2-color brand palette across roles. */
export type ThemeResolver = (
  color1: string,
  color2: string,
  roles?: ThemeRole[],
) => Promise<ThemeResult>;

// ── Templates (templates track; consumes ThemeResult + AllowlistValidator) ───

/** The eight canonical Canvas templates (PRD §15.3). */
export type TemplateType =
  | 'syllabus'
  | 'module-overview'
  | 'assignment'
  | 'discussion'
  | 'page-content'
  | 'lecture-notes'
  | 'study-guide'
  | 'rubric';

/** Slot content passed into a template (shape validated per-template internally). */
export type TemplateSlots = Record<string, unknown>;

export interface TemplateResult {
  /** Canvas-safe, allowlist-passing HTML fragment. */
  html: string;
  type: TemplateType;
  /** Non-fatal notes (e.g. "no summary slot provided; omitted section"). */
  warnings: string[];
}

/** Fill one of the eight templates with slots + an optional resolved theme. */
export type TemplateRenderer = (
  type: TemplateType,
  slots: TemplateSlots,
  theme?: ThemeResult,
) => Promise<TemplateResult>;

// ── Storage ports (storage track; consumed by knowledge + canvas) ────────────

/**
 * Minimal SQL execution port. Storage provides a concrete implementation
 * (SQLite); knowledge/canvas depend only on this interface (and use an
 * in-memory fake in their own unit tests). Sync or async are both allowed.
 */
export interface Database {
  exec(sql: string): void | Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[] | Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined | Promise<T | undefined>;
  run(sql: string, params?: readonly unknown[]): { changes: number } | Promise<{ changes: number }>;
  close(): void | Promise<void>;
}

/** Open the app's SQLite database at `path` (":memory:" for tests). */
export type OpenDatabase = (path: string) => Database | Promise<Database>;

/** Secret store backed by the macOS Keychain (Canvas token, etc.). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Resolved local-file layout for the single-user app (PRD v1.6). */
export interface AppPaths {
  /** Root app-data dir (e.g. ~/Library/Application Support/CanvasAgent). */
  dataDir: string;
  /** SQLite database file path. */
  dbPath: string;
  /** Directory for user uploads / ingested sources. */
  uploadsDir: string;
  /** Directory for local exports. */
  exportsDir: string;
}

// ── Knowledge (knowledge track; consumes Database) ───────────────────────────

/** One retrieved, citable snippet from a Knowledge Pack. */
export interface KbHit {
  id: string;
  packId: string;
  title: string;
  /** The matched text snippet (for grounding the model). */
  snippet: string;
  /** Lexical relevance score (BM25/FTS5); higher is better. */
  score: number;
  /** Stable citation string the model can surface (PRD §13.1). */
  citation: string;
}

export interface KbResult {
  hits: KbHit[];
}

/** Lexical/structured retrieval over intent-scoped packs (NO embeddings in v1). */
export type KbRetriever = (query: string, packs?: string[]) => Promise<KbResult>;

// ── Canvas read-only import (canvas track; consumes Database/SecretStore) ─────

export interface CanvasConfig {
  /** Canvas base URL, e.g. https://school.instructure.com. */
  baseUrl: string;
  /** Access token (retrieved from SecretStore — never persisted in the DB). */
  token: string;
}

/** Summary of a read-only import (PRD §17). The source is never modified. */
export interface CanvasImportResult {
  courseId: string;
  name: string;
  importedAt: string;
  pages: number;
  assignments: number;
  files: number;
  warnings: string[];
}

/** Read-only Canvas importer. MUST perform no write/mutation calls. */
export type CanvasImporter = (config: CanvasConfig, courseId: string) => Promise<CanvasImportResult>;

// ── Aggregate engine capabilities (integration wires these into EngineDeps) ──

/**
 * The real, tightened capability set the deterministic engine + sibling tracks
 * provide. The integration track (Wave 3) adapts this onto the orchestrator's
 * `EngineDeps`/`GateDeps` and into `createCanonicalTools`.
 */
export interface EngineCapabilities {
  validateAllowlist: AllowlistValidator;
  audit: Auditor;
  checkContrast: ContrastChecker;
  resolveTheme: ThemeResolver;
  renderTemplate: TemplateRenderer;
  retrieveKb: KbRetriever;
}

// ── App runtime boundary (Wave 3) ────────────────────────────────────────────
// The integration track IMPLEMENTS `AppApi` (orchestrator + gate + sidecars +
// the engine capabilities, all wired). The app-shell track CONSUMES `AppApi`
// over Electron IPC and builds its UI against these types — it uses a fake
// `AppApi` in its own tests so it never needs the real runtime to build.

import type { GateResult, AuditIssue } from '../orchestrator/gate.js';

// ── Product layer (modes, router, remediate, sessions, brand-kit) ────────────
// Everything below is ADDITIVE: new optional fields, new types, and new AppApi
// methods. No existing field or signature changes shape, so every current caller
// and test keeps compiling. Design: docs/superpowers/specs/2026-06-04-product-layer-design.md.

/** The three product modes. Omitted on a request ⇒ the intent router decides. */
export type ProductMode = 'guidance' | 'build' | 'remediate';

/** Remediate input: HTML to repair (+ optional read-only Canvas provenance). */
export interface RemediateInput {
  sourceHtml: string;
  /** Provenance only; never used to write back (Canvas stays GET-only). */
  canvasPageRef?: { courseId: string; pageId: string };
}

/** One issue's before→after resolution in a remediate pass. */
export interface IssueFix {
  issue: AuditIssue;
  fixed: boolean;
}

/** Structured remediate output: before/after HTML + per-issue diff + the gate. */
export interface RemediateResult {
  before: string;
  after: string;
  issueDiffs: IssueFix[];
  gate: GateResult;
}

/** A persisted chat message (decoupled from llm's ChatMessage). */
export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

/** A saved working session. */
export interface Session {
  id: string;
  title: string;
  mode: ProductMode;
  createdAt: string;
  updatedAt: string;
}

/** A session plus its resumable transcript. */
export interface SessionState {
  session: Session;
  messages: SessionMessage[];
}

/** A persisted brand kit: a two-colour palette (+ optional fonts) for theming. */
export interface BrandKit {
  id: string;
  name: string;
  palette: { primary: string; secondary: string };
  fonts?: { heading?: string; body?: string; mono?: string };
  createdAt: string;
}

/** A read-only Canvas page descriptor (Remediate import source). */
export interface CanvasPage {
  id: string;
  title: string;
  url?: string;
  updatedAt?: string;
}

/** A streamed turn event. Bridged to the renderer over IPC (design §4.4). */
export type TurnChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'fragment'; fragment: TurnFragment };

/** In-process streaming callback passed to AppApi.runTurn. */
export type OnTurnChunk = (chunk: TurnChunk) => void;

export interface TurnRequest {
  /** The user's message for this turn. */
  user: string;
  /** Optional system prompt override (else the runtime assembles one). */
  system?: string;
  /** Session to continue (the runtime persists/loads via the storage track). */
  sessionId?: string;
  /** Explicit mode override; when absent the intent router classifies. */
  mode?: ProductMode;
  /** Remediate input; honored only when the resolved mode is 'remediate'. */
  remediateInput?: RemediateInput;
}

/** A gated, safe-to-render HTML fragment produced during a turn. */
export interface TurnFragment {
  html: string;
  gate: GateResult;
  /** Populated only in remediate mode: before/after + per-issue diff. */
  remediateResult?: RemediateResult;
}

/** What the UI renders after a turn (a view over the orchestrator's TurnResult). */
export interface TurnView {
  text: string;
  /** Gated HTML fragments emitted this turn (each already through `enforceGate`). */
  fragments: TurnFragment[];
  /** Canonical tool names the model invoked. */
  toolsUsed: string[];
  iterations: number;
  /** The mode the router/override resolved to for this turn. */
  mode?: ProductMode;
}

/** Health of the local sidecars (for a UI status indicator). */
export interface RuntimeHealth {
  llm: boolean;
  ingest: boolean;
}

/** The single surface the Electron main process exposes to the renderer via IPC. */
export interface AppApi {
  /** Run a turn; `onChunk` (optional) receives streamed text/tool/fragment events. */
  runTurn(req: TurnRequest, onChunk?: OnTurnChunk): Promise<TurnView>;
  importCanvas(config: CanvasConfig, courseId: string): Promise<CanvasImportResult>;
  health(): Promise<RuntimeHealth>;

  // ── Sessions (storage-backed; the runtime persists each turn) ──
  createSession(init: { title: string; mode: ProductMode }): Promise<Session>;
  listSessions(): Promise<Session[]>;
  loadSession(sessionId: string): Promise<SessionState | null>;
  deleteSession(sessionId: string): Promise<void>;

  // ── Brand kits (resolveBrandTheme is pure engine math — no LLM) ──
  resolveBrandTheme(primary: string, secondary: string): Promise<ThemeResult>;
  listBrandKits(): Promise<BrandKit[]>;
  saveBrandKit(kit: Omit<BrandKit, 'id' | 'createdAt'>): Promise<BrandKit>;
  deleteBrandKit(id: string): Promise<void>;

  // ── Read-only Canvas page access (Remediate import; GET-only) ──
  fetchCanvasPage(config: CanvasConfig, courseId: string, pageId: string): Promise<string>;
  listCanvasPages(config: CanvasConfig, courseId: string): Promise<CanvasPage[]>;
}
