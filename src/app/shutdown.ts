/**
 * Quit sequencing for the app's owned child processes (ADR-0006, #13).
 *
 * Takes a narrow `QuitHost` port rather than Electron's `app`, so the deadline
 * and re-entrancy behaviour are unit-testable — `main.ts` imports Electron and
 * cannot run under `node:test`.
 *
 * Electron re-emits `before-quit` on every quit attempt, so every one of them
 * is prevented, unconditionally — an unprevented one would let Electron's own
 * quit sequence race the teardown already in flight. The `shuttingDown` flag
 * only stops teardown itself from being restarted by a repeat Cmd-Q.
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
    // Prevent FIRST, unconditionally: Electron re-emits this on every quit
    // attempt, and an unprevented one would let its own quit sequence race
    // the teardown we are running.
    event.preventDefault();
    if (shuttingDown) return; // teardown already running — don't restart it
    shuttingDown = true;

    void (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const capped = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        });
        const outcome = await Promise.race([dispose().then(() => 'done' as const), capped]);
        if (outcome === 'timeout') {
          // Deliberate: a leaked sidecar is a better outcome than an app the
          // user cannot quit without Force Quit.
          log(`[shutdown] teardown exceeded ${timeoutMs}ms; exiting anyway.`);
        }
      } catch (err) {
        log(`[shutdown] teardown failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
        host.exit(0);
      }
    })();
  });
}
