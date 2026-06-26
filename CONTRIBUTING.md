# Contributing to Canvas Agent

Thanks for your interest in improving Canvas Agent. This is an on-device macOS
app that helps instructors build and remediate accessible Canvas content. A few
project values shape almost every change:

- **On-device only.** The app makes **no** network calls to external model or
  document APIs — the LLM and document ingestion run as local sidecars. Please do
  not add cloud/API dependencies to runtime paths.
- **Accessibility-first.** The product's job is WCAG 2.2 AA conformance. Changes
  that produce or transform HTML must keep generated output accessible, and must
  not let unverified content masquerade as an authoritative conformance claim.
- **Honest by construction.** Security/correctness guards (the gate, the
  sanitizer, the SSRF/path guards) are there on purpose. Harden them; don't route
  around them.

By submitting a contribution you agree it is licensed under the project's
[Apache-2.0 license](LICENSE) (see Apache-2.0 §5).

## Prerequisites

- **macOS** on **Apple Silicon (arm64)**
- **Node.js ≥ 20**

## Getting started

```bash
npm install
npm run build      # tsc + copy assets
npm run app        # build, then launch the Electron app
```

## Development workflow

```bash
npm test           # unit + e2e suite (node:test via tsx)
npm run typecheck  # tsc --noEmit
npm run verify     # typecheck + tests — the bar every change must clear
```

A **pre-push git hook runs `npm run verify`**, so pushes with a failing
typecheck or test will be rejected. Run it locally before opening a PR.

- **Tests are expected.** This codebase is developed test-first — add a failing
  test that captures the bug or new behavior, then make it pass. Security fixes
  in particular should ship with a regression test.
- **Match the surrounding code.** TypeScript (ESM), small focused modules, and
  the comment/naming style already in the file you're editing. Each `src/<area>/`
  module has its own `README.md` describing its responsibility — read it first.
- **Accessibility & security changes** touching the engine, ingestion, or the
  orchestrator gate should explain, in the PR, why the output stays conformant
  and the guards stay intact.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), matching the
existing history:

```
fix(ingest): close trailing-dot SSRF bypass
feat(engine): model RCDATA elements in the tokenizer
chore: add Apache-2.0 license and public README
```

## Pull requests

1. Branch from `main`.
2. Make the change with a test; get `npm run verify` green.
3. Open a PR and fill in the template (what changed, why, how it was verified).
4. Link any related issue.

## Reporting a security issue

Please do **not** open a public issue for a security vulnerability. Instead,
report it privately via GitHub's
**[private vulnerability reporting](https://github.com/johnnyrobot/canvas-agent/security/advisories/new)**
(the repository's **Security** tab → **Report a vulnerability**), and we'll
coordinate a fix and disclosure.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you are expected to uphold it.
