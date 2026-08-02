/**
 * @file Wires `<tableau-viz>` interaction events to a debounced capture-and-push.
 *
 * Three constraints shape this file, all of them measured rather than assumed:
 *
 * 1. One user gesture fans out into a burst of events (a filter change re-fires `filterchanged`
 *    per affected worksheet, plus `summarydatachanged`), so events are debounced to the trailing
 *    edge and a whole burst collapses into one capture.
 * 2. Captures are NOT serialized against each other — `captureVizState` builds its own single-use
 *    queue per call, so two overlapping captures interleave their Embedding API calls, which is the
 *    measured way to hang the postMessage channel. Hence the in-flight guard here: a trigger during
 *    a running capture is remembered, not started.
 * 3. A capture can take up to `OVERALL_CAPTURE_TIMEOUT_MS` (15s), far longer than the debounce
 *    window, so "a capture is running" is the common case during sustained interaction, not an edge.
 *
 * Listeners go on the `<tableau-viz>` ELEMENT, never on the workbook or sheet objects: those are
 * replaced on tab switch, and listeners attached to them would silently stop firing.
 */
import type { App } from '@modelcontextprotocol/ext-apps';

import { captureVizState, type VizIdentity } from './captureVizState.js';
import { createDebouncer } from './debounce.js';
import { TABLEAU_VIZ_EVENTS, type TableauVizElement } from './embeddingApiTypes.js';
import type { DatasourceRef, VizStatePayload } from './payload.js';
import { pushVizState } from './pushVizState.js';

/**
 * How long the viz has to stay quiet before a capture starts. Long enough to swallow the multi-event
 * burst of one gesture, short enough that the pushed snapshot still matches what the user sees.
 */
export const VIZ_SETTLE_DEBOUNCE_MS = 2_000;

/** Consecutive aborted captures after which the bridge stops trying. */
export const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** `captureVizState` marks a timed-out capture with an error line starting like this. */
const ABORT_ERROR_PREFIX = 'capture aborted:';

/** Appended to the last payload the bridge ever pushes, so the model can explain the gap. */
export const CHANNEL_WEDGED_ERROR =
  'viz state capture is unavailable; the Embedding API channel stopped responding — reload to recover';

/**
 * Fires once the viz is interactive. Used as a capture trigger so the initial snapshot exists
 * before the user touches anything; it shares the debouncer with the interaction events so the
 * load-time burst of action-filter `filterchanged` events collapses into that same capture.
 */
const VIZ_LOADED_EVENT = 'firstinteractive';

export type VizStateBridgeOptions = {
  app: App;
  viz: TableauVizElement;
  identity: VizIdentity;
  /** Capture once the viz becomes interactive, not only on interaction. Defaults to true. */
  pushOnLoad?: boolean;
  debounceMs?: number;
};

/**
 * Starts capturing and pushing viz state in response to viz events.
 *
 * Never throws, and never lets a capture or push failure escape: the embedded viz the user is
 * looking at must keep working even when the state channel does not.
 *
 * @returns a dispose function that removes every listener and cancels any pending capture.
 *   Idempotent, and safe to call while a capture is in flight.
 */
export function startVizStateBridge(options: VizStateBridgeOptions): () => void {
  const { app, viz, identity, pushOnLoad = true, debounceMs = VIZ_SETTLE_DEBOUNCE_MS } = options;

  let disposed = false;
  let capturing = false;
  let rerunRequested = false;
  let consecutiveTimeouts = 0;

  /**
   * Shared across every capture this bridge runs: a sheet's datasources do not change within a
   * page's life, and `getDataSourcesAsync` is documented as expensive enough to hurt the viz.
   */
  const datasourceCache = new Map<string, DatasourceRef[]>();

  /**
   * Last worksheet named by an event, used to pick which sheet's summary data to sample. Nothing in
   * the capture reads the event otherwise — the event is only a trigger.
   */
  let preferredSheetName: string | undefined;

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
      const payload = await captureVizState({ viz, identity, preferredSheetName, datasourceCache });

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
        const degraded: VizStatePayload = {
          ...payload,
          errors: [...(payload.errors ?? []), CHANNEL_WEDGED_ERROR],
        };

        await pushVizState(app, degraded);
        dispose();
        return;
      }

      await pushVizState(app, payload);
    } catch (error) {
      // Both `captureVizState` and `pushVizState` already promise not to throw. This is the belt to
      // that pair of braces: an unhandled rejection here would surface as an app-level error.
      console.error('[mcp-app] viz state bridge failed', error);
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

  const handleVizEvent = (event: Event): void => {
    const sheetName = readEventSheetName(event);
    if (sheetName !== undefined) {
      preferredSheetName = sheetName;
    }

    debouncer.trigger();
  };

  const handleVizLoaded = (): void => {
    debouncer.trigger();
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;

    for (const eventName of TABLEAU_VIZ_EVENTS) {
      viz.removeEventListener(eventName, handleVizEvent);
    }
    viz.removeEventListener(VIZ_LOADED_EVENT, handleVizLoaded);

    debouncer.cancel();
  };

  for (const eventName of TABLEAU_VIZ_EVENTS) {
    viz.addEventListener(eventName, handleVizEvent);
  }

  if (pushOnLoad) {
    viz.addEventListener(VIZ_LOADED_EVENT, handleVizLoaded, { once: true });
  }

  return dispose;
}

/**
 * Reads the worksheet name an event mentions, if it mentions one.
 *
 * The detail shape is not part of any contract this repo owns — it is whatever the runtime-loaded
 * Embedding API attaches — so both observed spellings are accepted and anything else is ignored.
 */
function readEventSheetName(event: Event): string | undefined {
  try {
    const detail = (event as CustomEvent).detail as
      | { worksheet?: { name?: unknown }; sheet?: { name?: unknown } }
      | undefined;

    for (const candidate of [detail?.worksheet?.name, detail?.sheet?.name]) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }
  } catch {
    // `detail` is arbitrary host-supplied data; a throwing getter must not swallow the trigger.
  }

  return undefined;
}
