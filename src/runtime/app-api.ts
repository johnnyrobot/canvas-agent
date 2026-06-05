/**
 * `createAppApi` — the runtime keystone. Implements the FROZEN `AppApi`
 * (`src/contracts`): one turn pipeline (scripted-or-real model → real tools →
 * the unconditional output gate), the read-only Canvas importer, and a
 * best-effort sidecar health probe. The Electron app-shell track consumes this
 * surface over IPC and uses a fake `AppApi` in its own tests.
 *
 * Everything is injectable so `npm test` runs fully offline: a scripted
 * `chatRunner`, fake sidecars, a scripted retriever, and an in-process auditor —
 * but the REAL engine (allowlist + contrast), theme, templates, knowledge, and
 * gate. The defaults wire the real model + sidecars for production.
 */
import { validateAllowlist } from '../engine/index.js';
import { audit as renderAudit } from '../engine/render/index.js';
import { createRetriever } from '../knowledge/index.js';
import { importCourse } from '../canvas/index.js';
import { createOllamaSidecar } from '../llm/index.js';
import type { OllamaSidecar } from '../llm/index.js';
import { createDoclingSidecar } from '../ingest/index.js';
import {
  Orchestrator,
  ToolRegistry,
  createCanonicalTools,
  enforceGate,
} from '../orchestrator/index.js';
import type { ChatRunner, OrchestratorOptions, TurnInput, TurnResult } from '../orchestrator/index.js';
import {
  createEngineDeps,
  runtimeLlmEnv,
  type DocConverter,
  type LlmDescriber,
  type RuntimeEnv,
} from './deps.js';
import type {
  AppApi,
  Auditor,
  CanvasImporter,
  Database,
  GateDeps,
  KbRetriever,
  RuntimeHealth,
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
  /** Base system prompt (hard rules). Default: `DEFAULT_SYSTEM_PROMPT`. */
  systemPrompt?: string;
  /** Env override for the default LLM sidecar (model selection). */
  llmEnv?: RuntimeEnv;
  /** Reserved for session persistence (PRD §19); unused by the v1 turn pipeline. */
  db?: Database;
}

/**
 * The runtime's hard-rule system prompt (PRD §15). Knowledge-Pack citations are
 * prepended above this at turn time; the server-side gate — not the model — is
 * the authority on whether output is Canvas-safe and accessible.
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

/**
 * Throwing scaffold for the product-layer AppApi methods introduced by the
 * contract freeze. The runtime-spine (Wave 1) track replaces each with a real
 * implementation; until then no caller — tests included — invokes these.
 */
function notWired(method: string): never {
  throw new Error(`AppApi.${method} is not wired yet (contract-freeze scaffold).`);
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
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  return {
    async runTurn(req: TurnRequest): Promise<TurnView> {
      const deps = createEngineDeps({ retriever, llm, ingest, audit: auditor });
      const registry = new ToolRegistry().registerAll(createCanonicalTools(deps));

      const orchOpts: OrchestratorOptions = { maxToolIterations, retrieveKb: retriever };
      if (opts.maxCitations !== undefined) orchOpts.maxCitations = opts.maxCitations;
      const orch = new Orchestrator(chatRunner, registry, orchOpts);

      const input: TurnInput = { user: req.user };
      const base = req.system ?? systemPrompt;
      if (base) input.system = base;

      const turn = await orch.handleTurn(input);

      const fragments: TurnFragment[] = [];
      for (const html of extractHtmlFragments(turn)) {
        const gate = await enforceGate(html, gateDeps);
        fragments.push({ html: gate.html, gate });
      }

      return {
        text: turn.text,
        fragments,
        toolsUsed: dedupe(turn.toolInvocations.map((i) => i.call.name)),
        iterations: turn.iterations,
      };
    },

    importCanvas(config, courseId) {
      return importer(config, courseId);
    },

    async health(): Promise<RuntimeHealth> {
      return {
        llm: await reachable(() => llm.isHealthy()),
        ingest: await reachable(() => ingest.isHealthy()),
      };
    },

    // ── Product-layer surface (scaffolded; Wave 1 runtime-spine implements) ──
    async listSessions() {
      return notWired('listSessions');
    },
    async loadSession() {
      return notWired('loadSession');
    },
    async deleteSession() {
      return notWired('deleteSession');
    },
    async resolveBrandTheme() {
      return notWired('resolveBrandTheme');
    },
    async listBrandKits() {
      return notWired('listBrandKits');
    },
    async saveBrandKit() {
      return notWired('saveBrandKit');
    },
    async deleteBrandKit() {
      return notWired('deleteBrandKit');
    },
    async fetchCanvasPage() {
      return notWired('fetchCanvasPage');
    },
    async listCanvasPages() {
      return notWired('listCanvasPages');
    },
  };
}
