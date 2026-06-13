/**
 * Navigation policy for the privileged main window (C8).
 *
 * The renderer shows gate-approved HTML, and the Canvas allowlist legitimately
 * keeps `<a href target="_blank">` links. Without a guard, clicking such a link
 * could navigate the top-level, Node-capable window off-app (or open arbitrary
 * content inside it). These two pure predicates back `main.ts`'s `will-navigate`
 * and `setWindowOpenHandler` guards — kept here so they're unit-testable without
 * importing Electron.
 */

/**
 * True only when `target` is the app's own page (same protocol + host + path,
 * ignoring hash/query so in-page anchors and reloads are allowed). Any other
 * destination — a different file, http(s), or a non-web scheme — is blocked.
 */
export function isInAppUrl(target: string, appUrl: string): boolean {
  try {
    const t = new URL(target);
    const a = new URL(appUrl);
    return t.protocol === a.protocol && t.host === a.host && t.pathname === a.pathname;
  } catch {
    return false;
  }
}

/**
 * For a window-open request: the http(s) URL to hand to the OS browser, or
 * `null` to deny entirely. Non-web schemes (javascript:, file:, data:, …) are
 * never opened — in-app or externally.
 */
export function externalOpenTarget(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
