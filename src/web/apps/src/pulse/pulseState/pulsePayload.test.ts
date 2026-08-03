import { describe, expect, it } from 'vitest';

import { utf8ByteLength } from '../../embed/vizState/sanitize.js';
import {
  BASE_PULSE_CAVEATS,
  fitPulsePayloadToBudget,
  type PulseStatePayload,
  PUSH_BUDGET_BYTES,
} from './pulsePayload.js';

function makePayload(overrides: Partial<PulseStatePayload> = {}): PulseStatePayload {
  return {
    capturedAt: '2026-08-03T00:00:00.000Z',
    metric: { id: 'metric-1', name: 'Weekly Sales' },
    layout: 'default',
    filters: [],
    insights: [],
    caveats: [...BASE_PULSE_CAVEATS],
    ...overrides,
  };
}

function makeInsights(count: number, textLength: number): PulseStatePayload['insights'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `insight-${index}`,
    type: 'top-drivers',
    question: `Question ${index}`,
    text: 'x'.repeat(textLength),
    score: 0.5,
  }));
}

describe('fitPulsePayloadToBudget', () => {
  it('leaves a small payload untouched', () => {
    const payload = makePayload();
    const { text, trimmed } = fitPulsePayloadToBudget(payload);

    expect(trimmed).toBe(false);
    expect(JSON.parse(text)).toEqual(payload);
  });

  it('never mutates the caller payload', () => {
    const payload = makePayload({ insights: makeInsights(40, 2_000) });
    const before = JSON.stringify(payload);

    fitPulsePayloadToBudget(payload, 1_000);

    expect(JSON.stringify(payload)).toBe(before);
  });

  it('drops insight prose before dropping insights', () => {
    const payload = makePayload({ insights: makeInsights(10, 4_000) });

    const { text, trimmed } = fitPulsePayloadToBudget(payload, 5_000);
    const fitted = JSON.parse(text) as PulseStatePayload;

    expect(trimmed).toBe(true);
    expect(fitted.insights.length).toBeGreaterThan(0);
    expect(fitted.insights.every((insight) => insight.text === undefined)).toBe(true);
    expect(fitted.insights[0].question).toBeDefined();
  });

  it('strips filter values when insights alone are not enough', () => {
    const payload = makePayload({
      filters: Array.from({ length: 60 }, (_, index) => ({
        field: `Field ${index}`,
        values: Array.from({ length: 30 }, (_, valueIndex) => `value-${valueIndex}`),
        valuesTruncated: false,
      })),
    });

    const fitted = JSON.parse(fitPulsePayloadToBudget(payload, 4_000).text) as PulseStatePayload;

    expect(fitted.filters.every((filter) => filter.values === undefined)).toBe(true);
    expect(fitted.filters[0].field).toBe('Field 0');
  });

  it('falls back to identity only, keeping the metric identity', () => {
    const payload = makePayload({
      filters: Array.from({ length: 400 }, (_, index) => ({ field: `Field ${index}` })),
    });

    const fitted = JSON.parse(fitPulsePayloadToBudget(payload, 900).text) as PulseStatePayload;

    expect(fitted.metric).toEqual({ id: 'metric-1', name: 'Weekly Sales' });
    expect(fitted.filters).toEqual([]);
    expect(fitted.errors?.some((error) => error.includes('identity only'))).toBe(true);
  });

  it('can never return a string larger than the budget', () => {
    for (const budget of [60, 100, 500, 2_000, PUSH_BUDGET_BYTES]) {
      const payload = makePayload({
        insights: makeInsights(50, 3_000),
        filters: Array.from({ length: 200 }, (_, index) => ({
          field: `Field ${index}`,
          values: ['a', 'b', 'c'],
        })),
      });

      const { text, bytes } = fitPulsePayloadToBudget(payload, budget);

      expect(utf8ByteLength(text)).toBe(bytes);
      expect(bytes).toBeLessThanOrEqual(budget);
    }
  });

  it('returns the fixed failure JSON when no output can fit', () => {
    const { text } = fitPulsePayloadToBudget(makePayload(), 50);
    expect(text).toBe('{"error":"pulse state snapshot did not fit"}');
  });
});
