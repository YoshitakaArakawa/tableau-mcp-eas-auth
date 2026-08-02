import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { WebMcpServer } from '../../../server.web.js';
import invariant from '../../../utils/invariant.js';
import { Provider } from '../../../utils/provider.js';
import { getMockRequestHandlerExtra } from '../toolContext.mock.js';
import { getListSitesTool } from './listSites.js';

const MOCK_SERVER = 'https://my-tableau-server.com';

type MockExtra = ReturnType<typeof getMockRequestHandlerExtra>;

function makeExtra(switchableSites: string[]): MockExtra {
  const extra = getMockRequestHandlerExtra();
  extra.config.oauth.switchableSites = switchableSites;
  extra.tableauAuthInfo = {
    type: 'X-Tableau-Auth',
    username: 'test-user',
    server: MOCK_SERVER,
    siteId: 'site-luid-a',
    siteName: 'site-a',
    accessToken: 'tableau-access-token',
    refreshToken: 'tableau-refresh-token',
  };
  return extra;
}

async function getToolResult(extra: MockExtra): Promise<CallToolResult> {
  const tool = getListSitesTool(new WebMcpServer());
  const callback = await Provider.from(tool.callback);
  return await callback({}, extra);
}

describe('listSitesTool', () => {
  it('should create a tool instance with correct properties', async () => {
    const tool = getListSitesTool(new WebMcpServer());
    const annotations = await Provider.from(tool.annotations);
    expect(tool.name).toBe('list-sites');
    expect(tool.paramsSchema).toEqual({});
    expect(annotations?.readOnlyHint).toBe(true);
  });

  it('should return the configured sites with the Default site named', async () => {
    const result = await getToolResult(makeExtra(['site-a', '', 'site-b']));

    expect(result.isError).toBe(false);
    invariant(result.content[0].type === 'text');
    expect(JSON.parse(result.content[0].text).sites).toEqual(['site-a', 'Default', 'site-b']);
  });

  it('should state that access is verified when the switch is performed', async () => {
    const result = await getToolResult(makeExtra(['site-a']));

    invariant(result.content[0].type === 'text');
    expect(JSON.parse(result.content[0].text).note).toContain('verified against Tableau');
  });

  it('should reject passthrough sessions', async () => {
    const extra = makeExtra(['site-a']);
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
