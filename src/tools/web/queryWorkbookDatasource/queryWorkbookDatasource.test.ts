import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Err, Ok } from 'ts-results-es';

import { Query } from '../../../sdks/tableau/apis/vizqlDataServiceApi.js';
import { ProductVersion } from '../../../sdks/tableau/types/serverInfo.js';
import { WebMcpServer } from '../../../server.web.js';
import {
  stubDefaultEnvVars,
  testProductVersion,
  testProductVersion2025_3,
} from '../../../testShared.js';
import invariant from '../../../utils/invariant.js';
import { Provider } from '../../../utils/provider.js';
import { getMockRequestHandlerExtra } from '../toolContext.mock.js';
import {
  getQueryWorkbookDatasourceTool,
  LUID_SUPPLIED_MESSAGE,
  METADATA_NEXT_STEP,
} from './queryWorkbookDatasource.js';
import {
  DATASOURCE_NOT_IN_SESSION_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
} from './queryWorkbookDatasourceErrorHandler.js';

// Dummy values in the measured shapes. `sqlproxy.*` is what a published datasource reference
// reports; `federated.*` is a datasource embedded in the workbook.
const WORKBOOK_DATASOURCE_ID = 'sqlproxy.0abcdef1234567890abcdef12';
const VIZQL_SESSION_ID = 'fake-vizql-session-0123456789abcdef';
const GLOBAL_SESSION_HEADER = 'ZmFrZS1nbG9iYWwtc2Vzc2lvbi1oZWFkZXI=';

const SESSION = {
  vizqlSessionId: VIZQL_SESSION_ID,
  globalSessionHeader: GLOBAL_SESSION_HEADER,
};

const QUERY: Query = {
  fields: [{ fieldCaption: 'Category' }, { fieldCaption: 'Profit', function: 'SUM' }],
};

const mockResponses = vi.hoisted(() => ({
  queryData: {
    data: [
      { Category: 'Technology', 'SUM(Profit)': 146543.37 },
      { Category: 'Furniture', 'SUM(Profit)': 19729.99 },
    ],
  },
  metadata: {
    data: [
      {
        fieldCaption: 'Category',
        fieldName: 'Category',
        dataType: 'STRING',
        columnClass: 'COLUMN',
      },
      { fieldCaption: 'Profit', fieldName: 'Profit', dataType: 'REAL', columnClass: 'COLUMN' },
    ],
  },
}));

const mocks = vi.hoisted(() => ({
  mockQueryWorkbookDatasource: vi.fn(),
  mockReadWorkbookDatasourceMetadata: vi.fn(),
}));

vi.mock('../../../restApiInstance.js', () => ({
  useRestApi: vi.fn().mockImplementation(async ({ callback }) =>
    callback({
      vizqlDataServiceMethods: {
        queryWorkbookDatasource: mocks.mockQueryWorkbookDatasource,
        readWorkbookDatasourceMetadata: mocks.mockReadWorkbookDatasourceMetadata,
      },
    }),
  ),
}));

describe('queryWorkbookDatasourceTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    stubDefaultEnvVars();
    mocks.mockReadWorkbookDatasourceMetadata.mockResolvedValue(new Ok(mockResponses.metadata));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates a tool instance with the expected identity', () => {
    const tool = getQueryWorkbookDatasourceTool(new WebMcpServer(), testProductVersion);

    expect(tool.name).toBe('query-workbook-datasource');
    expect(tool.paramsSchema).not.toBeUndefined();
    expect(tool.requiredApiScopes).toContain('tableau:viz_data_service:read');
  });

  it('rejects a published datasource LUID and points at the other tool', async () => {
    const result = await getToolResult({
      workbookDatasourceId: '71db762b-6201-466b-93da-57cc0aec8ed9',
    });

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toBe(LUID_SUPPLIED_MESSAGE);
    expect(mocks.mockQueryWorkbookDatasource).not.toHaveBeenCalled();
    expect(mocks.mockReadWorkbookDatasourceMetadata).not.toHaveBeenCalled();
  });

  it('returns the field list when no query is given', async () => {
    const result = await getToolResult({ query: null });

    expect(result.isError).toBe(false);
    invariant(result.content[0].type === 'text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.nextStep).toBe(METADATA_NEXT_STEP);
    expect(
      parsed.fields.fieldGroups[0].fields.map((field: { name: string }) => field.name),
    ).toEqual(['Category', 'Profit']);

    expect(mocks.mockReadWorkbookDatasourceMetadata).toHaveBeenCalledWith(
      { datasource: { workbookDatasourceId: WORKBOOK_DATASOURCE_ID } },
      SESSION,
    );
    expect(mocks.mockQueryWorkbookDatasource).not.toHaveBeenCalled();
  });

  it('queries with the session headers and the workbook datasource id', async () => {
    mocks.mockQueryWorkbookDatasource.mockResolvedValue(new Ok(mockResponses.queryData));

    const result = await getToolResult();

    expect(result.isError).toBe(false);
    invariant(result.content[0].type === 'text');
    expect(JSON.parse(result.content[0].text)).toEqual(mockResponses.queryData);

    expect(mocks.mockQueryWorkbookDatasource).toHaveBeenCalledWith(
      {
        datasource: { workbookDatasourceId: WORKBOOK_DATASOURCE_ID },
        query: QUERY,
        options: { returnFormat: 'OBJECTS', debug: true, disaggregate: false, rowLimit: undefined },
      },
      SESSION,
    );
  });

  it('passes the row limit through on 2026.1 and omits it on earlier versions', async () => {
    mocks.mockQueryWorkbookDatasource.mockResolvedValue(new Ok(mockResponses.queryData));

    await getToolResult({ limit: 100 });
    expect(mocks.mockQueryWorkbookDatasource.mock.calls[0][0].options.rowLimit).toBe(100);

    mocks.mockQueryWorkbookDatasource.mockClear();

    await getToolResult({ limit: 100, productVersion: testProductVersion2025_3 });
    expect(mocks.mockQueryWorkbookDatasource.mock.calls[0][0].options).not.toHaveProperty(
      'rowLimit',
    );
  });

  it('trims the returned rows to the row limit', async () => {
    mocks.mockQueryWorkbookDatasource.mockResolvedValue(new Ok({ ...mockResponses.queryData }));

    const result = await getToolResult({ limit: 1 });

    invariant(result.content[0].type === 'text');
    expect(JSON.parse(result.content[0].text).data).toHaveLength(1);
  });

  it('validates the query against the metadata before querying', async () => {
    const result = await getToolResult({
      query: { fields: [{ fieldCaption: 'Not A Field' }] },
    });

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain("Field 'Not A Field' was not found in the datasource");
    expect(mocks.mockQueryWorkbookDatasource).not.toHaveBeenCalled();
  });

  it('skips the validation round trip when validation requests are disabled', async () => {
    vi.stubEnv('DISABLE_QUERY_DATASOURCE_VALIDATION_REQUESTS', 'true');
    mocks.mockQueryWorkbookDatasource.mockResolvedValue(new Ok(mockResponses.queryData));

    const result = await getToolResult({ query: { fields: [{ fieldCaption: 'Not A Field' }] } });

    expect(result.isError).toBe(false);
    expect(mocks.mockReadWorkbookDatasourceMetadata).not.toHaveBeenCalled();
    expect(mocks.mockQueryWorkbookDatasource).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty field list before any request is made', async () => {
    const result = await getToolResult({ query: { fields: [] } });

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('at least one field');
    expect(mocks.mockReadWorkbookDatasourceMetadata).not.toHaveBeenCalled();
  });

  it('translates an expired session into a re-render instruction', async () => {
    mocks.mockReadWorkbookDatasourceMetadata.mockResolvedValue(
      Err({
        type: 'api-error',
        message: 'Session is no longer valid.',
        httpStatus: 401,
        errorCode: '401002',
      }),
    );

    const result = await getToolResult();

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toBe(SESSION_EXPIRED_MESSAGE);
    // The failure is reported instead of falling through to a query that would fail the same way.
    expect(mocks.mockQueryWorkbookDatasource).not.toHaveBeenCalled();
  });

  it('translates a cross-workbook datasource id into a pairing instruction', async () => {
    mocks.mockQueryWorkbookDatasource.mockResolvedValue(
      Err({
        type: 'api-error',
        message: `Cannot find datasource ${WORKBOOK_DATASOURCE_ID}`,
        httpStatus: 500,
        errorCode: undefined,
      }),
    );

    const result = await getToolResult();

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toBe(DATASOURCE_NOT_IN_SESSION_MESSAGE);
  });

  it('never lets the session values reach the logged args', async () => {
    mocks.mockQueryWorkbookDatasource.mockResolvedValue(new Ok(mockResponses.queryData));

    const tool = getQueryWorkbookDatasourceTool(new WebMcpServer(), testProductVersion);
    const logAndExecute = vi.spyOn(tool, 'logAndExecute');
    const callback = await Provider.from(tool.callback);

    await callback(
      {
        workbookDatasourceId: WORKBOOK_DATASOURCE_ID,
        vizqlSessionId: VIZQL_SESSION_ID,
        globalSessionHeader: GLOBAL_SESSION_HEADER,
        query: QUERY,
        limit: undefined,
      },
      getMockRequestHandlerExtra(),
    );

    const loggedArgs = JSON.stringify(logAndExecute.mock.calls[0][0].args);
    expect(loggedArgs).not.toContain(VIZQL_SESSION_ID);
    expect(loggedArgs).not.toContain(GLOBAL_SESSION_HEADER);
    // Sanity: the id is still logged, so the assertions above are about redaction, not an empty arg.
    expect(loggedArgs).toContain(WORKBOOK_DATASOURCE_ID);
    // The real request still receives the real values.
    expect(mocks.mockQueryWorkbookDatasource).toHaveBeenCalledWith(expect.anything(), SESSION);
  });

  it('does not apply the published-datasource allowlist', async () => {
    // INCLUDE_DATASOURCE_IDS is keyed by published LUID, which a workbook-internal id is not, so it
    // cannot gate this tool. Pinned as a test so the gap is a decision rather than a surprise.
    vi.stubEnv('INCLUDE_DATASOURCE_IDS', 'some-other-datasource-luid');
    mocks.mockQueryWorkbookDatasource.mockResolvedValue(new Ok(mockResponses.queryData));

    const result = await getToolResult();

    expect(result.isError).toBe(false);
  });
});

async function getToolResult({
  workbookDatasourceId = WORKBOOK_DATASOURCE_ID,
  query = QUERY,
  limit,
  productVersion,
}: {
  workbookDatasourceId?: string;
  /** `null` means "omit the query" — `undefined` would collide with the default. */
  query?: Query | null;
  limit?: number;
  productVersion?: ProductVersion;
} = {}): Promise<CallToolResult> {
  const tool = getQueryWorkbookDatasourceTool(
    new WebMcpServer(),
    productVersion ?? testProductVersion,
  );
  const callback = await Provider.from(tool.callback);
  return await callback(
    {
      workbookDatasourceId,
      vizqlSessionId: VIZQL_SESSION_ID,
      globalSessionHeader: GLOBAL_SESSION_HEADER,
      query: query ?? undefined,
      limit,
    },
    getMockRequestHandlerExtra(),
  );
}
