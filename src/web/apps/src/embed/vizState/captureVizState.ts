/**
 * @file Reads a snapshot of what the user currently sees in the embedded viz.
 *
 * The whole pipeline is best-effort and never throws: every stage that fails contributes a line to
 * `payload.errors` and the capture moves on, so a viz that only half-answers still produces a
 * useful snapshot. The one exception is an abort — a hung Embedding API call wedges the
 * postMessage channel for the rest of the page's life, so once the queue aborts, every remaining
 * stage is skipped rather than attempted.
 *
 * Measured behaviours encoded here (see the phase-0 measurements):
 * - `Dashboard.getFiltersAsync()` drops the (worksheet, fieldId) pairing, so filters are read per
 *   worksheet and deduped by `fieldId`. Deduping by `fieldName` would be wrong: a categorical and
 *   a range filter on the same field share a name and differ only in the id suffix (`:ok` / `:qk`).
 * - A categorical 'select all' reports `appliedValues: []` with `isAllSelected: true`, and a third
 *   state (neither) is real, hence `selectionState` rather than a bare boolean.
 * - `getAppliedWorksheetsAsync` returns worksheets that are not on the dashboard (12 returned for a
 *   4-worksheet dashboard), so the result is intersected with the on-screen sheet names.
 * - A parameter's `currentValue.value` carries float artifacts ('18.399999999999999'), so only
 *   `formattedValue` is read; the return order changes between page loads, so parameters are sorted.
 * - With nothing selected, `getSelectedMarksAsync` returns one 0x0 table rather than an empty array.
 * - A dashboard `activeSheet` carries `worksheets`; a worksheet one does not. The branch is
 *   structural for that reason — `sheetType` is treated as a label only.
 *
 * `fitPayloadToBudget` is deliberately NOT applied here: this returns the full snapshot, and the
 * push step is what has to fit a budget.
 */
import { captureSummaryData, SUMMARY_DATA_MISSING_API_ERROR } from './captureSummaryData.js';
import type {
  TableauFilter,
  TableauVizElement,
  TableauWorkbook,
  TableauWorksheet,
} from './embeddingApiTypes.js';
import {
  ACTION_SOURCE_CAVEAT,
  BASE_CAVEATS,
  DASHBOARD_DATA_CAVEAT,
  DATASOURCE_QUERY_CAVEAT,
  type DatasourceRef,
  type FilterSnapshot,
  MAX_DATASOURCES,
  MAX_FIELD_ID_LENGTH,
  MAX_FILTER_VALUES,
  MAX_SELECTED_MARKS,
  MAX_SESSION_VALUE_LENGTH,
  VDS_SESSION_CAVEAT,
  type VdsSessionRef,
  type VizStatePayload,
} from './payload.js';
import { sanitizeFiniteNumber, sanitizeString, sanitizeStrings } from './sanitize.js';
import { CaptureAbortedError, SerialQueue } from './serialQueue.js';

/** Cap on any single Embedding API call. Generous: a healthy call answers in tens of milliseconds. */
export const PER_CALL_TIMEOUT_MS = 5_000;

/** Cap on the capture as a whole, so a slow-but-not-hung viz cannot stall the app indefinitely. */
export const OVERALL_CAPTURE_TIMEOUT_MS = 15_000;

/**
 * `appliedTo` costs one Embedding API round trip per filter. Past this many filters the snapshot is
 * already dense enough that the extra calls buy less than the latency and hang risk they add.
 */
export const MAX_FILTERS_WITH_APPLIED_TO = 25;

/** Filter names produced by a dashboard action carry this prefix. */
const ACTION_FILTER_PREFIX = 'Action (';

export type VizIdentity = {
  workbook: { name?: string; luid?: string };
  view: { name?: string; luid?: string };
};

export type CaptureOptions = {
  viz: TableauVizElement;
  identity: VizIdentity;
  /** Worksheet whose summary data to sample. Falls back to the first readable worksheet. */
  preferredSheetName?: string;
  /** Injectable clock, so `capturedAt` is deterministic in tests. */
  now?: () => Date;
  /** Injectable queue, so timeout behaviour is testable. Aborted before this function returns. */
  queue?: SerialQueue;
  /**
   * Cross-capture cache of datasource refs, keyed by sheet name. The docs warn that
   * `getDataSourcesAsync` can hurt viz responsiveness, and a sheet's datasources do not change
   * within a page's life, so the bridge shares one cache across every capture it runs. A failed
   * read is not cached — it retries on the next capture.
   */
  datasourceCache?: Map<string, DatasourceRef[]>;
};

