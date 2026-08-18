/**
 * Minimal async mutex. The app is single-user and serializes heavy jobs
 * (`OLLAMA_NUM_PARALLEL=1`, `MAX_CONCURRENT_JOBS=1` — PRD §21), so LLM calls run
 * one at a time to avoid loading multiple model copies into unified memory.
 *
 * `acquire` waits with a timeout (#14). It used to wait forever, and "forever"
 * is not a theoretical concern here: `chatStream` holds the lock across an async
 * generator, and a consumer that abandons the generator without draining it
 * never runs the `finally` that releases. One leaked lock then queued every
 * subsequent LLM call behind a promise that could never settle, so the model
 * was dead for the rest of the session with no recovery short of restarting the
 * app — and nothing surfaced, because a pending promise looks exactly like a
 * slow one.
 *
 * The timeout is a BACKSTOP, not a scheduler. It converts a permanent wedge into
 * one failed turn; it is not there to bound how long a legitimate call may hold.
 */

/** How long `acquire` waits before deciding the holder is never coming back. */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 300_000;

/**
 * A waiter gave up. Distinguishable on purpose: "the lock never came" is a
 * different failure from anything the model or the transport can produce, and a
 * caller that cannot tell them apart cannot report either one honestly.
 */
export class MutexTimeoutError extends Error {
  override readonly name = 'MutexTimeoutError';
  constructor(timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for the LLM lock. The previous call ` +
        `probably never released it; this call failed rather than waiting forever.`,
    );
  }
}

export interface MutexOptions {
  /** Override the wait budget. Mostly for tests, which cannot wait five minutes. */
  timeoutMs?: number;
}

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private readonly timeoutMs: number;

  constructor(options: MutexOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  }

  /** Acquire the lock; returns a release function. Always release in a `finally`. */
  async acquire(timeoutMs: number = this.timeoutMs): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new MutexTimeoutError(timeoutMs)), timeoutMs);
        previous.then(resolve, resolve);
      });
    } catch (err) {
      // Give up our PLACE without granting the lock.
      //
      // This link is already spliced into the queue, so simply resolving it
      // would release everyone behind us while the original holder is still
      // inside its critical section — a timeout that breaks mutual exclusion is
      // worse than the wedge it replaces. Instead this waiter becomes a
      // pass-through: its link settles only when the one it was waiting on does,
      // so the queue drains in order once (if ever) the holder releases.
      previous.then(release, release);
      throw err;
    } finally {
      // An un-cleared timer keeps the event loop alive for the whole budget,
      // which would hang `npm test` and delay app shutdown by up to five minutes.
      if (timer !== undefined) clearTimeout(timer);
    }

    return release;
  }

  /** Run `fn` exclusively. */
  async run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
