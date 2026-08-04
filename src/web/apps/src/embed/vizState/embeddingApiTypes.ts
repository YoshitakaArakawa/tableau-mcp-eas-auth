/**
 * @file Minimal, hand-written type declarations for the Tableau Embedding API v3.
 *
 * The Embedding API is loaded at runtime from the Tableau server (see `loadTableauEmbeddingApi.ts`);
 * this repo has no `@tableau/embedding-api` dependency, so there are no vendor typings to import.
 *
 * These declarations are NOT authoritative. They describe only the members actually observed in the
 * phase-0 measurements against a live Tableau Cloud site. Anything not observed is absent, and every
 * member is optional so that feature detection (`if (typeof sheet.getFiltersAsync === 'function')`)
 * is type-safe rather than a cast.
 *
 * Write methods are DELIBERATELY omitted — `applyFilterAsync`, `selectMarksByValueAsync`,
 * `changeParameterValueAsync`, `saveCustomViewAsync`, `revertAllAsync` and friends are not declared,
 * so read-only usage of the embedded viz is enforced by the type system. Do not add them.
 */

/** A cell value. `value` is the raw value, `nativeValue` the typed one, `formattedValue` the display text. */
export type TableauDataValue = { value?: unknown; nativeValue?: unknown; formattedValue?: string };

export type TableauFilter = {
  fieldName?: string;
  fieldId?: string;
  filterType?: string; // 'categorical' | 'range' | 'relative-date' | others
  worksheetName?: string;
  isAllSelected?: boolean; // categorical
  isExcludeMode?: boolean; // categorical
  appliedValues?: TableauDataValue[]; // categorical
  minValue?: TableauDataValue; // range
  maxValue?: TableauDataValue; // range
  includeNullValues?: boolean;
  periodType?: string; // relative-date
  rangeType?: string; // relative-date
  rangeN?: number; // relative-date
  anchorDate?: TableauDataValue; // relative-date
  getAppliedWorksheetsAsync?: () => Promise<Array<string | { name?: string }>>;
};

export type TableauColumn = {
  fieldName?: string;
  index?: number;
  dataType?: string;
  fieldId?: string;
};

export type TableauDataTable = {
  name?: string;
  totalRowCount?: number;
  isTotalRowCountLimited?: boolean;
  columns?: TableauColumn[];
  data?: TableauDataValue[][];
};

/** Paged reader returned by `getSummaryDataReaderAsync`. Must be released with `releaseAsync`. */
export type TableauDataTableReader = {
  totalRowCount?: number;
  pageCount?: number;
  getPageAsync: (pageNumber: number) => Promise<TableauDataTable>;
  releaseAsync: () => Promise<void>;
};

export type GetSummaryDataOptions = { ignoreSelection?: boolean };

/**
 * A worksheet's datasource.
 *
 * Measured (see verification/vds-embedding-id/FINDINGS.md): `id` is NOT the published datasource
 * LUID. It is the workbook-internal connection id — `sqlproxy.<id>` when the workbook references a
 * published datasource, `federated.<id>` when the datasource is embedded in the workbook. Passing it
 * to VDS as `datasourceLuid` is rejected outright; it is only usable as `workbookDatasourceId`,
 * inside the viz's VizQL session.
 *
 * `isPublished` (Embedding API 2021.4+) is what tells the two apart, and therefore whether a LUID
 * for this datasource exists anywhere at all.
 */
export type TableauDataSource = { name?: string; id?: string; isPublished?: boolean };

/**
 * The VizQL session that a `workbookDatasourceId` resolves inside of, as returned by
 * `viz.getVizQLDataServiceSessionInfo()` (Embedding API 3.16+).
 *
 * `vizqlServerSessionId` is the secret half. `globalSessionHeader` is base64-encoded node-affinity
 * routing information — required by Tableau Cloud, but not a credential.
 */
export type VizqlDataServiceSessionInfo = {
  vizqlServerSessionId?: string;
  globalSessionHeader?: string;
};

export type TableauMarksCollection = { data?: TableauDataTable[] };

export type TableauWorksheet = {
  name?: string;
  /** 'worksheet' | 'dashboard' | 'story'. 'story' is UNVERIFIED — no story was exercised in phase 0. */
  sheetType?: string;
  getFiltersAsync?: () => Promise<TableauFilter[]>;
  getSelectedMarksAsync?: () => Promise<TableauMarksCollection>;
  getSummaryDataReaderAsync?: (
    pageRowCount?: number,
    options?: GetSummaryDataOptions,
  ) => Promise<TableauDataTableReader>;
  /**
   * Doc-sourced (not phase-0 observed). The docs warn this call "might negatively impact
   * performance and responsiveness", so callers must cache the result rather than re-read it on
   * every capture.
   */
  getDataSourcesAsync?: () => Promise<TableauDataSource[]>;
};

/** A dashboard activeSheet carries `worksheets`; a worksheet activeSheet does not. */
export type TableauSheet = TableauWorksheet & { worksheets?: TableauWorksheet[] };

export type TableauParameter = {
  name?: string;
  id?: string;
  dataType?: string;
  currentValue?: TableauDataValue;
};

export type TableauWorkbook = {
  name?: string;
  activeSheet?: TableauSheet;
  publishedSheetsInfo?: Array<{
    name?: string;
    isActive?: boolean;
    isHidden?: boolean;
    sheetType?: string;
    url?: string;
  }>;
  getParametersAsync?: () => Promise<TableauParameter[]>;
};

/** The `<tableau-viz>` custom element once the Embedding API has upgraded it. */
export type TableauVizElement = HTMLElement & {
  workbook?: TableauWorkbook;
  /**
   * Measured: this lives on the viz ELEMENT, not on the workbook object. The return type is written
   * as "value or promise" because the measurement awaited the result and therefore could not tell
   * the two apart; callers must await it.
   */
  getVizQLDataServiceSessionInfo?: () =>
    | VizqlDataServiceSessionInfo
    | Promise<VizqlDataServiceSessionInfo>;
};

/**
 * Events subscribed on the `<tableau-viz>` element. 'summarydatachanged' is a backstop:
 * 'parameterchanged'/'tabswitched' were never observed firing in phase-0 logs.
 */
export const TABLEAU_VIZ_EVENTS = [
  'filterchanged',
  'parameterchanged',
  'markselectionchanged',
  'tabswitched',
  'summarydatachanged',
] as const;
