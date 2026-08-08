/**
 * Quit sequencing for the app's owned child processes (ADR-0006, #13).
 *
 * Takes a narrow `QuitHost` port rather than Electron's `app`, so the deadline
 * and re-entrancy behaviour are unit-testable — `main.ts` imports Electron and
 * cannot run under `node:test`.
 *
 * `app.exit()` bypasses `before-quit`/`will-quit`, so exiting cannot re-enter
 * this handler; the `shuttingDown` flag covers the window *before* `exit` is
 * reached (a second Cmd-Q while teardown is still running).
 */

/** The only thing this needs from Electron's `before-quit` event. */
export interface QuitEvent {
  preventDefault(): void;
}

/** The only things this needs from Electron's `app`. */
export interface QuitHost {
  on(event: 'before-quit', listener: (e: QuitEvent) => void): void;
  exit(code: number): void;
}

export interface ShutdownOptions {
  /** Hard cap on the whole teardown. Default 8s: a 3s drain plus a 5s TERM→KILL. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Outer bound on drain (3s) + the sidecar lifecycle's TERM→KILL grace (5s). */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

export function registerShutdown(
  host: QuitHost,
  dispose: () => Promise<void>,
  options: ShutdownOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const log = options.log ?? ((msg: string) => console.warn(msg));
  let shuttingDown = false;

  host.on('before-quit', (event) => {
    if (shuttingDown) return; // a second Cmd-Q must not restart teardown
    shuttingDown = true;
    event.preventDefault();

    void (async () => {
      try {
        let timer: NodeJS.Timeout | undefined;
        const capped = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const outcome = await Promise.race([dispose().then(() => 'done' as const), capped]);
        clearTimeout(timer);
        if (outcome === 'timeout') {
          // Deliberate: a leaked sidecar is a better outcome than an app the
          // user cannot quit without Force Quit.
          log(`[shutdown] teardown exceeded ${timeoutMs}ms; exiting anyway.`);
        }
      } catch (err) {
        log(`[shutdown] teardown failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        host.exit(0);
      }
    })();
  });
}
