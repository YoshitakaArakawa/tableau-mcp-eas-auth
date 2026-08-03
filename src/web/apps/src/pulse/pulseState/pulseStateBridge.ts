/**
 * @file Wires `<tableau-pulse>` interaction events to a debounced capture-and-push.
 *
 * Structurally the same machine as the viz bridge (`embed/vizState/vizStateBridge.ts`), and for the
 * same measured reasons: one gesture fans out into a burst of events, overlapping captures
 * interleave Embedding API calls and wedge the postMessage channel, and a capture can outlast the
 * debounce window. Hence trailing-edge debounce, an in-flight guard, and a circuit breaker.
 *
 * The one Pulse-specific job is insight accumulation. `pulseinsightdiscovered` is the only place an
 * insight ever exists — there is no call that lists them — so the bridge sanitizes each one on
 * arrival and keeps it. That makes the bridge, not the capture, the owner of the insight list.
 *
 * Listeners go on the `<tableau-pulse>` ELEMENT, never on any object the API hands back.
 */
import type { App } from '@modelcontextprotocol/ext-apps';

import { createDebouncer } from '../../embed/vizState/debounce.js';
import {
  type CapturedInsight,
  capturePulseState,
  type PulseIdentity,
  serializeInsight,
} from './capturePulseState.js';
import {
  PULSE_FIRST_SIZE_EVENT,
  PULSE_INSIGHT_DISCOVERED_EVENT,
  TABLEAU_PULSE_EVENTS,
  type TableauPulseElement,
} from './pulseEmbeddingApiTypes.js';
import type { PulseStatePayload } from './pulsePayload.js';
import { pushPulseState } from './pushPulseState.js';

/**
 * How long the metric has to stay quiet before a capture starts. Long enough to swallow the
 * multi-event burst of one gesture, short enough that the pushed snapshot still matches the screen.
 */
export const PULSE_SETTLE_DEBOUNCE_MS = 2_000;

/** Consecutive aborted captures after which the bridge stops trying. */
export const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** `capturePulseState` marks a timed-out capture with an error line starting like this. */
const ABORT_ERROR_PREFIX = 'capture aborted:';

/** Appended to the last payload the bridge ever pushes, so the model can explain the gap. */
export const PULSE_CHANNEL_WEDGED_ERROR =
  'pulse state capture is unavailable; the Embedding API channel stopped responding — reload to recover';

/**
 * Fires once the metric is rendered. Used as a capture trigger so the initial snapshot exists
 * before the user touches anything; it shares the debouncer with the interaction events so the
 * load-time burst of `pulseinsightdiscovered` events collapses into that same capture.
 *
 * The first-size event doubles as the readiness signal because `<tableau-pulse>` has no
 * `firstinteractive` equivalent — a known size is the first proof the metric actually rendered.
 */
const PULSE_LOADED_EVENT = PULSE_FIRST_SIZE_EVENT;

/** Cap on the accumulated insight list, before per-capture dedupe. A guard against unbounded growth. */
const MAX_ACCUMULATED_INSIGHTS = 60;

export type PulseStateBridgeOptions = {
  app: App;
  pulse: TableauPulseElement;
  identity: PulseIdentity;
  /** Capture once the metric renders, not only on interaction. Defaults to true. */
  pushOnLoad?: boolean;
  debounceMs?: number;
};

/**
 * Starts capturing and pushing Pulse metric state in response to Pulse events.
 *
 * Never throws, and never lets a capture or push failure escape: the embedded metric the user is
 * looking at must keep working even when the state channel does not.
 *
 * @returns a dispose function that removes every listener and cancels any pending capture.
 *   Idempotent, and safe to call while a capture is in flight.
 */
export function startPulseStateBridge(options: PulseStateBridgeOptions): () => void {
  const {
    app,
    pulse,
    identity,
    pushOnLoad = true,
    debounceMs = PULSE_SETTLE_DEBOUNCE_MS,
  } = options;

  let disposed = false;
  let capturing = false;
  let rerunRequested = false;
  let consecutiveTimeouts = 0;

  /** Insights seen so far, sanitized at arrival. The capture dedupes and caps them. */
  const insights: CapturedInsight[] = [];

  const debouncer = createDebouncer(debounceMs, () => {
    void runCapture();
  });

  async function runCapture(): Promise<void> {
    if (disposed) {
      return;
    }

    // Overlapping captures interleave Embedding API calls and wedge the channel. Remember the
    // request instead, and re-arm the debouncer once the running capture is done.
    if (capturing) {
      rerunRequested = true;
      return;
    }

    capturing = true;

    try {
      const payload = await capturePulseState({ pulse, identity, insights });

      // Disposed mid-capture: the element this bridge watched is gone (a new tool result replaced
      // it, or the app is tearing down). Pushing now would advertise a stale view as current.
      if (disposed) {
        return;
      }

      const aborted = (payload.errors ?? []).some((error) => error.startsWith(ABORT_ERROR_PREFIX));
      consecutiveTimeouts = aborted ? consecutiveTimeouts + 1 : 0;

      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        // A wedged Embedding API channel does not recover without a page reload, and every retry
        // costs another 15s of waiting per interaction. Push one final payload that says so, then
        // stop listening entirely.
        const degraded: PulseStatePayload = {
          ...payload,
          errors: [...(payload.errors ?? []), PULSE_CHANNEL_WEDGED_ERROR],
        };

        await pushPulseState(app, degraded);
        dispose();
        return;
      }

      await pushPulseState(app, payload);
    } catch (error) {
      // Both `capturePulseState` and `pushPulseState` already promise not to throw. This is the
      // belt to that pair of braces: an unhandled rejection here would surface as an app-level
      // error.
      console.error('[mcp-pulse] pulse state bridge failed', error);
    } finally {
      capturing = false;

      if (!disposed && rerunRequested) {
        rerunRequested = false;
        // Back through the debounce window rather than an immediate re-run: whatever the user was
        // doing during the last capture is probably still in progress.
        debouncer.trigger();
      }
    }
  }

  const handlePulseEvent = (event: Event): void => {
    if (event.type === PULSE_INSIGHT_DISCOVERED_EVENT) {
      recordInsight(event);
    }

    debouncer.trigger();
  };

  const recordInsight = (event: Event): void => {
    try {
      const insight = serializeInsight((event as CustomEvent).detail);
      if (insight === undefined) {
        return;
      }

      insights.push(insight);

      // Oldest-first eviction. The capture keeps the most recent entry per id anyway, so dropping
      // from the head only ever loses insights that have already been superseded or scrolled past.
      if (insights.length > MAX_ACCUMULATED_INSIGHTS) {
        insights.splice(0, insights.length - MAX_ACCUMULATED_INSIGHTS);
      }
    } catch (error) {
      // `detail` is arbitrary host-supplied data; a throwing getter must not swallow the trigger.
      console.warn('[mcp-pulse] could not read a discovered insight', error);
    }
  };

  const handlePulseLoaded = (): void => {
    debouncer.trigger();
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;

    for (const eventName of TABLEAU_PULSE_EVENTS) {
      pulse.removeEventListener(eventName, handlePulseEvent);
    }
    pulse.removeEventListener(PULSE_LOADED_EVENT, handlePulseLoaded);

    debouncer.cancel();
  };

  for (const eventName of TABLEAU_PULSE_EVENTS) {
    pulse.addEventListener(eventName, handlePulseEvent);
  }

  if (pushOnLoad) {
    pulse.addEventListener(PULSE_LOADED_EVENT, handlePulseLoaded, { once: true });
  }

  return dispose;
}
