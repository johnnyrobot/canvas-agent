# Design: Parallel Agent-Team Build (iTerm2) — Canvas Agent

**Date:** 2026-06-04 · **Status:** approved, executing
**Spec source:** `PRD_Canvas_Course_Design_Accessibility_Assistant.md` (v1.6) + `HANDOFF.md`
**Backbone:** `src/contracts/index.ts` (frozen cross-track interfaces)

## Goal
Build the remaining Canvas Agent subsystems end-to-end using parallel autonomous
`claude` agents, one per track, each visible in an iTerm2 split pane, coordinated
by a lead session (this one) that freezes interfaces, monitors, gates, and merges.

## Decisions (user-approved)
- **Mechanism:** iTerm2 split panes, each pane an independent `claude --dangerously-skip-permissions` in its own git worktree. This session = lead/integrator.
- **Sequencing:** dependency-aware waves (1 → 2 → 3).
- **Autonomy:** full autonomy + auto-merge; lead runs a verification gate (typecheck + test + diff review) before each merge.
- **App framework:** Electron.
- **Layout:** one fresh iTerm2 window per wave, tiled grid.

## Isolation model (why auto-merge is safe)
1. **Frozen contracts first.** `src/contracts/index.ts` is committed to `main`
   before any agent starts. Every agent imports shared types only from there.
2. **Disjoint directory ownership.** Each track owns exactly one `src/<dir>`.
   Only the lead edits the shared barrel / `createCanonicalTools` wiring.
3. **Git worktrees.** Each agent works in `../canvas-agent-trees/<track>` on
   branch `track/<name>`; parallel writers never share a working tree.
4. **DI across boundaries.** Tracks talk through the function-type ports in
   contracts (e.g. `ContrastChecker`, `Database`, `ThemeResolver`), never by
   importing another track's implementation.

Disjoint dirs + frozen contracts ⇒ merges are conflict-free by construction.

## Track map

| Wave | Track | Owns `src/` | Implements (contract port) | PRD |
|---|---|---|---|---|
| 1 | engine-core | `engine/` | `AllowlistValidator`, `ContrastChecker` | §8, App. B/K |
| 1 | storage | `storage/` | `OpenDatabase`, `SecretStore`, `AppPaths` | v1.6 |
| 1 | knowledge | `knowledge/` | `KbRetriever` (FTS5/BM25, no embeddings) | §9.2, §13.1 |
| 2 | engine-render | `engine/render/` | `Auditor` (Playwright/axe/pa11y + computed contrast) | §8, App. K |
| 2 | theme | `theme/` | `ThemeResolver` (consumes `ContrastChecker`) | §15.3 |
| 2 | templates | `templates/` | `TemplateRenderer` (consumes theme + allowlist) | §15.3 |
| 2 | canvas | `canvas/` | `CanvasImporter` (read-only) | §17 |
| 3 | app-shell | `app/` + packaging | Electron over localhost; sidecar bundle/sign | §19–§22 |
| 3 | integration | `orchestrator/` wiring + `e2e/` | wire 8 tools, prompt assembly, live LLM/ingest, e2e | §15, §19 |

## Per-pane agent protocol
Launch: `cd <worktree> && claude --dangerously-skip-permissions "<bootstrap>"`.
Bootstrap tells the agent to read two files dropped into its worktree:
- **`AGENT_CONTRACT.md`** — the exact port(s) to implement (signatures from
  `src/contracts`), the §3 invariants, and the import/ownership rules.
- **`AGENT_BRIEF.md`** — track scope, relevant PRD sections, the TDD mandate
  (failing tests first), and the Definition of Done.

**Definition of Done (every track):** `npm run typecheck` clean · `npm test`
green · conforms to its contract port · short `README.md` · then write `DONE`
to `.agent-status` (or `BLOCKED: <reason>` / `FAILED: <reason>`).

## Hard invariants (from PRD §3 / HANDOFF) — agents MUST honor
1. No cloud models / no external network at the product runtime (only opt-in
   read-only Canvas import + opt-in WAVE). *Dev tooling (Claude) is exempt — it
   builds the app; it is not in the shipped inference path.*
2. The output gate is unconditional + server-side; a residual blocker withholds
   the badge (`A11Y_FAIL_OPEN=false`).
3. Single-user Apple-Silicon desktop; SQLite + local files + Keychain.
4. No embeddings in v1 (lexical/FTS5/BM25 only).
5. Read-only ingestion; sidecar pattern; **zero runtime deps** (engine-render is
   the sanctioned exception — it may add Playwright/axe).
6. TS ESM (NodeNext), strict tsconfig, `node:test` + `tsx` (no Jest/Vitest), DI
   everywhere. **Parameterized SQL only — never interpolate into query strings.**

## Lead loop (per wave)
1. Ensure contracts on `main` cover the wave's ports (extend + commit if needed).
2. Create worktrees + branches for the wave's tracks.
3. Write `AGENT_BRIEF.md` + `AGENT_CONTRACT.md` into each worktree.
4. Spawn the tiled iTerm2 window; launch one agent per pane.
5. Monitor `.agent-status` files until each reports `DONE`/`FAILED`/`BLOCKED`.
6. Verification gate per track: `npm run typecheck && npm test` green + diff
   review (no cross-track reach-in, conforms to contract, no new cloud calls).
7. `git merge --no-ff track/<name>` into `main`. Resolve the (rare) barrel/wiring
   conflict as lead.
8. When the wave is fully merged, advance to the next wave against the richer `main`.

## Caveats (accepted)
- High concurrent token spend (independent `claude` sessions per wave).
- Auto-merge can't prove design correctness; lead diff review is the backstop.
- `gemma4:12b-mlx` + `docling-serve` are not installed → only Wave-3 *live* smoke
  tests are affected; build + unit tests are fully offline. Integration agent
  retargets config to an installed model (`gemma4:31b`/`e2b`) and gates live
  tests behind env flags.
- Git history starts at the baseline commit; no prior history to preserve.

## Definition of Done (whole effort)
All tracks merged to `main`; `npm run typecheck` clean; `npm test` green across
all modules; the 8 canonical tools wired in `createCanonicalTools`; an Electron
shell that launches, drives a turn, and renders `TurnResult` + `GateResult`;
live LLM/ingest paths exercised once `gemma4:31b`/`docling-serve` are available.
