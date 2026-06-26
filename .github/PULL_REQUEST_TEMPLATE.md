<!-- Thanks for contributing to Canvas Agent! -->

## Summary

<!-- What does this change do, and why? -->

Closes #<!-- issue number, if any -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal cleanup
- [ ] Docs
- [ ] Build / packaging

## How it was verified

<!-- Commands run and what you observed. -->

- [ ] `npm run verify` passes (typecheck + tests)
- [ ] Added/updated tests for the change (regression test for bug fixes)

## Project-specific checklist

- [ ] **On-device**: no new network calls to external model/document APIs in runtime paths
- [ ] **Accessibility**: any generated/transformed HTML stays WCAG 2.2 AA conformant, and no unverified content can surface as an authoritative conformance claim
- [ ] **Guards intact**: sanitizer / SSRF / path-containment guards are hardened, not bypassed
- [ ] Updated the relevant `src/<area>/README.md` or root docs if behavior changed
