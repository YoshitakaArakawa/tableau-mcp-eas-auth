/**
 * @file Serial, timeout-guarded queue for Embedding API calls.
 *
 * Measured behaviour that motivates every rule below: an invalid Embedding API call can hang
 * FOREVER — the returned promise never settles, and the postMessage channel to the viz stays wedged
 * for the rest of the page's life. There is no cancel and no recovery short of a page reload.
 *
 * So a capture must: issue one call at a time (never overlap), bound each individual call, bound the
 * capture as a whole, and stop issuing calls the moment anything has gone wrong. A hung call is
 * abandoned rather than awaited, which is why the queue chains on the raced promise rather than on
 * the caller's promise.
 */

export type CaptureAbortReason = 'call-timeout' | 'overall-timeout' | 'disposed';

/** Thrown by `run`/`runFinal` when the capture is (or has just become) aborted. */
export class CaptureAbortedError extends Error {
  readonly reason: CaptureAbortReason;
  readonly label: string;

  constructor(reason: CaptureAbortReason, label: string) {
    super(`viz state capture aborted (${reason}) at "${label}"`);
    this.name = 'CaptureAbortedError';
    this.reason = reason;
    this.label = label;
  }
}

export type SerialQueueOptions = {
  /** Cap on any single Embedding API call. Exceeding it aborts the whole capture. */
  callTimeoutMs: number;
  /** Cap on the capture as a whole. The clock starts at construction. */
  overallTimeoutMs: number;
};

/**
 * One instance per capture. Construct it, run every Embedding API call through it, then call
 * `abort('disposed')` when the capture is finished so the overall timer is released.
 */
export class SerialQueue {
  private readonly callTimeoutMs: number;
  private tail: Promise<unknown> = Promise.resolve();
  private overallTimer: ReturnType<typeof setTimeout> | undefined;
  private reason: CaptureAbortReason | undefined;

  constructor(options: SerialQueueOptions) {
    this.callTimeoutMs = options.callTimeoutMs;
    this.overallTimer = setTimeout(() => {
      this.abort('overall-timeout');
    }, options.overallTimeoutMs);
  }

  get aborted(): boolean {
    return this.reason !== undefined;
  }

  get abortReason(): CaptureAbortReason | undefined {
    return this.reason;
  }

  /** Idempotent: the first reason wins, so the original cause is never overwritten by a later one. */
  abort(reason: CaptureAbortReason): void {
    if (this.reason !== undefined) {
      return;
    }

    this.reason = reason;

    if (this.overallTimer !== undefined) {
      clearTimeout(this.overallTimer);
      this.overallTimer = undefined;
    }
  }

  /** Queues a call. Fails fast (without invoking `fn`) once the capture has aborted. */
  run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.enqueue(label, fn, false);
  }

  /**
   * Queues a call that must still run after an abort — `reader.releaseAsync()` cleanup being the
   * reason this exists. Still subject to the per-call timeout.
   */
  runFinal<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.enqueue(label, fn, true);
  }

  private enqueue<T>(label: string, fn: () => Promise<T>, ignoreAbort: boolean): Promise<T> {
    if (!ignoreAbort && this.reason !== undefined) {
      return Promise.reject(new CaptureAbortedError(this.reason, label));
    }

    const result = this.tail.then(() => {
      // Re-check on dequeue: the capture may have aborted while this call sat in the queue.
      if (!ignoreAbort && this.reason !== undefined) {
        throw new CaptureAbortedError(this.reason, label);
      }

      return this.withTimeout(label, fn);
    });

    // Chain the tail on the RACED promise, never on the raw fn() promise. A call that never settles
    // still lets `result` settle at the call timeout, so the queue keeps draining instead of wedging.
    // The `.catch` keeps a rejected link from surfacing as an unhandled rejection.
    this.tail = result.catch(() => undefined);

    return result;
  }

  private withTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Clear on every outcome so a settled call leaves no timer behind.
    const clearCallTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.abort('call-timeout');
        reject(new CaptureAbortedError('call-timeout', label));
      }, this.callTimeoutMs);
    });

    // Wrapped so that a synchronous throw from `fn` becomes a rejection and still clears the timer.
    const call = (async (): Promise<T> => fn())();

    return Promise.race([call, timeout]).finally(clearCallTimer);
  }
}
