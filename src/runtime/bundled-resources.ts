/**
 * Resolve on-device sidecar executables shipped INSIDE the packaged `.app`.
 *
 * A Finder-launched macOS `.app` inherits a *minimal* PATH (effectively
 * `/usr/bin:/bin:/usr/sbin:/sbin`) — it does NOT see the user's interactive shell
 * PATH. So a bare `spawn('ollama', …)` / `spawn('docling-serve', …)` would ENOENT
 * in a packaged build even when the binary is installed for the logged-in user.
 * electron-builder stages each sidecar under `<resources>/sidecars/<name>/<name>`
 * (see `build.extraResources` in package.json and `scripts/stage-resources.mjs`);
 * this resolves that absolute path so the lifecycle managers spawn the BUNDLED
 * binary directly.
 *
 * This is the sidecar analogue of `resolveBundledBrowsersPath` in the render
 * engine (which points Playwright's `PLAYWRIGHT_BROWSERS_PATH` at
 * `<resources>/ms-playwright`). The sidecars differ only in that we resolve an
 * executable *path* rather than a search *dir*, so they get their own helper.
 *
 * Returns the bundled path only when it actually exists on disk. In dev/test
 * (no `process.resourcesPath`, or the binary not staged) it returns `fallback`
 * — by default the bare command name — so `spawn` resolves it from PATH exactly
 * as before; dev behavior is unchanged. Pure + injectable so it is unit-tested
 * without a filesystem or a packaged app.
 *
 * Staging contract: the executable MUST land at `sidecars/<name>/<name>` (the
 * stage:* scripts honor this — `ollama` is copied by basename; the docling-serve
 * dist's launcher is named `docling-serve`). If it lands elsewhere the resolver
 * falls back to PATH, so a mis-stage degrades to the pre-existing behavior rather
 * than pointing at a wrong file.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveSidecarCommand(
  name: string,
  fallback: string = name,
  resourcesPath: string | undefined = (process as { resourcesPath?: string }).resourcesPath,
  exists: (p: string) => boolean = existsSync,
): string {
  if (!resourcesPath) return fallback;
  const bin = path.join(resourcesPath, 'sidecars', name, name);
  return exists(bin) ? bin : fallback;
}
