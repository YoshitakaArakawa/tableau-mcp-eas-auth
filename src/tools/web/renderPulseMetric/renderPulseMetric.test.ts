import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ok } from 'ts-results-es';

import { PulseDisabledError, PulseNotAvailableError } from '../../../errors/mcpToolError.js';
import { WebMcpServer } from '../../../server.web.js';
import { stubDefaultEnvVars } from '../../../testShared.js';
import invariant from '../../../utils/invariant.js';
import { Provider } from '../../../utils/provider.js';
import { getMockRequestHandlerExtra } from '../toolContext.mock.js';
import { getRenderPulseMetricTool } from './renderPulseMetric.js';

const METRIC_ID = 'CF32DDCC-362B-4869-9487-37DA4D152552';
const DEFINITION_ID = 'BBC908D8-29ED-48AB-A78E-ACF8A424C8C3';

const mocks = vi.hoisted(() => ({
  mockListPulseMetricsFromMetricIds: vi.fn(),
  mockListPulseMetricDefinitionsFromMetricDefinitionIds: vi.fn(),
}));

vi.mock('../../../restApiInstance.js', () => ({
  useRestApi: vi.fn().mockImplementation(async ({ callback }) =>
    callback({
      pulseMethods: {
        listPulseMetricsFromMetricIds: mocks.mockListPulseMetricsFromMetricIds,
        listPulseMetricDefinitionsFromMetricDefinitionIds:
          mocks.mockListPulseMetricDefinitionsFromMetricDefinitionIds,
      },
      siteId: 'test-site-id',
    }),
  ),
}));

function mockMetricFound(): void {
  mocks.mockListPulseMetricsFromMetricIds.mockResolvedValue(
    new Ok([{ id: METRIC_ID, definition_id: DEFINITION_ID }]),
  );
  mocks.mockListPulseMetricDefinitionsFromMetricDefinitionIds.mockResolvedValue(
    new Ok([{ metadata: { id: DEFINITION_ID, name: 'Weekly Sales' } }]),
  );
}

describe('renderPulseMetricTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    stubDefaultEnvVars();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should have correct tool properties', () => {
    const tool = getRenderPulseMetricTool(new WebMcpServer());
    expect(tool.name).toBe('render-pulse-metric');
    expect(tool.description).toContain('interactive, embedded Tableau Pulse metric');
    expect(tool.paramsSchema).toMatchObject({
      metricId: expect.any(Object),
      layout: expect.any(Object),
    });
    // The Pulse bundle is its own single-file HTML, not the viz one.
    expect(tool.app?.resourceUri).toBe('ui://render-pulse-metric/mcp-pulse.html');
  });

  it('should return the metric payload with the definition name', async () => {
    mockMetricFound();

    const result = await getToolResult({ metricId: METRIC_ID });

    expect(result.isError).toBe(false);
    invariant(result.content[0].type === 'text');
    const response = JSON.parse(result.content[0].text);
    expect(response.data).toEqual({
      id: METRIC_ID,
      objectType: 'pulse-metric',
      name: 'Weekly Sales',
    });
    expect(response.url).toBe(`https://my-tableau-server.com/pulse/site/tc25/metrics/${METRIC_ID}`);
  });

  it('should resolve the definition from the metric, not from the requested id', async () => {
    mockMetricFound();

    await getToolResult({ metricId: METRIC_ID });

    expect(mocks.mockListPulseMetricsFromMetricIds).toHaveBeenCalledWith([METRIC_ID]);
    expect(mocks.mockListPulseMetricDefinitionsFromMetricDefinitionIds).toHaveBeenCalledWith([
      DEFINITION_ID,
    ]);
  });

  it('should default the layout to "default"', async () => {
    mockMetricFound();

    const result = await getToolResult({ metricId: METRIC_ID });

    invariant(result.content[0].type === 'text');
    expect(JSON.parse(result.content[0].text).layout).toBe('default');
  });

  it('should pass an explicit layout through', async () => {
    mockMetricFound();

    const result = await getToolResult({ metricId: METRIC_ID, layout: 'ban' });

    invariant(result.content[0].type === 'text');
    expect(JSON.parse(result.content[0].text).layout).toBe('ban');
  });

  it('should append a pulse state guidance text block on success', async () => {
    mockMetricFound();

    const result = await getToolResult({ metricId: METRIC_ID });

    expect(result.content).toHaveLength(2);

    // content[0] must remain the raw JSON payload the app iframe parses.
    invariant(result.content[0].type === 'text');
    const payloadText = result.content[0].text;
    expect(() => JSON.parse(payloadText)).not.toThrow();

    invariant(result.content[1].type === 'text');
    const guidance = result.content[1].text;
    expect(guidance).toContain('generate-pulse-metric-value-insight-bundle');
    expect(guidance).toContain('query-datasource');
    expect(guidance).toContain("widget's model context");
    expect(guidance).toContain('Pulse state snapshot');
  });

  it('should fall back to the metric id when the definition is missing', async () => {
    mocks.mockListPulseMetricsFromMetricIds.mockResolvedValue(
      new Ok([{ id: METRIC_ID, definition_id: DEFINITION_ID }]),
    );
    mocks.mockListPulseMetricDefinitionsFromMetricDefinitionIds.mockResolvedValue(new Ok([]));

    const result = await getToolResult({ metricId: METRIC_ID });

    expect(result.isError).toBe(false);
    invariant(result.content[0].type === 'text');
    expect(JSON.parse(result.content[0].text).data.name).toBe(METRIC_ID);
  });

  it('should error when the metric id does not resolve (e.g. a definition id was passed)', async () => {
    mocks.mockListPulseMetricsFromMetricIds.mockResolvedValue(new Ok([]));

    const result = await getToolResult({ metricId: DEFINITION_ID });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('No Pulse metric was found');
    expect(result.content[0].text).toContain('not a metric definition ID');
    expect(mocks.mockListPulseMetricDefinitionsFromMetricDefinitionIds).not.toHaveBeenCalled();
  });

  it('should surface a Pulse-disabled error from the metric lookup', async () => {
    mocks.mockListPulseMetricsFromMetricIds.mockResolvedValue(new PulseDisabledError().toErr());

    const result = await getToolResult({ metricId: METRIC_ID });

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('Pulse is disabled on this Tableau Cloud site.');
  });

  it('should surface a Pulse-not-available error from the definition lookup', async () => {
    mocks.mockListPulseMetricsFromMetricIds.mockResolvedValue(
      new Ok([{ id: METRIC_ID, definition_id: DEFINITION_ID }]),
    );
    mocks.mockListPulseMetricDefinitionsFromMetricDefinitionIds.mockResolvedValue(
      new PulseNotAvailableError().toErr(),
    );

    const result = await getToolResult({ metricId: METRIC_ID });

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('Pulse is not available on Tableau Server.');
  });

  it('should handle API errors gracefully', async () => {
    mocks.mockListPulseMetricsFromMetricIds.mockRejectedValue(new Error('API Error'));

    const result = await getToolResult({ metricId: METRIC_ID });

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('API Error');
  });
});

async function getToolResult(params: {
  metricId: string;
  layout?: 'default' | 'card' | 'ban';
}): Promise<CallToolResult> {
  const tool = getRenderPulseMetricTool(new WebMcpServer());
  const callback = await Provider.from(tool.callback);
  return await callback(params, getMockRequestHandlerExtra());
}
