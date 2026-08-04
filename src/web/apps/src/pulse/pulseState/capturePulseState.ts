/**
 * @file Reads a snapshot of what the user currently sees in the embedded Pulse metric.
 *
 * Mirrors `embed/vizState/captureVizState.ts` in contract and in hazard model: the pipeline is
 * best-effort and never throws, every stage that fails contributes a line to `payload.errors`, and
 * a hung Embedding API call wedges the postMessage channel for the rest of the page's life — so
 * once the serial queue aborts, the remaining stages are skipped rather than attempted.
 *
 * Two differences from the viz capture are structural, not stylistic:
 *
 * 1. There is no numeric read here at all. `<tableau-pulse>` exposes no summary-data reader, and
 *    the metric's numbers belong to the Pulse insight APIs on the server side. The snapshot's job
 *    is to say what is configured and what Pulse said, and to point at the tools that can answer
 *    the numbers.
 * 2. Insights are pushed IN, not read out. There is no "list the insights currently shown" call;
 *    they arrive as `pulseinsightdiscovered` events, so the bridge accumulates them and hands the
 *    accumulated list to each capture.
 *
 * The shapes returned by `getFiltersAsync` / `getTimeDimensionAsync` are read tolerantly. They are
 * not a contract this repo owns, and a filter object whose fields are all unrecognized is recorded
 * as an unreadable filter rather than silently dropped — "no filters" and "filters this code could
 * not read" must not look the same to the model.
 */
import {
  sanitizeFiniteNumber,
  sanitizeString,
  sanitizeStrings,
} from '../../embed/vizState/sanitize.js';
import { CaptureAbortedError, SerialQueue } from '../../embed/vizState/serialQueue.js';
import type { TableauPulseElement } from './pulseEmbeddingApiTypes.js';
import {
  BASE_PULSE_CAVEATS,
  COMPACT_LAYOUT_CAVEAT,
  MAX_FILTER_VALUES,
  MAX_INSIGHT_TEXT_LENGTH,
  MAX_INSIGHTS,
  type PulseFilterSnapshot,
  type PulseInsightSnapshot,
  type PulseStatePayload,
  type PulseTimeDimensionSnapshot,
} from './pulsePayload.js';

/** Cap on any single Embedding API call. Generous: a healthy call answers in tens of milliseconds. */
export const PER_CALL_TIMEOUT_MS = 5_000;

/** Cap on the capture as a whole, so a slow-but-not-hung metric cannot stall the app indefinitely. */
export const OVERALL_CAPTURE_TIMEOUT_MS = 15_000;

/** Layouts that show less than the full metric, and so warrant a caveat on the pushed insights. */
const COMPACT_LAYOUTS = new Set(['card', 'ban']);

export type PulseIdentity = {
  id?: string;
  name?: string;
  layout?: string;
};

/** An insight as accumulated by the bridge, already sanitized. */
export type CapturedInsight = PulseInsightSnapshot;

export type PulseCaptureOptions = {
  pulse: TableauPulseElement;
  identity: PulseIdentity;
  /** Insights accumulated from `pulseinsightdiscovered`, most recently discovered last. */
  insights?: readonly CapturedInsight[];
  /** Injectable clock, so `capturedAt` is deterministic in tests. */
  now?: () => Date;
  /** Injectable queue, so timeout behaviour is testable. Aborted before this function returns. */
  queue?: SerialQueue;
};

/**
 * Captures the current Pulse metric state.
 *
 * Never throws. Every failure — missing API, unreadable filters, timeout — is reported in
 * `payload.errors` alongside whatever was successfully read.
 */
