/**
 * @vitest-environment jsdom
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { capturePulseState } from './capturePulseState.js';
import { BASE_PULSE_CAVEATS, type PulseStatePayload } from './pulsePayload.js';
import { FAKE_PULSE_EMBED_TOKEN, makeFakePulseElement } from './pulseTestFakes.js';
import { PULSE_PUSH_PREAMBLE, pushPulseState } from './pushPulseState.js';

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

function makeApp(capabilities: unknown = { updateModelContext: { text: true } }): App {
  return {
    getHostCapabilities: vi.fn().mockReturnValue(capabilities),
    updateModelContext: vi.fn().mockResolvedValue({}),
    callServerTool: vi.fn().mockResolvedValue({}),
  } as unknown as App;
}

describe('pushPulseState', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushes the preamble followed by the JSON', async () => {
    const app = makeApp();

    await pushPulseState(app, makePayload());

    const call = vi.mocked(app.updateModelContext).mock.calls[0][0] as {
      content: Array<{ text: string }>;
    };
    const text = call.content[0].text;

    expect(text.startsWith(PULSE_PUSH_PREAMBLE)).toBe(true);
    expect(JSON.parse(text.slice(PULSE_PUSH_PREAMBLE.length + 1)).metric.id).toBe('metric-1');
  });

  it('names the tools that can answer a numeric question', () => {
    expect(PULSE_PUSH_PREAMBLE).toContain('generate-pulse-metric-value-insight-bundle');
    expect(PULSE_PUSH_PREAMBLE).toContain('query-datasource');
    // The leak test rejects any pushed text matching /token/i; the preamble must satisfy it too.
    expect(PULSE_PUSH_PREAMBLE).not.toMatch(/token/i);
  });

  it('does nothing when the host cannot accept context updates', async () => {
    const app = makeApp({});

    await pushPulseState(app, makePayload());

    expect(app.updateModelContext).not.toHaveBeenCalled();
  });

  it('never throws when the push fails', async () => {
    const app = makeApp();
    vi.mocked(app.updateModelContext).mockRejectedValue(new Error('host refused'));

    await expect(pushPulseState(app, makePayload())).resolves.toBeUndefined();
  });

  it('never pushes the embed credential, through the real capture-and-push path', async () => {
    const app = makeApp();

    const payload = await capturePulseState({
      pulse: makeFakePulseElement(),
      identity: { id: 'metric-1', name: 'Weekly Sales', layout: 'default' },
      insights: [{ id: 'i1', text: 'Sales grew in the West.' }],
    });

    await pushPulseState(app, payload);

    const call = vi.mocked(app.updateModelContext).mock.calls[0][0] as {
      content: Array<{ text: string }>;
    };
    const text = call.content[0].text;

    expect(text).not.toContain(FAKE_PULSE_EMBED_TOKEN);
    expect(text).not.toMatch(/token/i);
  });
});
