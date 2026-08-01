/**
 * @file Trailing-edge debouncer for viz interaction events.
 *
 * A single user gesture on a dashboard fans out into a burst of Embedding API events (a filter
 * change re-fires `filterchanged` per affected worksheet, plus `summarydatachanged`). Capturing on
 * every event would run several overlapping captures; the debouncer collapses a burst into one
 * capture on the trailing edge.
 */

export type Debouncer = {
  trigger: () => void;
  cancel: () => void;
  readonly pending: boolean;
};

/**
 * Creates a trailing-edge debouncer.
 * `trigger()` (re)arms the timer, so a steady stream of events keeps postponing the call;
 * `cancel()` disarms it without firing, for teardown.
 */
export function createDebouncer(delayMs: number, fn: () => void): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    trigger(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, delayMs);
    },

    cancel(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },

    get pending(): boolean {
      return timer !== undefined;
    },
  };
}
