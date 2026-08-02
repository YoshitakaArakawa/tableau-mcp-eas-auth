import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { WebMcpServer } from '../../../server.web.js';
import invariant from '../../../utils/invariant.js';
import { Provider } from '../../../utils/provider.js';
import { getMockRequestHandlerExtra } from '../toolContext.mock.js';
import { getGetCurrentSiteTool } from './getCurrentSite.js';

const MOCK_SERVER = 'https://my-tableau-server.com';

type MockExtra = ReturnType<typeof getMockRequestHandlerExtra>;

function makeExtra(siteName: string, siteId?: string): MockExtra {
  const extra = getMockRequestHandlerExtra();
  extra.config.oauth.switchableSites = ['site-a', 'site-b'];
  extra.tableauAuthInfo = {
    type: 'X-Tableau-Auth',
    username: 'test-user',
    server: MOCK_SERVER,
    siteName,
    accessToken: 'tableau-access-token',
    refreshToken: 'tableau-refresh-token',
    ...(siteId ? { siteId } : {}),
  };
  return extra;
}

async function getToolResult(extra: MockExtra): Promise<CallToolResult> {
  const tool = getGetCurrentSiteTool(new WebMcpServer());
  const callback = await Provider.from(tool.callback);
  return await callback({}, extra);
}

describe('getCurrentSiteTool', () => {
  it('should create a tool instance with correct properties', async () => {
    const tool = getGetCurrentSiteTool(new WebMcpServer());
    const annotations = await Provider.from(tool.annotations);
    expect(tool.name).toBe('get-current-site');
    expect(tool.paramsSchema).toEqual({});
    expect(annotations?.readOnlyHint).toBe(true);
  });

  it('should return the site of the live session', async () => {
    const result = await getToolResult(makeExtra('site-b', 'site-luid-b'));

    expect(result.isError).toBe(false);
    invariant(result.content[0].type === 'text');
    expect(JSON.parse(result.content[0].text)).toEqual({
      site: 'site-b',
      siteLuid: 'site-luid-b',
    });
  });

  it('should report an empty content URL as the Default site', async () => {
    const result = await getToolResult(makeExtra('', 'site-luid-default'));

    expect(result.isError).toBe(false);
    invariant(result.content[0].type === 'text');
    expect(JSON.parse(result.content[0].text).site).toBe('Default');
  });

  it('should reject passthrough sessions', async () => {
    const extra = makeExtra('site-a');
    extra.tableauAuthInfo = {
      type: 'Passthrough',
      username: 'test-user',
      userId: 'user-id',
      server: MOCK_SERVER,
      siteId: 'site-id',
      siteName: 'site-a',
      raw: 'x-tableau-auth-session-token',
    };

    const result = await getToolResult(extra);

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('authorization server');
  });
});
