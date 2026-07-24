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
  /**
   * Directory for the Docling conversion models (layout, TableFormer, OCR,
   * code/formula, picture-classifier + the Granite-Docling VLM). NOT bundled in
   * the app — downloaded here on first run, then served fully offline
   * (`DOCLING_SERVE_ARTIFACTS_PATH`). Empty until the first-run download.
   */
  modelsDir: string;
  /**
   * Writable home for the bundled catalog CLI (`laccd-courses-pp-cli --home`).
   * Holds the copied-once seed DB (`data/data.db`) so the read-only bundled
   * seed is never opened read-write in place. Packaged app only.
   */
  catalogHomeDir: string;
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

// ── Canvas publish (OPT-IN write path via the EXTERNAL canvas-pp-cli; PRD §17) ──
// The in-app Canvas client stays GET-only by construction. Publishing shells out
// to the separately installed `canvas-pp-cli` binary, and only when every
// guardrail holds: CLI present, settings toggle on, per-page confirm in the UI,
// and the runtime re-runs the accessibility gate on the exact HTML — a withheld
// badge refuses the publish.

/** Whether the publish path is currently offered (both must be true). */
export interface CanvasPublishStatus {
  /** True iff the local `canvas-pp-cli` binary is installed and runnable. */
  cliAvailable: boolean;
  /** The user's persisted "Allow publishing to Canvas" setting (default false). */
  publishEnabled: boolean;
}

/** Audit receipt for one successful publish; also persisted on-device. */
export interface CanvasPublishReceipt {
  courseId: string;
  pageId: string;
  /** SHA-256 (hex) of the exact HTML that was published. */
  contentHash: string;
  /** ISO timestamp of the publish. */
  publishedAt: string;
  /** The Canvas page URL, for "view what changed". */
  canvasUrl: string;
}

// ── Catalog enrichment (catalog track; consumes the laccd-courses-pp-cli binary) ─
// OPTIONAL enrichment source (see src/catalog/README.md): degrades to absent
// when the CLI isn't installed, and a search/get call may go live to the
// public eLumen API when the CLI's local mirror is empty — a user-initiated
// network call, the same category as the opt-in Canvas import above.

/** One catalog search-result row — enough to let a user pick a course before fetching detail. */
export interface CatalogCourseSummary {
  /** Numeric eLumen catalog id (parsed from `_links.self.href`, e.g. "/public/courses/38409"). */
  id: number;
  /** Subject + course number code, e.g. "ACCTG001". */
  code: string;
  /** Course title. Empty string if the CLI response omitted `name`. */
  title: string;
  /** The eLumen tenant host that owns this catalog entry, e.g. "wlac.elumenapp.com". */
  college?: string;
}

/** A single course's enrichment detail: units, description, SLOs, objectives. */
export interface CatalogCourse {
  id: number;
  code: string;
  title: string;
  college?: string;
  /** Credit units for the course's default/first credit profile, when present. */
  units?: number;
  description?: string;
  /** Course Student Learning Outcomes (the CLI's `outcomeLevel === "CSLO"` rows). */
  slos: string[];
  /** Course objectives, in their authored sequence order. */
  objectives: string[];
  /** `'live'` = a real-time public eLumen API call; `'mirror'` = the CLI's local synced mirror. */
  source: 'live' | 'mirror';
}

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
  /**
   * Gated HTML fragments produced on this turn (assistant messages only).
   * Persisted so resuming a session restores the actual work product — the
   * Canvas-safe HTML, its badge/conformance, and (in remediate) the before/after
   * diff — not just the prose. NEVER replayed into LLM history (that is
   * role+content only), so it can't pollute the model context.
   */
  fragments?: TurnFragment[];
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

/** A user-picked document sent once to the local Docling sidecar for conversion. */
export interface UploadedDocument {
  filename: string;
  mime: string;
  sizeBytes: number;
  /** Browser data URL; runtime strips this to raw base64 and does not persist it. */
  dataUrl: string;
}

/** Normalized document conversion result for the renderer/remediation flow. */
export interface DocumentConversionResult {
  filename: string;
  status: string;
  processingTimeMs: number;
  /** Prefer this when present; it goes through the same remediation gate. */
  html?: string;
  /** Markdown/text fallbacks when Docling cannot return HTML. */
  markdown?: string;
  text?: string;
}

/** A one-time, user-initiated screenshot attachment for a turn. */
export interface ScreenshotAttachment {
  id: string;
  kind: 'screenshot';
  mime: 'image/png';
  /** PNG data URL captured locally; runtime summarizes it and does not persist it. */
  dataUrl: string;
  /** User-facing screen/window label. */
  label: string;
  capturedAt: string;
}

/** A screen/window source the Electron shell can capture. */
export interface ScreenshotSource {
  id: string;
  kind: 'screen' | 'window';
  label: string;
  thumbnailDataUrl: string;
}

/** macOS screen-recording permission state, mirrored from Electron. */
export type ScreenshotPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

/** A streamed turn event. Bridged to the renderer over IPC (design §4.4). */
export type TurnChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'fragment'; fragment: TurnFragment };

/** In-process streaming callback passed to AppApi.runTurn. */
export type OnTurnChunk = (chunk: TurnChunk) => void;

