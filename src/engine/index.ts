/**
 * engine-core: the deterministic engine's pure core.
 *
 * The single public surface for this track. Two pure, offline, dependency-free
 * ports (frozen in `src/contracts`), consumed by the orchestrator's output gate
 * and the theme/templates tracks:
 *
 *  - `checkContrast`    — WCAG 2.2 contrast math (PRD §8.3).
 *  - `validateAllowlist` — Canvas HTML allowlist gate + safe repair (Appendix B).
 */
export { checkContrast } from './contrast.js';
export { validateAllowlist } from './allowlist.js';
