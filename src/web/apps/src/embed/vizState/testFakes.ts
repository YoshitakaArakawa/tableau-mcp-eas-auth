/**
 * @file TEST-ONLY builders for Embedding API fakes.
 *
 * Not production code, and deliberately not named `*.test.ts` so vitest does not collect it as a
 * suite. Keeping the fakes in one place means every vizState test exercises the same shapes.
 *
 * The shapes mirror what the phase-0 measurements returned from a live Tableau Cloud site,
 * including the awkward parts: `getAppliedWorksheetsAsync` listing worksheets that are not on the
 * dashboard, a single 0x0 marks table when nothing is selected, and float artifacts in a
 * parameter's `currentValue.value`. A fake that is tidier than the real API makes the tests lie.
 */
import { vi } from 'vitest';

import type {
  TableauDataTable,
  TableauDataTableReader,
  TableauFilter,
  TableauVizElement,
  TableauWorkbook,
  TableauWorksheet,
} from './embeddingApiTypes.js';

/**
 * Stand-in for the embed JWT the real `<tableau-viz>` carries in its `token` attribute.
 * Exported so the leak test can assert this literal never reaches the pushed model context.
 */
export const FAKE_EMBED_TOKEN =
  'fake-embed-jwt-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJl';

export const ON_SCREEN_SHEET_NAME = 'Sheet A';
export const OFF_SCREEN_SHEET_NAME = 'Off Screen Sheet';

export function makeCategoricalFilter(overrides: Partial<TableauFilter> = {}): TableauFilter {
  return {
    fieldName: 'Region',
    fieldId: '[federated.abc].[none:Region:nk]',
    filterType: 'categorical',
    appliedValues: [{ formattedValue: 'West' }, { formattedValue: 'East' }],
    isAllSelected: false,
    isExcludeMode: false,
    // Measured: the applied-worksheets list includes worksheets that are not on the dashboard.
    getAppliedWorksheetsAsync: vi
      .fn()
      .mockResolvedValue([ON_SCREEN_SHEET_NAME, OFF_SCREEN_SHEET_NAME]),
    ...overrides,
  };
}

export function makeRangeFilter(overrides: Partial<TableauFilter> = {}): TableauFilter {
  return {
    fieldName: 'Sales',
    fieldId: '[federated.abc].[sum:Sales:qk]',
    filterType: 'range',
    minValue: { value: 0, formattedValue: '0' },
    maxValue: { value: 12345.6789, formattedValue: '12,345.68' },
    includeNullValues: false,
    ...overrides,
  };
}

export function makeRelativeDateFilter(overrides: Partial<TableauFilter> = {}): TableauFilter {
  return {
    fieldName: 'Order Date',
    fieldId: '[federated.abc].[none:Order Date:qk]',
    filterType: 'relative-date',
    periodType: 'MONTH',
    rangeType: 'LASTN',
    rangeN: 6,
    anchorDate: { value: 1767225600000, formattedValue: '2026-01-01' },
    ...overrides,
  };
}

function makeSummaryTable(): TableauDataTable {
  return {
    name: 'Summary',
    totalRowCount: 2,
    columns: [
      { fieldName: 'Region', index: 0 },
      { fieldName: 'Sales', index: 1 },
    ],
    data: [
      [{ formattedValue: 'West' }, { formattedValue: '$1,000' }],
      [{ formattedValue: 'East' }, { formattedValue: '$2,000' }],
    ],
  };
}

export function makeSummaryDataReader(
  overrides: Partial<TableauDataTableReader> = {},
): TableauDataTableReader {
  return {
    totalRowCount: 2,
    pageCount: 1,
    getPageAsync: vi.fn().mockResolvedValue(makeSummaryTable()),
    releaseAsync: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** An empty selection is one 0x0 table, not an empty array. Measured. */
export function makeEmptyMarksTable(): TableauDataTable {
  return { name: 'Selected', totalRowCount: 0, columns: [], data: [] };
}

export function makeWorksheet(overrides: Partial<TableauWorksheet> = {}): TableauWorksheet {
  return {
    name: ON_SCREEN_SHEET_NAME,
    sheetType: 'worksheet',
    getFiltersAsync: vi.fn().mockResolvedValue([]),
    getSelectedMarksAsync: vi.fn().mockResolvedValue({ data: [makeEmptyMarksTable()] }),
    getSummaryDataReaderAsync: vi.fn().mockResolvedValue(makeSummaryDataReader()),
    ...overrides,
  };
}

/** A dashboard workbook: its `activeSheet` carries `worksheets`, a worksheet's does not. */
export function makeDashboardWorkbook(overrides: Partial<TableauWorkbook> = {}): TableauWorkbook {
  return {
    name: 'Fake Workbook',
    activeSheet: {
      name: 'Sales Dashboard',
      sheetType: 'dashboard',
      worksheets: [makeWorksheet(), makeWorksheet({ name: 'Sheet B' })],
    },
    getParametersAsync: vi.fn().mockResolvedValue([
      // Measured: `value` carries float artifacts, `formattedValue` does not.
      {
        name: 'Target Margin',
        currentValue: { value: 18.399999999999999, formattedValue: '18.4' },
      },
    ]),
    ...overrides,
  };
}

/**
 * A `<tableau-viz>` element as the Embedding API leaves it: the embed JWT sits in an attribute and
 * the workbook is reachable from the element by more than one enumerable path. Both back-references
 * exist so the serializer leak test is honest — a serializer that walked the object graph instead
 * of reading whitelisted fields would reach the token from here.
 *
 * Requires a DOM (`@vitest-environment jsdom`).
 */
export function makeFakeVizElement(
  workbook: TableauWorkbook = makeDashboardWorkbook(),
): TableauVizElement {
  const element = document.createElement('tableau-viz') as TableauVizElement;
  element.setAttribute('src', 'https://tableau.example.com/views/Fake/Sheet');
  element.setAttribute('token', FAKE_EMBED_TOKEN);

  Object.assign(element, { workbook, _workbookImpl: workbook });

  const getParameters = workbook.getParametersAsync;
  if (getParameters !== undefined) {
    workbook.getParametersAsync = async () =>
      (await getParameters()).map((parameter) => ({
        ...parameter,
        parameterImpl: { workbookImpl: workbook, vizElement: element },
      }));
  }

  return element;
}

/**
 * Every method returns a promise that never settles — the measured failure mode of an invalid
 * Embedding API call, which also wedges the postMessage channel for the rest of the page's life.
 */
export function makeHangingWorksheet(): TableauWorksheet {
  const hang = <T>(): Promise<T> => new Promise<T>(() => {});

  return {
    name: 'Hanging Sheet',
    sheetType: 'worksheet',
    getFiltersAsync: () => hang(),
    getSelectedMarksAsync: () => hang(),
    getSummaryDataReaderAsync: () => hang(),
  };
}
