/**
 * Orchestrator — public surface.
 *
 * Drives a turn: prompt assembly → bounded tool loop → (for emitted HTML) the
 * unconditional allowlist + accessibility gate. Sits on top of the local LLM
 * sidecar; the gate, not the model, guarantees safety (PRD §13/§15).
 */
export { Orchestrator, OrchestratorError } from './orchestrator.js';
export type { OrchestratorOptions } from './orchestrator.js';
export { ToolRegistry } from './registry.js';
export { createCanonicalTools, NotImplementedError } from './tools.js';
export type { EngineDeps } from './tools.js';
export { enforceGate } from './gate.js';
export { groundSystemPrompt, DEFAULT_MAX_CITATIONS } from './prompt.js';
export type { GroundingOptions } from './prompt.js';
export { routeIntent } from './router.js';
export type { IntentDecision } from './router.js';
export {
  SYSTEM_PROMPT_BY_MODE,
  TOOLS_BY_MODE,
  KB_PACKS_BY_MODE,
  systemPromptForMode,
  toolsForMode,
  packsForMode,
} from './modes.js';
export type {
  GateDeps,
  GateResult,
  Conformance,
  AuditIssue,
  IssueSet,
  AllowlistResult,
  Severity,
} from './gate.js';
export type {
  Tool,
  ToolContext,
  ChatRunner,
  TurnInput,
  TurnResult,
  ToolInvocation,
  OrchestratorEvent,
} from './types.js';