/**
 * Progress of an in-app model download (mirrors the LLM sidecar's `PullProgress`).
 * `completed`/`total` are bytes for the layer currently transferring; `percent`
 * is derived [0..100] when both are known.
 */
export interface ModelPullProgress {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
  /** For the Docling pull, the model currently downloading (e.g. 'granite_docling'). */
  model?: string;
}

/** In-process streaming callback passed to AppApi.pullModel. */
export type OnModelPullProgress = (progress: ModelPullProgress) => void;

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
  /** User-supplied, local-only screenshots that should inform this turn. */
  attachments?: ScreenshotAttachment[];
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
export interface ModelHealth {
  tag: string;
  available: boolean;
  installCommand: string;
}

export interface RuntimeHealth {
  llm: boolean;
  ingest: boolean;
  /** Local Ollama model tag selected for text turns, plus availability. */
  model?: ModelHealth;
  /**
   * Whether the Docling conversion models are present. Office/web docs convert
   * without them; PDFs and scanned images need them, so the UI offers a
   * first-run download when `available` is false. Absent when the runtime can't
   * report it (e.g. an externally-managed sidecar).
   */
  ingestModel?: { available: boolean };
}

/** The single surface the Electron main process exposes to the renderer via IPC. */
export interface AppApi {
  /** Run a turn; `onChunk` (optional) receives streamed text/tool/fragment events. */
  runTurn(req: TurnRequest, onChunk?: OnTurnChunk): Promise<TurnView>;
  /**
   * Store Canvas credentials in the OS secret store (macOS Keychain). The token
   * crosses the IPC boundary HERE and only here; it is never persisted in the DB
   * and never returned to or re-sent by the renderer. Read calls below take only
   * the `baseUrl` — the runtime resolves the token from the Keychain.
   */
  saveCanvasAuth(auth: CanvasConfig): Promise<void>;
  importCanvas(baseUrl: string, courseId: string): Promise<CanvasImportResult>;
  health(): Promise<RuntimeHealth>;
  /**
   * Download the configured local model into the bundled Ollama, streaming
   * progress to `onProgress`. Resolves once the model is present; rejects on
   * failure. Used by first-run setup when `health().model.available` is false.
   */
  pullModel(onProgress?: OnModelPullProgress): Promise<void>;
  /**
   * Download the Docling conversion models (layout, TableFormer, OCR,
   * code/formula, picture-classifier + the Granite-Docling VLM) into the
   * per-user store, streaming progress to `onProgress`. No-op if already present.
   * Used by first-run setup when `health().ingestModel.available` is false.
   * Rejects outside the packaged app (no bundled Python) or on a download error.
   */
  pullIngestModel(onProgress?: OnModelPullProgress): Promise<void>;

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
  // Token-free: pass only the Canvas base URL; the runtime reads the saved token
  // from the Keychain (see `saveCanvasAuth`), so no secret transits the renderer.
  fetchCanvasPage(baseUrl: string, courseId: string, pageId: string): Promise<string>;
  listCanvasPages(baseUrl: string, courseId: string): Promise<CanvasPage[]>;

  // ── Canvas publish (OPT-IN; via the EXTERNAL canvas-pp-cli — see CanvasPublishStatus) ──
  /** Current publish availability (CLI presence + persisted toggle). Never rejects. */
  canvasPublishStatus(): Promise<CanvasPublishStatus>;
  /** Persist the "Allow publishing to Canvas" toggle. */
  setCanvasPublishEnabled(enabled: boolean): Promise<void>;
  /**
   * Publish gate-passing HTML back to a Canvas page via the external CLI.
   * The runtime re-runs the accessibility gate on `html` and REFUSES to publish
   * when the badge would be withheld. `baseUrl` must match the CLI's configured
   * Canvas host (checked via `canvas-pp-cli doctor`) so a stale app setting can
   * never push to a different Canvas than the one the page was imported from.
   * Rejects when the toggle is off or the CLI is missing.
   */
  publishCanvasPage(baseUrl: string, courseId: string, pageId: string, html: string): Promise<CanvasPublishReceipt>;

  // ── Catalog enrichment (OPTIONAL; degrades to absent when the CLI isn't installed) ──
  /** True iff the local `laccd-courses-pp-cli` binary is installed and runnable. Never rejects. */
  catalogAvailable(): Promise<boolean>;
  /** Search the LACCD eLumen catalog by free-text query. */
  catalogSearch(query: string): Promise<CatalogCourseSummary[]>;
  /** Fetch one course's full enrichment detail (units, description, SLOs, objectives) by numeric id. */
  catalogGet(id: number): Promise<CatalogCourse>;

  // ── Local document conversion (Docling sidecar; raw bytes are transient) ──
  convertDocument(document: UploadedDocument): Promise<DocumentConversionResult>;

  // ── One-time screenshot capture (Electron shell; raw pixels stay local/transient) ──
  screenshotPermissionStatus(): Promise<ScreenshotPermissionStatus>;
  listScreenshotSources(): Promise<ScreenshotSource[]>;
  captureScreenshot(sourceId: string): Promise<ScreenshotAttachment>;
}