export async function capturePulseState(options: PulseCaptureOptions): Promise<PulseStatePayload> {
  const queue =
    options.queue ??
    new SerialQueue({
      callTimeoutMs: PER_CALL_TIMEOUT_MS,
      overallTimeoutMs: OVERALL_CAPTURE_TIMEOUT_MS,
    });

  const errors: string[] = [];
  let aborted = false;

  const payload: PulseStatePayload = {
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    metric: identityPart(options.identity),
    filters: [],
    insights: dedupeInsights(options.insights ?? []),
    caveats: [...BASE_PULSE_CAVEATS],
  };

  if (options.identity.layout !== undefined) {
    payload.layout = sanitizeString(options.identity.layout);

    if (COMPACT_LAYOUTS.has(payload.layout)) {
      payload.caveats.push(COMPACT_LAYOUT_CAVEAT);
    }
  }

  const finalize = (): PulseStatePayload => {
    if (errors.length > 0) {
      payload.errors = errors;
    }
    return payload;
  };

  /** First abort wins and stops the pipeline; later stages must not re-report it. */
  const noteAbort = (error: CaptureAbortedError): void => {
    if (!aborted) {
      aborted = true;
      errors.push(`capture aborted: ${error.reason} at ${error.label}`);
    }
  };

  try {
    // --- Filters -------------------------------------------------------------------------------
    const getFilters = options.pulse.getFiltersAsync;

    if (typeof getFilters !== 'function') {
      errors.push('filters unavailable: getFiltersAsync is not exposed by this Embedding API');
    } else {
      try {
        const filters = await queue.run('getFiltersAsync', () => getFilters.call(options.pulse));

        payload.filters = (filters ?? []).map(serializePulseFilter);
      } catch (error) {
        if (error instanceof CaptureAbortedError) {
          noteAbort(error);
        } else {
          errors.push(`filters unreadable: ${errorText(error)}`);
        }
      }
    }

    // --- Time dimension ------------------------------------------------------------------------
    if (!aborted) {
      const getTimeDimension = options.pulse.getTimeDimensionAsync;

      if (typeof getTimeDimension !== 'function') {
        errors.push(
          'time dimension unavailable: getTimeDimensionAsync is not exposed by this Embedding API',
        );
      } else {
        try {
          const timeDimension = await queue.run('getTimeDimensionAsync', () =>
            getTimeDimension.call(options.pulse),
          );

          const snapshot = serializeTimeDimension(timeDimension);
          if (snapshot !== undefined) {
            payload.timeDimension = snapshot;
          }
        } catch (error) {
          if (error instanceof CaptureAbortedError) {
            noteAbort(error);
          } else {
            errors.push(`time dimension unreadable: ${errorText(error)}`);
          }
        }
      }
    }

    return finalize();
  } catch (error) {
    // Belt and braces: nothing above is expected to escape, but a capture must never reject.
    errors.push(`capture failed: ${errorText(error)}`);
    return finalize();
  } finally {
    // Releases the overall timer. Idempotent, and the only thing that stops the queue's clock.
    queue.abort('disposed');
  }
}

/**
 * Projects a `pulseinsightdiscovered` detail onto the snapshot shape.
 *
 * Exported because the bridge calls it at event time rather than at capture time: the event is the
 * only place the insight exists, so it is sanitized on arrival and stored already-safe.
 */
