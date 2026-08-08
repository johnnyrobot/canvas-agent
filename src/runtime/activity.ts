/**
 * In-flight turn counting, so shutdown can drain a turn before it signals the
 * sidecars (ADR-0006).
 *
 * "A turn is in flight" is exactly the window in which a per-turn Chromium
 * exists (ADR-0005) — `withTurnAuditor` brackets both. Draining that window is
 * what lets the browser be disposed by its own `finally` instead of orphaned.
 *
 * Deliberately dependency-free: no clock injection, no timers beyond the single
 * deadline, which is cleared on the idle path so it never holds the event loop
 * open.
 */
export interface ActivityTracker {
  /** Mark a turn in flight. Call the returned release exactly once when it ends. */
  begin(): () => void;
  /** Resolve when no turn is in flight (`true`) or when `timeoutMs` elapses (`false`). */
  whenIdle(timeoutMs: number): Promise<boolean>;
}

export function createActivityTracker(): ActivityTracker {
  let inFlight = 0;
  let waiters: Array<() => void> = [];

  return {
    begin() {
      inFlight += 1;
      // Idempotent: a double release must not drive the count negative and
      // report idle while a sibling turn is still running.
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
        if (inFlight > 0) return;
        const pending = waiters;
        waiters = [];
        for (const wake of pending) wake();
      };
    },

    whenIdle(timeoutMs) {
      if (inFlight === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const onIdle = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== onIdle);
          resolve(false);
        }, timeoutMs);
        waiters.push(onIdle);
      });
    },
  };
}

/**
 * The default when `createAppApi` is built without `createRuntime` (offline
 * tests, `scripts/probe-runtime.mjs`): always idle, so behaviour is unchanged.
 */
export const noopActivityTracker: ActivityTracker = {
  begin: () => () => {},
  whenIdle: async () => true,
};
