/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';

import { SerialQueue } from '../../embed/vizState/serialQueue.js';
import {
  capturePulseState,
  OVERALL_CAPTURE_TIMEOUT_MS,
  PER_CALL_TIMEOUT_MS,
  serializeInsight,
} from './capturePulseState.js';
import { COMPACT_LAYOUT_CAVEAT, MAX_INSIGHT_TEXT_LENGTH } from './pulsePayload.js';
import {
  FAKE_PULSE_EMBED_TOKEN,
  makeFakePulseElement,
  makeHangingPulseElement,
  makeInsightDetail,
  makeMeasuredPulseFilter,
} from './pulseTestFakes.js';

const IDENTITY = { id: 'metric-1', name: 'Weekly Sales' };

const NOW = (): Date => new Date('2026-08-03T00:00:00.000Z');

describe('capturePulseState', () => {
  it('captures identity, filters and the time dimension', async () => {
    const payload = await capturePulseState({
      pulse: makeFakePulseElement(),
      identity: IDENTITY,
      now: NOW,
    });

    expect(payload.capturedAt).toBe('2026-08-03T00:00:00.000Z');
    expect(payload.metric).toEqual({ id: 'metric-1', name: 'Weekly Sales' });
    expect(payload.filters).toEqual([
      {
        field: 'Region',
        operator: 'OPERATOR_EQUAL',
        values: ['West', 'East'],
        valuesTruncated: false,
      },
    ]);
    expect(payload.timeDimension).toEqual({
      field: 'Order Date',
      granularity: 'GRANULARITY_BY_MONTH',
      range: 'RANGE_LAST_12_MONTHS',
    });
    expect(payload.errors).toBeUndefined();
  });

  it('never captures a numeric value or the embed credential', async () => {
    const payload = await capturePulseState({
      pulse: makeFakePulseElement(),
      identity: IDENTITY,
      insights: [{ id: 'i1', text: 'Sales grew.' }],
    });

    const text = JSON.stringify(payload);
    expect(text).not.toContain(FAKE_PULSE_EMBED_TOKEN);
    expect(text).not.toMatch(/token/i);
  });

  it('records the layout and caveats a compact one', async () => {
    const payload = await capturePulseState({
      pulse: makeFakePulseElement(),
      identity: { ...IDENTITY, layout: 'ban' },
    });

    expect(payload.layout).toBe('ban');
    expect(payload.caveats).toContain(COMPACT_LAYOUT_CAVEAT);
  });

  it('does not caveat the default layout', async () => {
    const payload = await capturePulseState({
      pulse: makeFakePulseElement(),
      identity: { ...IDENTITY, layout: 'default' },
    });

    expect(payload.caveats).not.toContain(COMPACT_LAYOUT_CAVEAT);
  });

  it('reports a missing filters API without failing the capture', async () => {
    const pulse = makeFakePulseElement();
    delete (pulse as { getFiltersAsync?: unknown }).getFiltersAsync;

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.filters).toEqual([]);
    expect(payload.errors?.[0]).toContain('getFiltersAsync');
    // The time dimension is still read: one missing API must not skip the rest.
    expect(payload.timeDimension).toBeDefined();
  });

  it('reports an unreadable filters call without failing the capture', async () => {
    const pulse = makeFakePulseElement({
      getFiltersAsync: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.errors?.some((error) => error.includes('boom'))).toBe(true);
    expect(payload.timeDimension).toBeDefined();
  });

  it('marks an unrecognized filter shape instead of reporting an empty filter', async () => {
    const pulse = makeFakePulseElement({
      getFiltersAsync: vi.fn().mockResolvedValue([{ somethingElse: true }]),
    });

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.filters[0].note).toContain('unrecognized filter shape');
  });

  it('reads filter values that arrive as wrapper objects', async () => {
    const pulse = makeFakePulseElement({
      getFiltersAsync: vi
        .fn()
        .mockResolvedValue([
          { fieldName: 'Segment', appliedValues: [{ formattedValue: 'Consumer' }] },
        ]),
    });

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.filters[0]).toMatchObject({ field: 'Segment', values: ['Consumer'] });
  });

  // The shape below is the one measured against Embedding API 3.16.0 on 20260804: underscore-
  // prefixed own keys, and an empty applied-values list that means "everything is selected".
  it('reads the measured underscore-prefixed filter shape', async () => {
    const pulse = makeFakePulseElement({
      getFiltersAsync: vi.fn().mockResolvedValue([makeMeasuredPulseFilter()]),
    });

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.filters[0]).toEqual({
      field: 'Region',
      operator: 'categorical',
      values: [],
      valuesTruncated: false,
      isExcludeMode: false,
      isAllSelected: true,
    });
    expect(payload.filters[0].note).toBeUndefined();
  });

  it('reads the measured filter shape through prototype getters', async () => {
    // The real filter exposes `appliedValues` / `isExcludeMode` / `isAllSelected` on the prototype
    // as well, so the projection must not depend on them being own keys.
    const prototype = {
      get appliedValues(): unknown[] {
        return [{ formattedValue: 'West' }];
      },
      get isExcludeMode(): boolean {
        return true;
      },
      get isAllSelected(): boolean {
        return false;
      },
    };
    const filter = Object.assign(Object.create(prototype) as object, {
      _fieldName: 'Region',
      _filterType: 'categorical',
    });

    const pulse = makeFakePulseElement({
      getFiltersAsync: vi.fn().mockResolvedValue([filter]),
    });

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.filters[0]).toMatchObject({
      field: 'Region',
      operator: 'categorical',
      values: ['West'],
      isExcludeMode: true,
      isAllSelected: false,
    });
  });

  it('omits the boolean filter flags when they are not booleans', async () => {
    const pulse = makeFakePulseElement({
      getFiltersAsync: vi.fn().mockResolvedValue([
        {
          _fieldName: 'Region',
          _appliedValues: [],
          _isExcludeMode: 'false',
          _isAllSelected: 1,
        },
      ]),
    });

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.filters[0].isExcludeMode).toBeUndefined();
    expect(payload.filters[0].isAllSelected).toBeUndefined();
  });

  // Measured 20260804: the call resolves to a bare string ('MonthToDate'), not to an object.
  it('reads a time dimension that arrives as a bare string', async () => {
    const pulse = makeFakePulseElement({
      getTimeDimensionAsync: vi.fn().mockResolvedValue('MonthToDate'),
    });

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.timeDimension).toEqual({ range: 'MonthToDate' });
    expect(payload.errors).toBeUndefined();
  });

  it('omits the time dimension when the string is empty', async () => {
    const pulse = makeFakePulseElement({
      getTimeDimensionAsync: vi.fn().mockResolvedValue('   '),
    });

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.timeDimension).toBeUndefined();
  });

  it('omits the time dimension when nothing recognizable came back', async () => {
    const pulse = makeFakePulseElement({
      getTimeDimensionAsync: vi.fn().mockResolvedValue({ unknownKey: 1 }),
    });

    const payload = await capturePulseState({ pulse, identity: IDENTITY });

    expect(payload.timeDimension).toBeUndefined();
  });

  it('dedupes accumulated insights by id, keeping the most recent', async () => {
    const payload = await capturePulseState({
      pulse: makeFakePulseElement(),
      identity: IDENTITY,
      insights: [
        { id: 'i1', text: 'old' },
        { id: 'i1', text: 'new' },
        { id: 'i2', text: 'other' },
      ],
    });

    expect(payload.insights).toEqual([
      { id: 'i1', text: 'new' },
      { id: 'i2', text: 'other' },
    ]);
  });

  it('keeps every insight that has no id', async () => {
    const payload = await capturePulseState({
      pulse: makeFakePulseElement(),
      identity: IDENTITY,
      insights: [{ text: 'a' }, { text: 'b' }],
    });

    expect(payload.insights).toHaveLength(2);
  });

  it('aborts the remaining stages when a call hangs', async () => {
    vi.useFakeTimers();

    try {
      const queue = new SerialQueue({
        callTimeoutMs: PER_CALL_TIMEOUT_MS,
        overallTimeoutMs: OVERALL_CAPTURE_TIMEOUT_MS,
      });

      const promise = capturePulseState({
        pulse: makeHangingPulseElement(),
        identity: IDENTITY,
        queue,
      });

      await vi.advanceTimersByTimeAsync(PER_CALL_TIMEOUT_MS + 10);
      const payload = await promise;

      expect(payload.errors?.some((error) => error.startsWith('capture aborted:'))).toBe(true);
      // Exactly one abort line: later stages must not re-report it.
      expect(payload.errors?.filter((error) => error.startsWith('capture aborted:'))).toHaveLength(
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('serializeInsight', () => {
  it('projects the whitelisted fields', () => {
    expect(serializeInsight(makeInsightDetail())).toEqual({
      id: 'insight-1',
      type: 'top-drivers',
      question: 'What is driving the change?',
      text: 'Sales in the West region grew fastest.',
      score: 0.82,
    });
  });

  it('drops fields that are not primitives', () => {
    const insight = serializeInsight(makeInsightDetail({ markup: { nested: 'object' } }));
    expect(insight?.text).toBeUndefined();
  });

  it('caps very long insight prose', () => {
    const insight = serializeInsight(makeInsightDetail({ markup: 'x'.repeat(5_000) }));
    // The sanitizer appends a truncation marker, so the cap is a code-point ceiling plus one.
    expect((insight?.text ?? '').length).toBeLessThanOrEqual(MAX_INSIGHT_TEXT_LENGTH + 1);
  });

  it('returns undefined for a detail with nothing usable', () => {
    expect(serializeInsight(undefined)).toBeUndefined();
    expect(serializeInsight('not an object')).toBeUndefined();
    expect(serializeInsight({})).toBeUndefined();
  });
});
