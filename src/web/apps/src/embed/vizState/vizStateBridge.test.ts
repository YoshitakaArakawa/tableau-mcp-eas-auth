/**
 * @vitest-environment jsdom
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./captureVizState.js');
vi.mock('./pushVizState.js');

import { captureVizState, type VizIdentity } from './captureVizState.js';
import type { TableauVizElement } from './embeddingApiTypes.js';
import { BASE_CAVEATS, type VizStatePayload } from './payload.js';
import { pushVizState } from './pushVizState.js';
import {
  CHANNEL_WEDGED_ERROR,
  startVizStateBridge,
  VIZ_SETTLE_DEBOUNCE_MS,
} from './vizStateBridge.js';

const IDENTITY: VizIdentity = {
  workbook: { name: 'Superstore', luid: 'wb-luid' },
  view: { name: 'Sales', luid: 'view-luid' },
};

function makePayload(overrides: Partial<VizStatePayload> = {}): VizStatePayload {
  return {
    capturedAt: '2026-08-01T00:00:00.000Z',
    workbook: { name: 'Superstore', luid: 'wb-luid' },
    view: { name: 'Sales', luid: 'view-luid' },
    activeSheet: { name: 'Sales Dashboard', sheetType: 'dashboard' },
    filters: [],
    parameters: [],
    selection: { marks: [], columns: [], truncated: false },
    caveats: [...BASE_CAVEATS],
    ...overrides,
  };
}

function makeAbortedPayload(): VizStatePayload {
  return makePayload({ errors: ['capture aborted: call-timeout at getFiltersAsync:Sheet A'] });
}

describe('startVizStateBridge', () => {
  let viz: TableauVizElement;
  let app: App;
  let dispose: (() => void) | undefined;

  /** Runs pending timers and flushes the microtasks the resulting async work queues. */
  const settle = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();

    viz = document.createElement('tableau-viz') as TableauVizElement;
    document.body.appendChild(viz);

    app = {
      getHostCapabilities: vi.fn().mockReturnValue({ updateModelContext: { text: true } }),
      updateModelContext: vi.fn().mockResolvedValue({}),
    } as unknown as App;

    vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(captureVizState).mockResolvedValue(makePayload());
    vi.mocked(pushVizState).mockResolvedValue(undefined);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('collapses a burst of interaction events into a single capture and push', async () => {
    const payload = makePayload();
    vi.mocked(captureVizState).mockResolvedValue(payload);

    dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

    for (let i = 0; i < 5; i++) {
      viz.dispatchEvent(new CustomEvent('filterchanged'));
    }

    expect(vi.mocked(captureVizState)).not.toHaveBeenCalled();

    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureVizState)).toHaveBeenCalledWith({
      viz,
      identity: IDENTITY,
      preferredSheetName: undefined,
      datasourceCache: expect.any(Map),
    });
    expect(vi.mocked(pushVizState)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushVizState)).toHaveBeenCalledWith(app, payload);
  });

  it.each(['parameterchanged', 'markselectionchanged', 'tabswitched', 'summarydatachanged'])(
    'captures on the %s event',
    async (eventName) => {
      dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

      viz.dispatchEvent(new CustomEvent(eventName));
      await settle(VIZ_SETTLE_DEBOUNCE_MS);

      expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);
    },
  );

  it('captures once the viz becomes interactive when pushOnLoad defaults on', async () => {
    dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

    viz.dispatchEvent(new CustomEvent('firstinteractive'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushVizState)).toHaveBeenCalledTimes(1);
  });

  it('collapses the load-time event burst into the same single capture', async () => {
    dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

    // What a dashboard with action filters actually emits on load.
    viz.dispatchEvent(new CustomEvent('firstinteractive'));
    viz.dispatchEvent(new CustomEvent('filterchanged'));
    viz.dispatchEvent(new CustomEvent('filterchanged'));
    viz.dispatchEvent(new CustomEvent('summarydatachanged'));

    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);
  });

  it('does not capture on load when pushOnLoad is false, but still captures on interaction', async () => {
    dispose = startVizStateBridge({ app, viz, identity: IDENTITY, pushOnLoad: false });

    viz.dispatchEvent(new CustomEvent('firstinteractive'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).not.toHaveBeenCalled();

    viz.dispatchEvent(new CustomEvent('filterchanged'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);
  });

  it('passes the worksheet named by the event as the preferred data sheet', async () => {
    dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

    viz.dispatchEvent(
      new CustomEvent('filterchanged', { detail: { worksheet: { name: 'Sheet B' } } }),
    );
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledWith(
      expect.objectContaining({ preferredSheetName: 'Sheet B' }),
    );
  });

  it('accepts the alternate detail.sheet.name spelling and ignores unusable detail', async () => {
    dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

    viz.dispatchEvent(
      new CustomEvent('markselectionchanged', { detail: { sheet: { name: 'Sheet C' } } }),
    );
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenLastCalledWith(
      expect.objectContaining({ preferredSheetName: 'Sheet C' }),
    );

    // A detail without a usable name must not clear the sheet chosen by the previous event.
    viz.dispatchEvent(new CustomEvent('filterchanged', { detail: { worksheet: { name: '' } } }));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenLastCalledWith(
      expect.objectContaining({ preferredSheetName: 'Sheet C' }),
    );
  });

  it('never runs two captures at once and coalesces everything that arrived meanwhile', async () => {
    let resolveCapture: ((payload: VizStatePayload) => void) | undefined;
    vi.mocked(captureVizState).mockImplementation(
      () =>
        new Promise<VizStatePayload>((resolve) => {
          resolveCapture = resolve;
        }),
    );

    dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

    viz.dispatchEvent(new CustomEvent('filterchanged'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);

    // Three more gestures while capture 1 is still running: none of them may start a capture.
    for (let i = 0; i < 3; i++) {
      viz.dispatchEvent(new CustomEvent('filterchanged'));
      await settle(VIZ_SETTLE_DEBOUNCE_MS);
    }

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);

    resolveCapture?.(makePayload());
    await settle(0);

    // The re-run goes back through the debounce window rather than firing immediately.
    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);

    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    // Exactly one follow-up capture for the three coalesced gestures, not three.
    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(2);
  });

  it('stops after consecutive aborted captures and pushes a reload-to-recover payload', async () => {
    vi.mocked(captureVizState).mockResolvedValue(makeAbortedPayload());

    dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

    viz.dispatchEvent(new CustomEvent('filterchanged'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushVizState).mock.calls[0][1].errors).not.toContain(CHANNEL_WEDGED_ERROR);

    viz.dispatchEvent(new CustomEvent('filterchanged'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pushVizState)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pushVizState).mock.calls[1][1].errors).toContain(CHANNEL_WEDGED_ERROR);

    // Self-disposed: nothing the user does afterwards starts another 15-second capture.
    viz.dispatchEvent(new CustomEvent('filterchanged'));
    viz.dispatchEvent(new CustomEvent('summarydatachanged'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS * 5);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pushVizState)).toHaveBeenCalledTimes(2);
  });

  it('resets the abort streak on a clean capture', async () => {
    vi.mocked(captureVizState)
      .mockResolvedValueOnce(makeAbortedPayload())
      .mockResolvedValueOnce(makePayload())
      .mockResolvedValueOnce(makeAbortedPayload());

    dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

    for (let i = 0; i < 3; i++) {
      viz.dispatchEvent(new CustomEvent('filterchanged'));
      await settle(VIZ_SETTLE_DEBOUNCE_MS);
    }

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(pushVizState)).toHaveBeenCalledTimes(3);

    for (const call of vi.mocked(pushVizState).mock.calls) {
      expect(call[1].errors ?? []).not.toContain(CHANNEL_WEDGED_ERROR);
    }

    // Still live: the streak never reached the limit.
    viz.dispatchEvent(new CustomEvent('filterchanged'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(4);
  });

  it('captures nothing after dispose, and disposing twice is safe', async () => {
    const stop = startVizStateBridge({ app, viz, identity: IDENTITY });

    viz.dispatchEvent(new CustomEvent('filterchanged'));
    stop();
    stop();

    await settle(VIZ_SETTLE_DEBOUNCE_MS * 5);

    expect(vi.mocked(captureVizState)).not.toHaveBeenCalled();

    viz.dispatchEvent(new CustomEvent('filterchanged'));
    viz.dispatchEvent(new CustomEvent('firstinteractive'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS * 5);

    expect(vi.mocked(captureVizState)).not.toHaveBeenCalled();
  });

  it('does not push a capture that finishes after dispose', async () => {
    let resolveCapture: ((payload: VizStatePayload) => void) | undefined;
    vi.mocked(captureVizState).mockImplementation(
      () =>
        new Promise<VizStatePayload>((resolve) => {
          resolveCapture = resolve;
        }),
    );

    const stop = startVizStateBridge({ app, viz, identity: IDENTITY });

    viz.dispatchEvent(new CustomEvent('filterchanged'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);

    // The element this snapshot describes is already gone by the time the capture answers, so the
    // snapshot is stale and must not be advertised as the current view.
    stop();
    resolveCapture?.(makePayload());
    await settle(VIZ_SETTLE_DEBOUNCE_MS * 5);

    expect(vi.mocked(pushVizState)).not.toHaveBeenCalled();
    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(1);
  });

  it('survives a capture that rejects', async () => {
    vi.mocked(captureVizState).mockRejectedValueOnce(new Error('unexpected'));

    dispose = startVizStateBridge({ app, viz, identity: IDENTITY });

    viz.dispatchEvent(new CustomEvent('filterchanged'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(pushVizState)).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '[mcp-app] viz state bridge failed',
      expect.any(Error),
    );

    // The next interaction still captures: one bad capture does not end the bridge.
    viz.dispatchEvent(new CustomEvent('filterchanged'));
    await settle(VIZ_SETTLE_DEBOUNCE_MS);

    expect(vi.mocked(captureVizState)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pushVizState)).toHaveBeenCalledTimes(1);
  });
});
