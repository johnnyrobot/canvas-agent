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
} from './types.js';
