/**
 * @file Reads one worksheet's summary data through the paged reader API.
 *
 * Every rule here is a measured constraint, not a preference:
 * - Summary data defaults to being narrowed to the current selection (288 rows became 96 in the
 *   phase-0 measurement), so `ignoreSelection: true` is mandatory; the snapshot must describe the
 *   sheet, not the click.
 * - `GetSummaryDataOptions.maxRows` is a no-op. The row count is controlled by the `pageRowCount`
 *   argument to `getSummaryDataReaderAsync`.
 * - `getAllPagesAsync` ignores `pageRowCount` and would pull the whole result set, so only
 *   `getPageAsync(0)` is ever called.
 * - `applyWorksheetFormatting: true` diverges from the on-screen rendering for dates, so it is not
 *   passed at all.
 *
 * The reader holds resources on the server side and must be released even when reading it failed,
 * which is why the release goes through `runFinal` — the only way to execute after an abort.
 */
import type { TableauDataTableReader, TableauWorksheet } from './embeddingApiTypes.js';
import type { VizStatePayload } from './payload.js';
import { sanitizeFiniteNumber, sanitizeString } from './sanitize.js';
import { CaptureAbortedError, SerialQueue } from './serialQueue.js';

/** Rows requested for the first (and only) page. */
export const SUMMARY_PAGE_ROW_COUNT = 200;

/** Also used by the caller when no sheet in the viz exposes the reader API at all. */
export const SUMMARY_DATA_MISSING_API_ERROR =
  'summary data unavailable: getSummaryDataReaderAsync requires Embedding API 3.5+';

type SummaryDataBlock = NonNullable<VizStatePayload['data']>;

export type CaptureSummaryDataResult = { block?: SummaryDataBlock; error?: string };

/**
 * Reads the first page of `worksheet`'s summary data.
 *
 * Never throws: a degraded read is reported through `error` so the caller can attach it to the
 * payload and still push everything else it managed to capture.
 *
 * @param selectionActive - Whether marks were selected when the snapshot was taken. Recorded on the
 *   block so a reader knows the rows are NOT narrowed by that selection.
 */
export async function captureSummaryData(
  worksheet: TableauWorksheet,
  queue: SerialQueue,
  selectionActive: boolean,
  pageRowCount = SUMMARY_PAGE_ROW_COUNT,
): Promise<CaptureSummaryDataResult> {
  const getReader = worksheet.getSummaryDataReaderAsync;
  if (typeof getReader !== 'function') {
    return { error: SUMMARY_DATA_MISSING_API_ERROR };
  }

  let reader: TableauDataTableReader | undefined;

  try {
    reader = await queue.run('getSummaryDataReaderAsync', () =>
      getReader.call(worksheet, pageRowCount, { ignoreSelection: true }),
    );

    const currentReader = reader;
    const table = await queue.run('getPageAsync', () => currentReader.getPageAsync(0));

    const rows = (table.data ?? []).map((row) =>
      (row ?? []).map((cell) => sanitizeString(cell?.formattedValue)),
    );

    return {
      block: {
        sheet: sanitizeString(worksheet.name),
        columns: (table.columns ?? []).map((column) => sanitizeString(column?.fieldName)),
        rows,
        truncated: (reader.totalRowCount ?? 0) > rows.length,
        totalRowCount: sanitizeFiniteNumber(reader.totalRowCount),
        selectionActive,
      },
    };
  } catch (error) {
    if (error instanceof CaptureAbortedError) {
      return { error: `summary data capture aborted: ${error.label} (${error.reason})` };
    }

    return { error: `summary data unavailable: ${errorText(error)}` };
  } finally {
    if (reader !== undefined) {
      const currentReader = reader;
      // `runFinal` because the capture may already have aborted; leaking the reader is worse than
      // spending one more call on it.
      await queue.runFinal('releaseAsync', () => currentReader.releaseAsync()).catch(() => {});
    }
  }
}

/** `sanitizeString` yields '' for anything that is not a primitive, so no `String(...)` throw. */
function errorText(error: unknown): string {
  return error instanceof Error ? sanitizeString(error.message) : sanitizeString(error);
}
