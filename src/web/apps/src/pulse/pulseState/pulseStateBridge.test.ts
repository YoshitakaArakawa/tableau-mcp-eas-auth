/**
 * @vitest-environment jsdom
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./capturePulseState.js', async (importOriginal) => {
  // `serializeInsight` stays real: the bridge's insight accumulation is what these tests exercise.
  const actual = await importOriginal<typeof import('./capturePulseState.js')>();
  return { ...actual, capturePulseState: vi.fn() };
});
vi.mock('./pushPulseState.js');

import { capturePulseState, type PulseIdentity } from './capturePulseState.js';
import { PULSE_FIRST_SIZE_EVENT, type TableauPulseElement } from './pulseEmbeddingApiTypes.js';
import { BASE_PULSE_CAVEATS, type PulseStatePayload } from './pulsePayload.js';
import {
  MAX_CONSECUTIVE_TIMEOUTS,
  PULSE_CHANNEL_WEDGED_ERROR,
  PULSE_SETTLE_DEBOUNCE_MS,
  startPulseStateBridge,
} from './pulseStateBridge.js';
import { makeInsightDetail } from './pulseTestFakes.js';
import { pushPulseState } from './pushPulseState.js';

const IDENTITY: PulseIdentity = { id: 'metric-1', name: 'Weekly Sales' };

function makePayload(overrides: Partial<PulseStatePayload> = {}): PulseStatePayload {
  return {
    capturedAt: '2026-08-03T00:00:00.000Z',
    metric: { id: 'metric-1', name: 'Weekly Sales' },
    filters: [],
    insights: [],
    caveats: [...BASE_PULSE_CAVEATS],
    ...overrides,
  };
}

function makeAbortedPayload(): PulseStatePayload {
  return makePayload({ errors: ['capture aborted: call-timeout at getFiltersAsync'] });
}

describe('startPulseStateBridge', () => {
  let pulse: TableauPulseElement;
  let app: App;
  let dispose: (() => void) | undefined;

  const settle = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();

    pulse = document.createElement('tableau-pulse') as TableauPulseElement;
    document.body.appendChild(pulse);

    app = {
      getHostCapabilities: vi.fn().mockReturnValue({ updateModelContext: { text: true } }),
      updateModelContext: vi.fn().mockResolvedValue({}),
    } as unknown as App;

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.mocked(capturePulseState).mockResolvedValue(makePayload());
    vi.mocked(pushPulseState).mockResolvedValue(undefined);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('captures once the metric reports its first size', async () => {
    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY });

    pulse.dispatchEvent(new CustomEvent(PULSE_FIRST_SIZE_EVENT, { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS);

    expect(capturePulseState).toHaveBeenCalledTimes(1);
    expect(pushPulseState).toHaveBeenCalledTimes(1);
  });

  it('does not capture on load when pushOnLoad is false', async () => {
    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    pulse.dispatchEvent(new CustomEvent(PULSE_FIRST_SIZE_EVENT, { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS);

    expect(capturePulseState).not.toHaveBeenCalled();
  });

  it('collapses a burst of interaction events into one capture', async () => {
    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS / 2);
    pulse.dispatchEvent(new CustomEvent('pulsetimedimensionchanged', { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS / 2);
    pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS);

    expect(capturePulseState).toHaveBeenCalledTimes(1);
  });

  it('accumulates discovered insights and hands them to the capture', async () => {
    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    pulse.dispatchEvent(
      new CustomEvent('pulseinsightdiscovered', { detail: makeInsightDetail({ id: 'a' }) }),
    );
    pulse.dispatchEvent(
      new CustomEvent('pulseinsightdiscovered', { detail: makeInsightDetail({ id: 'b' }) }),
    );
    await settle(PULSE_SETTLE_DEBOUNCE_MS);

    const options = vi.mocked(capturePulseState).mock.calls[0][0];
    expect(options.insights?.map((insight) => insight.id)).toEqual(['a', 'b']);
  });

  it('ignores an insight event whose detail carries nothing usable', async () => {
    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    pulse.dispatchEvent(new CustomEvent('pulseinsightdiscovered', { detail: undefined }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS);

    // Still a trigger — the event means the metric changed even when the payload is unreadable.
    expect(capturePulseState).toHaveBeenCalledTimes(1);
    expect(vi.mocked(capturePulseState).mock.calls[0][0].insights).toEqual([]);
  });

  it('does not start an overlapping capture, and re-runs afterwards', async () => {
    let release: ((payload: PulseStatePayload) => void) | undefined;
    vi.mocked(capturePulseState).mockImplementationOnce(
      () =>
        new Promise<PulseStatePayload>((resolve) => {
          release = resolve;
        }),
    );

    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS);
    expect(capturePulseState).toHaveBeenCalledTimes(1);

    // A second gesture while the first capture is still running must not start a second capture.
    pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS);
    expect(capturePulseState).toHaveBeenCalledTimes(1);

    release?.(makePayload());
    await settle(PULSE_SETTLE_DEBOUNCE_MS);
    expect(capturePulseState).toHaveBeenCalledTimes(2);
  });

  it('stops after consecutive aborted captures, pushing a final degraded payload', async () => {
    vi.mocked(capturePulseState).mockResolvedValue(makeAbortedPayload());

    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    for (let i = 0; i < MAX_CONSECUTIVE_TIMEOUTS; i++) {
      pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
      await settle(PULSE_SETTLE_DEBOUNCE_MS);
    }

    const lastPush = vi.mocked(pushPulseState).mock.calls.at(-1)?.[1];
    expect(lastPush?.errors).toContain(PULSE_CHANNEL_WEDGED_ERROR);

    // The bridge disposed itself: further events do nothing.
    const capturesSoFar = vi.mocked(capturePulseState).mock.calls.length;
    pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS);
    expect(capturePulseState).toHaveBeenCalledTimes(capturesSoFar);
  });

  it('resets the abort counter after a healthy capture', async () => {
    vi.mocked(capturePulseState).mockResolvedValueOnce(makeAbortedPayload());

    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    for (let i = 0; i < MAX_CONSECUTIVE_TIMEOUTS + 1; i++) {
      pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
      await settle(PULSE_SETTLE_DEBOUNCE_MS);
    }

    expect(
      vi
        .mocked(pushPulseState)
        .mock.calls.some(([, payload]) => payload.errors?.includes(PULSE_CHANNEL_WEDGED_ERROR)),
    ).toBe(false);
  });

  it('stops capturing after dispose, and dispose is idempotent', async () => {
    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    dispose();
    dispose();

    pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS);

    expect(capturePulseState).not.toHaveBeenCalled();
  });

  it('does not push a capture that finished after dispose', async () => {
    let release: ((payload: PulseStatePayload) => void) | undefined;
    vi.mocked(capturePulseState).mockImplementationOnce(
      () =>
        new Promise<PulseStatePayload>((resolve) => {
          release = resolve;
        }),
    );

    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
    await settle(PULSE_SETTLE_DEBOUNCE_MS);

    dispose();
    release?.(makePayload());
    await settle(PULSE_SETTLE_DEBOUNCE_MS);

    expect(pushPulseState).not.toHaveBeenCalled();
  });

  it('never lets a capture failure escape', async () => {
    vi.mocked(capturePulseState).mockRejectedValue(new Error('capture exploded'));

    dispose = startPulseStateBridge({ app, pulse, identity: IDENTITY, pushOnLoad: false });

    pulse.dispatchEvent(new CustomEvent('pulsefilterschanged', { detail: {} }));
    await expect(settle(PULSE_SETTLE_DEBOUNCE_MS)).resolves.toBeUndefined();
  });
});