/**
 * Captures the current viz state.
 *
 * Never throws. Every failure — missing API, unreadable sheet, timeout, story sheet — is reported
 * in `payload.errors` alongside whatever was successfully read.
 */
export async function captureVizState(options: CaptureOptions): Promise<VizStatePayload> {
  const queue =
    options.queue ??
    new SerialQueue({
      callTimeoutMs: PER_CALL_TIMEOUT_MS,
      overallTimeoutMs: OVERALL_CAPTURE_TIMEOUT_MS,
    });

  const errors: string[] = [];
  let aborted = false;

  const payload: VizStatePayload = {
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    workbook: identityPart(options.identity.workbook),
    view: identityPart(options.identity.view),
    activeSheet: {},
    filters: [],
    parameters: [],
    selection: { marks: [], columns: [], truncated: false },
    caveats: [...BASE_CAVEATS],
  };

  const finalize = (): VizStatePayload => {
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
    const workbook: TableauWorkbook | undefined = options.viz.workbook;
    if (!workbook) {
      errors.push('viz workbook is not available');
      return finalize();
    }

    // Backfill the workbook name from the viz, but never invent luids: an identity the caller did
    // not supply is an identity we do not know.
    if (payload.workbook.name === undefined && workbook.name !== undefined) {
      payload.workbook.name = sanitizeString(workbook.name);
    }

    const activeSheet = workbook.activeSheet;
    if (!activeSheet) {
      errors.push('viz active sheet is not available');
      return finalize();
    }

    payload.activeSheet = {
      name: sanitizeString(activeSheet.name),
      sheetType: sanitizeString(activeSheet.sheetType),
    };

    if (activeSheet.sheetType === 'story') {
      errors.push('story sheets are not supported; the current story point cannot be read');
      return finalize();
    }

    // Structural branch: only a dashboard's active sheet carries `worksheets`.
    const isDashboard = Array.isArray(activeSheet.worksheets);
    const sheets: TableauWorksheet[] = isDashboard ? (activeSheet.worksheets ?? []) : [activeSheet];

    if (isDashboard && sheets.length > 1) {
      payload.caveats.push(DASHBOARD_DATA_CAVEAT);
    }

    const onScreenSheetNames = new Set(
      sheets.map((sheet) => sheet.name).filter((name): name is string => typeof name === 'string'),
    );

    // --- Filters -------------------------------------------------------------------------------
    const rawFilters: TableauFilter[] = [];
    const seenFilterKeys = new Set<string>();

    for (const sheet of sheets) {
      if (aborted) {
        break;
      }

      const getFilters = sheet.getFiltersAsync;
      if (typeof getFilters !== 'function') {
        continue;
      }

      try {
        const sheetFilters = await queue.run(`getFiltersAsync:${sanitizeString(sheet.name)}`, () =>
          getFilters.call(sheet),
        );

        for (const filter of sheetFilters ?? []) {
          // Dedupe on the RAW field id, before any length capping, so two ids that share a
          // 120-character prefix are still treated as distinct filters.
          const key =
            filter.fieldId !== undefined
              ? `id:${filter.fieldId}`
              : `name:${filter.fieldName ?? ''}`;

          if (seenFilterKeys.has(key)) {
            continue;
          }

          seenFilterKeys.add(key);
          rawFilters.push(filter);
        }
      } catch (error) {
        if (error instanceof CaptureAbortedError) {
          noteAbort(error);
          break;
        }

        errors.push(`sheet unreadable: ${sanitizeString(sheet.name)} (${errorText(error)})`);
      }
    }

    payload.filters = rawFilters.map(serializeFilter);

    if (payload.filters.some((filter) => filter.source === 'action')) {
      payload.caveats.push(ACTION_SOURCE_CAVEAT);
    }

    // --- appliedTo -----------------------------------------------------------------------------
    let appliedToBudget = MAX_FILTERS_WITH_APPLIED_TO;

    for (let index = 0; index < rawFilters.length; index++) {
      if (aborted || appliedToBudget <= 0) {
        break;
      }

      const filter = rawFilters[index];
      const getAppliedWorksheets = filter.getAppliedWorksheetsAsync;
      if (typeof getAppliedWorksheets !== 'function') {
        continue;
      }

      appliedToBudget--;

      try {
        const applied = await queue.run(
          `getAppliedWorksheetsAsync:${payload.filters[index].field}`,
          () => getAppliedWorksheets.call(filter),
        );

        payload.filters[index].appliedTo = (applied ?? [])
          .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
          .filter((name): name is string => typeof name === 'string')
          .filter((name) => onScreenSheetNames.has(name))
          .map((name) => sanitizeString(name));
      } catch (error) {
        if (error instanceof CaptureAbortedError) {
          noteAbort(error);
          break;
        }

        // Not fatal, and not worth an error line per filter: the field simply stays absent.
      }
    }

    // --- Parameters ----------------------------------------------------------------------------
    if (!aborted) {
      const getParameters = workbook.getParametersAsync;

      if (typeof getParameters !== 'function') {
        errors.push('parameters unavailable: getParametersAsync requires Embedding API 3.2+');
      } else {
        try {
          const parameters = await queue.run('getParametersAsync', () =>
            getParameters.call(workbook),
          );

          payload.parameters = (parameters ?? [])
            .map((parameter) => ({
              name: sanitizeString(parameter.name),
              // `value` carries float artifacts; only the formatted value matches the UI.
              value: sanitizeString(parameter.currentValue?.formattedValue),
            }))
            // Return order changes between page loads, so a stable order has to be imposed.
            .sort((a, b) => a.name.localeCompare(b.name));
        } catch (error) {
          if (error instanceof CaptureAbortedError) {
            noteAbort(error);
          } else {
            errors.push(`parameters unavailable: ${errorText(error)}`);
          }
        }
      }
    }

    // --- Selection -----------------------------------------------------------------------------
    let selectionActive = false;

    for (const sheet of sheets) {
      // One selection per capture: once a sheet reports selected marks, the remaining sheets are
      // not queried, because every extra call is another chance to hang.
      if (aborted || selectionActive) {
        break;
      }

      const getSelectedMarks = sheet.getSelectedMarksAsync;
      if (typeof getSelectedMarks !== 'function') {
        continue;
      }

      try {
        const marks = await queue.run(`getSelectedMarksAsync:${sanitizeString(sheet.name)}`, () =>
          getSelectedMarks.call(sheet),
        );

        // With nothing selected the API still returns a table, just a 0x0 one.
        const table = (marks?.data ?? []).find((candidate) => (candidate.totalRowCount ?? 0) > 0);
        if (table === undefined) {
          continue;
        }

        const rows = (table.data ?? []).map((row) =>
          (row ?? []).map((cell) => sanitizeString(cell?.formattedValue)),
        );

        payload.selection = {
          columns: (table.columns ?? []).map((column) => sanitizeString(column?.fieldName)),
          marks: rows.slice(0, MAX_SELECTED_MARKS),
          truncated: rows.length > MAX_SELECTED_MARKS,
        };
        selectionActive = payload.selection.marks.length > 0;
      } catch (error) {
        if (error instanceof CaptureAbortedError) {
          noteAbort(error);
          break;
        }

        errors.push(`selection unreadable: ${sanitizeString(sheet.name)} (${errorText(error)})`);
      }
    }

    // --- Summary data --------------------------------------------------------------------------
    let dataSheet: TableauWorksheet | undefined;

    if (!aborted) {
      const readable = sheets.filter(
        (sheet) => typeof sheet.getSummaryDataReaderAsync === 'function',
      );
      const preferred =
        options.preferredSheetName === undefined
          ? undefined
          : readable.find((sheet) => sheet.name === options.preferredSheetName);

      dataSheet = preferred ?? readable[0] ?? sheets[0];

      if (dataSheet === undefined) {
        errors.push(SUMMARY_DATA_MISSING_API_ERROR);
      } else {
        const result = await captureSummaryData(dataSheet, queue, selectionActive);

        if (result.error !== undefined) {
          errors.push(result.error);
        }
        if (result.block !== undefined) {
          payload.data = result.block;
        }
      }
    }

    // --- Datasources (of the sampled sheet) ------------------------------------------------------
    // Read for the same sheet whose data was sampled: that is the sheet the model would re-query.
    // A viz without the API stays silent — the refs are an enhancement, and an error line per
    // capture on older Embedding APIs would be pure noise.
    if (!aborted && dataSheet !== undefined) {
      const datasources = await captureDatasources(dataSheet, queue, options.datasourceCache);

      if (datasources instanceof CaptureAbortedError) {
        noteAbort(datasources);
      } else if (typeof datasources === 'string') {
        errors.push(datasources);
      } else if (datasources.length > 0) {
        payload.datasources = datasources;
        payload.caveats.push(DATASOURCE_QUERY_CAVEAT);
      }
    }

    // --- VizQL session (what makes the datasource ids resolvable server-side) --------------------
    // Only read when there are datasource refs to pair it with: the session values are useless on
    // their own, and not reading them is one less thing to carry into the model's context.
    if (!aborted && payload.datasources !== undefined) {
      const session = await captureVdsSession(options.viz, queue);

      if (session instanceof CaptureAbortedError) {
        noteAbort(session);
      } else if (typeof session === 'string') {
        errors.push(session);
      } else if (session !== undefined) {
        payload.vds = session;
        payload.caveats.push(VDS_SESSION_CAVEAT);
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
 * Reads the sampled sheet's datasource refs, through the shared cache when one is supplied.
 *
 * Returns the refs on success (possibly empty), an error line on a failed read, or the
 * `CaptureAbortedError` itself when the queue aborted so the caller can stop the pipeline.
 */
async function captureDatasources(
  sheet: TableauWorksheet,
  queue: SerialQueue,
  cache: Map<string, DatasourceRef[]> | undefined,
): Promise<DatasourceRef[] | string | CaptureAbortedError> {
  const cacheKey = typeof sheet.name === 'string' ? sheet.name : '';
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const getDataSources = sheet.getDataSourcesAsync;
  if (typeof getDataSources !== 'function') {
    return [];
  }

  try {
    const sources = await queue.run(`getDataSourcesAsync:${sanitizeString(sheet.name)}`, () =>
      getDataSources.call(sheet),
    );

    const refs = (sources ?? [])
      .slice(0, MAX_DATASOURCES)
      .map((source) => {
        const ref: DatasourceRef = { name: sanitizeString(source?.name) };
        if (source?.id !== undefined) {
          ref.id = sanitizeString(source.id, MAX_FIELD_ID_LENGTH);
        }
        // Reported only when the API actually answered: `isPublished` decides whether a LUID for
        // this datasource exists at all, so an invented `false` would be a lie the model acts on.
        if (typeof source?.isPublished === 'boolean') {
          ref.isPublished = source.isPublished;
        }
        return ref;
      })
      .filter((ref) => ref.name !== '' || ref.id !== undefined);

    cache?.set(cacheKey, refs);
    return refs;
  } catch (error) {
    if (error instanceof CaptureAbortedError) {
      return error;
    }

    return `datasources unavailable: ${errorText(error)}`;
  }
}

export const VDS_SESSION_MISSING_API_ERROR =
  'datasource querying unavailable: getVizQLDataServiceSessionInfo requires Embedding API 3.16+';

/**
 * Reads the viz's VizQL session, the second half of what the `query-workbook-datasource` tool needs.
 *
 * Returns the pair on success, `undefined` when the viz answered without usable values, an error
 * line on a failed read, or the `CaptureAbortedError` itself when the queue aborted.
 *
 * Not cached across captures. The measured lifetime is long (still valid 26 minutes after the page
 * closed) but no upper bound was established, so a value is re-read rather than pinned to the first
 * capture and served stale for the rest of the page's life.
 */
async function captureVdsSession(
  viz: TableauVizElement,
  queue: SerialQueue,
): Promise<VdsSessionRef | undefined | string | CaptureAbortedError> {
  const getSessionInfo = viz.getVizQLDataServiceSessionInfo;
  if (typeof getSessionInfo !== 'function') {
    return VDS_SESSION_MISSING_API_ERROR;
  }

  try {
    const info = await queue.run('getVizQLDataServiceSessionInfo', async () =>
      getSessionInfo.call(viz),
    );

    const sessionId = sanitizeString(info?.vizqlServerSessionId, MAX_SESSION_VALUE_LENGTH);
    const globalSessionHeader = sanitizeString(info?.globalSessionHeader, MAX_SESSION_VALUE_LENGTH);

    // Both halves or neither: a request carrying only one is rejected by Tableau, so half a pair in
    // the payload would only invite a call that cannot work.
    if (sessionId === '' || globalSessionHeader === '') {
      return undefined;
    }

    return { sessionId, globalSessionHeader };
  } catch (error) {
    if (error instanceof CaptureAbortedError) {
      return error;
    }

    // The message is from the Embedding API, not from the session values, so it is safe to report.
    return `datasource querying unavailable: ${errorText(error)}`;
  }
}

/** Copies only the identity fields the caller supplied; absent stays absent. */
function identityPart(part: { name?: string; luid?: string }): { name?: string; luid?: string } {
  const identity: { name?: string; luid?: string } = {};

  if (part.name !== undefined) {
    identity.name = sanitizeString(part.name);
  }
  if (part.luid !== undefined) {
    identity.luid = sanitizeString(part.luid, MAX_FIELD_ID_LENGTH);
  }

  return identity;
}

/** Whitelist projection: only known fields are copied, and only for a recognized filter type. */
function serializeFilter(filter: TableauFilter): FilterSnapshot {
  const snapshot: FilterSnapshot = {
    field: sanitizeString(filter.fieldName),
    filterType: 'unknown',
    source:
      typeof filter.fieldName === 'string' && filter.fieldName.startsWith(ACTION_FILTER_PREFIX)
        ? 'action'
        : 'user',
  };

  if (filter.fieldId !== undefined) {
    snapshot.fieldId = sanitizeString(filter.fieldId, MAX_FIELD_ID_LENGTH);
  }

  switch (filter.filterType) {
    case 'categorical': {
      snapshot.filterType = 'categorical';

      const { values, truncated } = sanitizeStrings(
        (filter.appliedValues ?? []).map((value) => value?.formattedValue),
        MAX_FILTER_VALUES,
      );

      snapshot.values = values;
      snapshot.valuesTruncated = truncated;

      if (filter.isExcludeMode !== undefined) {
        snapshot.isExcludeMode = filter.isExcludeMode;
      }
      if (filter.isAllSelected !== undefined) {
        snapshot.isAllSelected = filter.isAllSelected;
      }

      // 'select all' is reported as an empty applied-values list, so an empty list on its own says
      // nothing. The third state (not all-selected, nothing applied) is real and stays visible.
      snapshot.selectionState =
        filter.isAllSelected === true ? 'all' : values.length > 0 ? 'some' : 'indeterminate';
      break;
    }

    case 'range': {
      snapshot.filterType = 'range';
      snapshot.min = sanitizeString(filter.minValue?.formattedValue);
      snapshot.max = sanitizeString(filter.maxValue?.formattedValue);

      if (filter.includeNullValues !== undefined) {
        snapshot.includeNullValues = filter.includeNullValues;
      }
      break;
    }

    case 'relative-date': {
      snapshot.filterType = 'relative-date';
      snapshot.period = sanitizeString(filter.periodType);
      snapshot.rangeType = sanitizeString(filter.rangeType);
      snapshot.anchorDate = sanitizeString(filter.anchorDate?.formattedValue);

      const rangeN = sanitizeFiniteNumber(filter.rangeN);
      if (rangeN !== undefined) {
        snapshot.rangeN = rangeN;
      }
      break;
    }

    default:
      // Unknown shape: report the type and copy no type-specific fields, since none of them can be
      // trusted to mean what the equivalent field means on a known filter kind.
      snapshot.note = `unrecognized filter type: ${sanitizeString(filter.filterType)}`;
  }

  return snapshot;
}

/** `sanitizeString` yields '' for anything that is not a primitive, so no `String(...)` throw. */
function errorText(error: unknown): string {
  return error instanceof Error ? sanitizeString(error.message) : sanitizeString(error);
}
