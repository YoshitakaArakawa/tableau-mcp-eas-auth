/**
 * @file TEST-ONLY builders for `<tableau-pulse>` fakes.
 *
 * Not production code, and deliberately not named `*.test.ts` so vitest does not collect it as a
 * suite. Mirrors `embed/vizState/testFakes.ts`.
 */
import { vi } from 'vitest';

import type { TableauPulseElement } from './pulseEmbeddingApiTypes.js';

/**
 * Stand-in for the embed JWT the real `<tableau-pulse>` carries in its `token` attribute.
 * Exported so the leak test can assert this literal never reaches the pushed model context.
 */
export const FAKE_PULSE_EMBED_TOKEN =
  'fake-embed-jwt-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.cHVsc2U';

export function makePulseFilter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    field: 'Region',
    operator: 'OPERATOR_EQUAL',
    values: ['West', 'East'],
    ...overrides,
  };
}

/**
 * A filter in the shape actually measured against Embedding API 3.16.0 on 20260804: underscore-
 * prefixed own keys, and an empty applied-values list paired with `_isAllSelected: true`.
 *
 * Kept alongside `makePulseFilter` rather than replacing it — the tolerant projection has to keep
 * reading both, because the underscore names are internal and can change without notice.
 */
export function makeMeasuredPulseFilter(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _fieldName: 'Region',
    _filterType: 'categorical',
    // Present in the real shape and deliberately NOT whitelisted: the exact-shape assertion in the
    // capture test doubles as proof that unrecognized keys are dropped rather than passed through.
    _metricId: 'fake-metric-id',
    _registryId: 0,
    _appliedValues: [],
    _isExcludeMode: false,
    _isAllSelected: true,
    ...overrides,
  };
}

export function makeTimeDimension(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    field: 'Order Date',
    granularity: 'GRANULARITY_BY_MONTH',
    range: 'RANGE_LAST_12_MONTHS',
    ...overrides,
  };
}

/** The detail of a `pulseinsightdiscovered` event. */
export function makeInsightDetail(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'insight-1',
    type: 'top-drivers',
    question: 'What is driving the change?',
    markup: 'Sales in the West region grew fastest.',
    score: 0.82,
    ...overrides,
  };
}

/**
 * A `<tableau-pulse>` element as the Embedding API leaves it: the embed JWT sits in an attribute,
 * so a capture that walked the object graph instead of reading whitelisted fields would reach it.
 *
 * Requires a DOM (`@vitest-environment jsdom`).
 */
export function makeFakePulseElement(
  overrides: Partial<TableauPulseElement> = {},
): TableauPulseElement {
  const element = document.createElement('tableau-pulse') as TableauPulseElement;
  element.setAttribute('src', 'https://tableau.example.com/pulse/site/example/metrics/metric-1');
  element.setAttribute('token', FAKE_PULSE_EMBED_TOKEN);

  Object.assign(
    element,
    {
      getFiltersAsync: vi.fn().mockResolvedValue([makePulseFilter()]),
      getTimeDimensionAsync: vi.fn().mockResolvedValue(makeTimeDimension()),
    },
    overrides,
  );

  return element;
}

/**
 * Every method returns a promise that never settles — the measured failure mode of an invalid
 * Embedding API call, which also wedges the postMessage channel for the rest of the page's life.
 */
export function makeHangingPulseElement(): TableauPulseElement {
  const hang = <T>(): Promise<T> => new Promise<T>(() => {});

  return makeFakePulseElement({
    getFiltersAsync: () => hang(),
    getTimeDimensionAsync: () => hang(),
  });
}
