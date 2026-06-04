# `src/orchestrator` — turn handling, tool dispatch & the output gate

Sits on top of the LLM sidecar (`src/llm`). It assembles a turn, lets the local
model call **server-side tools**, dispatches them deterministically in a
**bounded loop**, and (for emitted HTML) runs the **unconditional allowlist +
accessibility gate**. The gate — not the model — guarantees safety (PRD §13/§15).

## Layout

| File | Responsibility |
|---|---|
| `types.ts` | `Tool`, `ChatRunner`, `TurnInput/TurnResult` |
| `registry.ts` | `ToolRegistry` (register / advertise definitions) |
| `tools.ts` | Canonical tools (PRD §15.3) via DI — engine tools stub until `/src/engine` exists |
| `gate.ts` | `enforceGate()` — allowlist + audit; a blocker withholds the badge (`A11Y_FAIL_OPEN=false`) |
| `orchestrator.ts` | `Orchestrator.handleTurn()` — prompt + bounded tool loop |
| `*.test.ts` | Unit tests (mock runner + mock tools; fully offline) |

## Usage

```ts
import { createOllamaSidecar } from '../llm/index.js';
import { createDoclingSidecar } from '../ingest/index.js';
import { Orchestrator, ToolRegistry, createCanonicalTools, enforceGate } from './index.js';

const llm = createOllamaSidecar();
const docling = createDoclingSidecar();
await Promise.all([llm.start(), docling.start()]);

// describe_image + ingest_document are wired to the sidecars; engine tools land later.
const registry = new ToolRegistry().registerAll(createCanonicalTools({
  describeImage: (a) => llm.describeImage(a).then((r) => r.content),
  ingestDocument: (ref) => docling.convertPath(ref),
  // auditHtml, validateAllowlist, resolveTheme, renderTemplate, retrieveKb → from /src/engine (TODO)
}));

const orch = new Orchestrator(llm, registry, { maxToolIterations: 5 });
const turn = await orch.handleTurn({ system: SYSTEM_PROMPT, user: 'How do I make a table accessible?' });

// Build/Remediate flows ALWAYS finalize emitted HTML through the gate before showing it:
const gated = await enforceGate(generatedHtml, {
  validateAllowlist: engine.validateAllowlist,
  audit: engine.audit,
});
if (gated.badgeWithheld) { /* show blockers, withhold "passed checks" */ }
```

## Design notes

- **The gate is unconditional and server-side.** Even though tools exist for the
  model's reasoning, `enforceGate` runs the allowlist + audit regardless of model
  output, and a residual blocker withholds the conformant badge. Model output is
  never trusted (PRD §15.3/§15.7/§8.6).
- **Bounded loop.** `handleTurn` caps model round-trips (`maxToolIterations`) and
  throws `OrchestratorError` rather than looping forever (PRD §13.3).
- **DI everywhere.** The runner, tools, and gate deps are injected, so the whole
  module is unit-testable with mocks (no Ollama / engine needed).

## Scaffold status / TODO

- ✅ Registry, gate logic, and the tool loop are unit-tested with mocks.
- ⬜ Engine tools (`audit_html`, `validate_allowlist`, `check_contrast`,
  `resolve_theme`, `render_template`, `retrieve_kb`) — wire to `/src/engine`,
  `/src/theme`, `/src/templates`, `/src/knowledge` as they're built.
- ⬜ Prompt assembly from Knowledge Packs (PRD §15.2) — currently a passthrough.
- ⬜ Streaming turn variant (token stream to the chat UI).
- ⬜ Map `TurnResult` + `GateResult` into the API payloads (PRD §19).
