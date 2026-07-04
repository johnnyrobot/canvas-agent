/**
 * Pure UI-theme decision logic for the redesign screens (light/dark toggle).
 *
 * Kept dependency-free (no `El`, no `document`/`window`) so it's unit-testable
 * without a DOM. `renderer.ts` owns the `uiTheme` state + persistence and calls
 * into this module to decide (a) whether the current screen has a dark variant
 * and (b) what the screen root's class list should be.
 *
 * NOTE: this is UI chrome theme (light/dark), unrelated to `state.theme`
 * (the resolved brand-kit `ThemeResult` used by the build/brand flows).
 */

export type UiTheme = 'light' | 'dark';

/** Root modifier class for a redesign screen that has a `--dark` CSS variant. */
export type ThemedScreenRoot = 'inst' | 'remed';

// The five redesign screens with dark-mode CSS (`.inst--dark` / `.remed--dark`
// in index.html) and the root class each one's screen body renders.
const THEMED_SCREEN_ROOTS: Readonly<Record<string, ThemedScreenRoot>> = {
  'inst-home': 'inst',
  'inst-ask': 'inst',
  'inst-brand': 'inst',
  'inst-ingest': 'inst',
  'remediate-review': 'remed',
};

/**
 * The screen root's modifier class (`inst` | `remed`) if `screen` is one of the
 * five redesign screens with a dark variant, else `undefined` (classic screens
 * are untouched by the theme toggle).
 */
export function themedScreenRoot(screen: string): ThemedScreenRoot | undefined {
  return THEMED_SCREEN_ROOTS[screen];
}

/**
 * The class string for a themed screen's root element given its existing
 * classes and the current `uiTheme` — adds or removes the `--dark` modifier
 * while preserving every other class, e.g.
 * `uiThemeRootClass('inst', 'inst', 'dark')` → `'inst inst--dark'`.
 */
export function uiThemeRootClass(existing: string, root: ThemedScreenRoot, uiTheme: UiTheme): string {
  const dark = `${root}--dark`;
  const classes = existing.split(/\s+/).filter((c) => c !== '' && c !== dark);
  if (uiTheme === 'dark') classes.push(dark);
  return classes.join(' ');
}
