/**
 * Minimal async mutex. The app is single-user and serializes heavy jobs
 * (`OLLAMA_NUM_PARALLEL=1`, `MAX_CONCURRENT_JOBS=1` — PRD §21), so LLM calls run
 * one at a time to avoid loading multiple model copies into unified memory.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Acquire the lock; returns a release function. Always release in a `finally`. */
  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  /** Run `fn` exclusively. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
