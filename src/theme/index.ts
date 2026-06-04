/**
 * theme: the accessible ThemeResolver (PRD §15.3, `resolve_theme`).
 *
 * The single public surface for this track. Implements the frozen `ThemeResolver`
 * port from `src/contracts`, consumed by the templates track and wired into
 * `EngineCapabilities` by integration. Pure, offline, dependency-free; the only
 * cross-track import is engine-core's read-only `checkContrast` (WCAG math).
 */
export { resolveTheme, DEFAULT_THEME_ROLES } from './theme.js';