export function serializeInsight(detail: unknown): PulseInsightSnapshot | undefined {
  if (detail === null || typeof detail !== 'object') {
    return undefined;
  }

  const source = detail as Record<string, unknown>;
  const snapshot: PulseInsightSnapshot = {};

  const id = sanitizeString(source.id);
  if (id !== '') {
    snapshot.id = id;
  }

  const type = sanitizeString(source.type);
  if (type !== '') {
    snapshot.type = type;
  }

  const question = sanitizeString(source.question);
  if (question !== '') {
    snapshot.question = question;
  }

  // `markup` is the rendered insight sentence, and the single largest field in a push. It is
  // author-and-model-generated Tableau content, so it goes through the same whitelist sanitizer as
  // everything else — markup tags survive as text, control characters and objects do not.
  const text = sanitizeString(source.markup, MAX_INSIGHT_TEXT_LENGTH);
  if (text !== '') {
    snapshot.text = text;
  }

  const score = sanitizeFiniteNumber(source.score);
  if (score !== undefined) {
    snapshot.score = score;
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/**
 * Keeps the most recent occurrence of each insight id and caps the list.
 *
 * Pulse re-announces an insight when the metric re-renders, so the accumulated list would otherwise
 * grow duplicates across a session. Insights without an id cannot be deduped and are all kept.
 */
function dedupeInsights(insights: readonly CapturedInsight[]): PulseInsightSnapshot[] {
  const byId = new Map<string, PulseInsightSnapshot>();
  const withoutId: PulseInsightSnapshot[] = [];

  for (const insight of insights) {
    if (insight.id === undefined) {
      withoutId.push(insight);
    } else {
      byId.set(insight.id, insight);
    }
  }

  return [...byId.values(), ...withoutId].slice(0, MAX_INSIGHTS);
}

/** Copies only the identity fields the caller supplied; absent stays absent. */
function identityPart(identity: PulseIdentity): { id?: string; name?: string } {
  const part: { id?: string; name?: string } = {};

  if (identity.id !== undefined) {
    part.id = sanitizeString(identity.id);
  }
  if (identity.name !== undefined) {
    part.name = sanitizeString(identity.name);
  }

  return part;
}

/**
 * Field name candidates, in preference order, for a Pulse filter object.
 *
 * The `_`-prefixed spellings are the own keys the Embedding API actually exposes — measured
 * 20260804 against Embedding API 3.16.0, where one filter carried `_fieldName` / `_filterType` /
 * `_appliedValues` / `_isExcludeMode` / `_isAllSelected` as own properties and `appliedValues` /
 * `isExcludeMode` / `isAllSelected` as prototype getters. They sit last so a future shape that
 * exposes public names keeps winning.
 */
const FILTER_FIELD_KEYS = ['field', 'fieldName', 'fieldCaption', '_field', '_fieldName'] as const;
const FILTER_OPERATOR_KEYS = ['operator', 'filterType', '_operator', '_filterType'] as const;
const FILTER_VALUE_KEYS = [
  'values',
  'appliedValues',
  'categoricalValues',
  '_values',
  '_appliedValues',
] as const;
const FILTER_EXCLUDE_MODE_KEYS = ['isExcludeMode', '_isExcludeMode'] as const;
const FILTER_ALL_SELECTED_KEYS = ['isAllSelected', '_isAllSelected'] as const;

/**
 * Whitelist projection of one filter. Only recognized keys are copied, and a filter object that
 * matches none of them yields a `note` instead of an empty-looking snapshot.
 */
function serializePulseFilter(filter: unknown): PulseFilterSnapshot {
  if (filter === null || typeof filter !== 'object') {
    return { field: '', note: 'unreadable filter: not an object' };
  }

  const source = filter as Record<string, unknown>;
  const snapshot: PulseFilterSnapshot = { field: firstString(source, FILTER_FIELD_KEYS) ?? '' };

  const operator = firstString(source, FILTER_OPERATOR_KEYS);
  if (operator !== undefined) {
    snapshot.operator = operator;
  }

  const rawValues = firstArray(source, FILTER_VALUE_KEYS);
  if (rawValues !== undefined) {
    const { values, truncated } = sanitizeStrings(rawValues.map(readValue), MAX_FILTER_VALUES);
    snapshot.values = values;
    snapshot.valuesTruncated = truncated;
  }

  // These two exist so an empty `values` can be read correctly. A Pulse filter at rest reports every
  // member selected as `isAllSelected: true` with an EMPTY applied-values list, which without this
  // flag is indistinguishable from "this code could not read the values" — and a model told a
  // filter has no values will under-claim what the user is actually looking at.
  const isExcludeMode = firstBoolean(source, FILTER_EXCLUDE_MODE_KEYS);
  if (isExcludeMode !== undefined) {
    snapshot.isExcludeMode = isExcludeMode;
  }

  const isAllSelected = firstBoolean(source, FILTER_ALL_SELECTED_KEYS);
  if (isAllSelected !== undefined) {
    snapshot.isAllSelected = isAllSelected;
  }

  if (snapshot.field === '' && snapshot.operator === undefined && snapshot.values === undefined) {
    snapshot.note = 'unrecognized filter shape; no known fields were present';
  }

  return snapshot;
}

/** Time dimension keys, read with the same tolerance as filters. */
const TIME_FIELD_KEYS = ['field', 'fieldName', '_field'] as const;
const TIME_GRANULARITY_KEYS = ['granularity', '_granularity'] as const;
const TIME_RANGE_KEYS = ['range', 'timeRange', '_range'] as const;

/** Projects the time dimension, or returns undefined when nothing recognizable was present. */
function serializeTimeDimension(value: unknown): PulseTimeDimensionSnapshot | undefined {
  // Measured 20260804: `getTimeDimensionAsync()` resolves to a bare STRING — `'MonthToDate'` — not
  // to an object. Reading only the object shape dropped the time dimension from every real capture.
  // The string names the range, so it lands in `range`; field and granularity stay absent because
  // this shape does not carry them.
  if (typeof value === 'string') {
    const range = sanitizeString(value);
    return range === '' ? undefined : { range };
  }

  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const snapshot: PulseTimeDimensionSnapshot = {};

  const field = firstString(source, TIME_FIELD_KEYS);
  if (field !== undefined) {
    snapshot.field = field;
  }

  const granularity = firstString(source, TIME_GRANULARITY_KEYS);
  if (granularity !== undefined) {
    snapshot.granularity = granularity;
  }

  const range = firstString(source, TIME_RANGE_KEYS);
  if (range !== undefined) {
    snapshot.range = range;
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/** First key that sanitizes to a non-empty string, or undefined. */
function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = sanitizeString(source[key]);
    if (value !== '') {
      return value;
    }
  }

  return undefined;
}

/** First key holding an actual boolean, or undefined. Truthy non-booleans are not coerced. */
function firstBoolean(
  source: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }

  return undefined;
}

/** First key holding an array, or undefined. */
function firstArray(
  source: Record<string, unknown>,
  keys: readonly string[],
): unknown[] | undefined {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return undefined;
}

/**
 * Reads one filter value, which is sometimes the primitive itself and sometimes a wrapper carrying
 * the display text. `sanitizeString` yields '' for anything else, so no shape can throw here.
 */
function readValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    const wrapper = value as Record<string, unknown>;
    return wrapper.formattedValue ?? wrapper.value ?? wrapper.string_value ?? '';
  }

  return value;
}

/** `sanitizeString` yields '' for anything that is not a primitive, so no `String(...)` throw. */
function errorText(error: unknown): string {
  return error instanceof Error ? sanitizeString(error.message) : sanitizeString(error);
}
