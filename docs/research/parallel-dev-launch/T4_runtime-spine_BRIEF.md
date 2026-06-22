# Track: runtime-spine (Wave 1, T4 — integration; launched AFTER T1–T3 merge)

You are an autonomous build agent. Execute this brief **completely and without asking questions**. Match existing code style and finish.

## Context
`canvas-agent`, on-device Canvas a11y assistant. TS ESM strict, `node:test`+`tsx`, zero deps, **DI everywhere**. The frozen contract is at `src/contracts/index.ts` (read the product-layer types + the expanded `AppApi`). Waves T1–T3 are already merged into your base branch, so you can import their real exports. READ these before coding:
- `src/orchestrator/index.js` → `routeIntent`, `systemPromptForMode`, `toolsForMode`, `packsForMode`, `SYSTEM_PROMPT_BY_MODE`; `ChatRunner.chatStream?`; `TurnInput.mode`/`TurnInput.history`; `ToolContext.mode`/`ToolContext.onEvent` + `OrchestratorEvent`.
- `src/storage/index.js` → `createSessionStore`, `SessionStore`, `createBrandKitStore`, `BrandKitStore`, and how a real `Database` is opened (`openDatabase`/paths/`migrate` — read storage to see exactly).
- `src/canvas/index.js` → `fetchPageBody`, `listPages`.
- `src/theme/index.js` → `resolveTheme` (for `resolveBrandTheme`).
- `src/orchestrator/gate.js` → `enforceGate`, `GateResult`, `Conformance`, `AuditIssue`.

## You OWN (edit only these)
`src/runtime/**` — and nothing else. Do **not** edit `src/contracts/**`, `src/orchestrator/**`, `src/storage/**`, `src/canvas/**`, `src/app/**`. Read anything.

## Goal
Replace the throwing scaffolds in `createAppApi` (`src/runtime/app-api.ts`) with the real product-layer runtime: mode routing, streaming, the Remediate flow, session persistence, brand-kit theme resolution, and read-only Canvas page access. Keep everything injectable so offline tests use fakes.

## Deliverables

### 1. Wiring (extend `AppApiOptions` + `createAppApi`)
- Obtain a `Database`: use `opts.db` if injected; otherwise open the real on-device DB via storage's opener + `migrate()` (read `src/storage` for the exact API; do it lazily so offline tests that inject `db` or never call session methods don't need a real file). Build `const sessions = createSessionStore(db)` and `const brandKits = createBrandKitStore(db)`.
- Keep all existing injection seams; add injectable overrides for the new deps where it aids testing (e.g. `sessionStore?`, `brandKitStore?`, `resolveTheme?`, `fetchPageBody?`, `listPages?`).

### 2. Mode routing + streaming in `runTurn(req, onChunk?)`
- `const { mode } = routeIntent(req.user, req.mode)`.
- Build `TurnInput`: `{ user: req.user, mode }`; `system = req.system ?? systemPromptForMode(mode)`; if `req.sessionId`, load the session and map its `SessionMessage[]` → `history` (ChatMessage[]).
- Pass a `ToolContext.onEvent` that forwards `{type:'text'}`/`{type:'tool'}` events to `onChunk` as `TurnChunk`. After each fragment clears `enforceGate`, call `onChunk?.({ type:'fragment', fragment })`.
- Return `TurnView` with `mode` echoed. Keep the existing fragment-extraction + **unconditional gate** path (every fragment through `enforceGate`).

### 3. Remediate flow (when `mode === 'remediate'` and `req.remediateInput`)
- `before = await enforceGate(sourceHtml, gateDeps)` → capture its `conformance` issues.
- Run a remediate orchestrator turn whose user content includes the source HTML + the before-issues, asking for corrected HTML (the model may call `audit_html`/`validate_allowlist`/`check_contrast`). Take the model's emitted HTML fragment.
- `after = await enforceGate(modelHtml, gateDeps)`. Bounded re-audit loop (max 3) while `after.badgeWithheld` and issues are still decreasing.
- Build `RemediateResult { before: sourceHtml, after: after.html, issueDiffs, gate: after }`, where `issueDiffs` compares before vs after issues by `AuditIssue.id` (`fixed = present-before && absent-after`). Emit one `TurnFragment { html: after.html, gate: after, remediateResult }`.

### 4. Implement the scaffolded AppApi methods
- `createSession(init)` → `sessions.createSession(init)`; `listSessions/loadSession/deleteSession` → store passthrough.
- `resolveBrandTheme(primary, secondary)` → `resolveTheme(primary, secondary)` (NO LLM).
- `listBrandKits/saveBrandKit/deleteBrandKit` → `brandKits` passthrough.
- `fetchCanvasPage(config, courseId, pageId)` → `fetchPageBody(...)`; `listCanvasPages(config, courseId)` → `listPages(...)`.

### 5. Session persistence on each turn
- When `req.sessionId` is set: after the turn, `appendMessages(sessionId, [ {role:'user', content:req.user}, {role:'assistant', content: turnView.text} ])`. (Create lazily if you also support an absent session — but the app supplies a real id from `createSession`.)

## Invariants
Output **gate stays unconditional + server-side** — no mode bypasses `enforceGate`; a residual blocker withholds the badge. Remediate **never writes to Canvas** (GET-only fetch). Parameterized SQL only (delegated to the stores). No cloud calls. Strict TS, zero deps. Update `src/runtime`'s tests so the suite stays green offline (DI fakes for store/canvas/theme/runner).

## Done criteria & protocol
1. `npm run typecheck` clean. 2. `npm test` green offline. 3. `git add -A && git commit -m "runtime-spine: mode routing + streaming + remediate flow + sessions + brand-kit + canvas fetch"` on `track/runtime-spine`. 4. Append `DONE: <summary + test counts>` to `./.agent-status`. On hard blocker, append `BLOCKED: <reason>` and stop.
