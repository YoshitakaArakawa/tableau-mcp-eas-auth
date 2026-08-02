import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { WebMcpServer } from '../../../server.web.js';
import invariant from '../../../utils/invariant.js';
import { Provider } from '../../../utils/provider.js';
import { getMockRequestHandlerExtra } from '../toolContext.mock.js';
import { getSwitchSiteTool } from './switchSite.js';

const MOCK_ISSUER = 'https://mcp.example.com';
const MOCK_JWE_TOKEN = 'eyJhbGciOiJSU0EtT0FFUC0yNTYifQ.encrypted-key.iv.ciphertext.tag';
const MOCK_SERVER = 'https://my-tableau-server.com';

type MockExtra = ReturnType<typeof getMockRequestHandlerExtra> & { authInfo?: AuthInfo };

function makeExtra({
  siteName = 'site-a',
  switchableSites = ['site-a', 'site-b', ''],
}: { siteName?: string; switchableSites?: string[] } = {}): MockExtra {
  const extra = getMockRequestHandlerExtra() as MockExtra;
  extra.config.oauth.issuer = MOCK_ISSUER;
  extra.config.oauth.switchableSites = switchableSites;
  extra.tableauAuthInfo = {
    type: 'X-Tableau-Auth',
    username: 'test-user',
    server: MOCK_SERVER,
    siteId: 'site-luid-a',
    siteName,
    accessToken: 'tableau-access-token',
    refreshToken: 'tableau-refresh-token',
  };
  extra.authInfo = {
    token: MOCK_JWE_TOKEN,
    clientId: 'test-client',
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  return extra;
}

async function getToolResult(extra: MockExtra, site: string): Promise<CallToolResult> {
  const tool = getSwitchSiteTool(new WebMcpServer());
  const callback = await Provider.from(tool.callback);
  return await callback({ site }, extra);
}

describe('switchSiteTool', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should create a tool instance with correct properties', async () => {
    const tool = getSwitchSiteTool(new WebMcpServer());
    const annotations = await Provider.from(tool.annotations);
    expect(tool.name).toBe('switch-site');
    expect(annotations?.readOnlyHint).toBe(false);
    expect(annotations?.destructiveHint).toBe(false);
    expect(annotations?.idempotentHint).toBe(true);
    expect(annotations?.openWorldHint).toBe(false);
  });

  describe('disabled property', () => {
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      savedEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = savedEnv;
    });

    function setEmbeddedOAuthEnv(): void {
      process.env.AUTH = 'oauth';
      process.env.OAUTH_ISSUER = MOCK_ISSUER;
      process.env.OAUTH_JWE_PRIVATE_KEY = 'test-key';
    }

    it('should be disabled when AUTH is not oauth (default PAT mode)', async () => {
      process.env.OAUTH_SWITCHABLE_SITES = 'site-b';
      const tool = getSwitchSiteTool(new WebMcpServer());
      expect(await Provider.from(tool.disabled)).toBe(true);
    });

    it('should be disabled when no switchable sites are configured', async () => {
      setEmbeddedOAuthEnv();
      const tool = getSwitchSiteTool(new WebMcpServer());
      expect(await Provider.from(tool.disabled)).toBe(true);
    });

    it('should be disabled when the embedded authorization server is not used', async () => {
      process.env.AUTH = 'oauth';
      process.env.OAUTH_ISSUER = MOCK_ISSUER;
      process.env.OAUTH_EMBEDDED_AUTHZ_SERVER = 'false';
      process.env.OAUTH_SWITCHABLE_SITES = 'site-b';
      const tool = getSwitchSiteTool(new WebMcpServer());
      expect(await Provider.from(tool.disabled)).toBe(true);
    });

    it('should be enabled for an embedded OAuth server with switchable sites', async () => {
      setEmbeddedOAuthEnv();
      process.env.OAUTH_SWITCHABLE_SITES = 'site-b';
      const tool = getSwitchSiteTool(new WebMcpServer());
      expect(await Provider.from(tool.disabled)).toBe(false);
    });
  });

  it('should reject a site outside the allowlist and list the allowed sites', async () => {
    const result = await getToolResult(makeExtra(), 'site-c');

    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('site-a, site-b, Default');
  });

  it('should return success without calling the endpoint when already on the site', async () => {
    const result = await getToolResult(makeExtra({ siteName: 'site-a' }), 'site-a');

    expect(result.isError).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('Already on site site-a');
  });

  it('should POST the session token and the requested site to the switch endpoint', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ site: 'site-b', previousTokenRevoked: true }), { status: 200 }),
    );

    await getToolResult(makeExtra(), 'site-b');

    expect(mockFetch).toHaveBeenCalledWith(
      `${MOCK_ISSUER}/oauth2/switchSite`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: MOCK_JWE_TOKEN, site: 'site-b' }),
      }),
    );
  });

  it('should send the Default site as an empty content URL', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ site: 'Default', previousTokenRevoked: true }), {
        status: 200,
      }),
    );

    const result = await getToolResult(makeExtra(), 'default');

    expect(mockFetch).toHaveBeenCalledWith(
      `${MOCK_ISSUER}/oauth2/switchSite`,
      expect.objectContaining({
        body: JSON.stringify({ token: MOCK_JWE_TOKEN, site: '' }),
      }),
    );
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('Switched to site Default');
  });

  it('should say the switch takes effect from the next request', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ site: 'site-b', previousTokenRevoked: true }), { status: 200 }),
    );

    const result = await getToolResult(makeExtra(), 'site-b');

    expect(result.isError).toBe(false);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('next request');
  });

  it('should warn that the switch waits for credential renewal when the token was not revoked', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ site: 'site-b', previousTokenRevoked: false }), {
        status: 200,
      }),
    );

    const result = await getToolResult(makeExtra(), 'site-b');

    expect(result.isError).toBe(false);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('credentials are renewed');
  });

  it('should surface the error description returned by the switch endpoint', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_site',
          error_description: 'The user may not have access to that site.',
        }),
        { status: 403 },
      ),
    );

    const result = await getToolResult(makeExtra(), 'site-b');

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('may not have access');
  });

  it('should fall back to the status code when the endpoint returns no description', async () => {
    mockFetch.mockResolvedValue(new Response('gateway error', { status: 502 }));

    const result = await getToolResult(makeExtra(), 'site-b');

    expect(result.isError).toBe(true);
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('502');
  });

  it('should reject passthrough sessions without calling the endpoint', async () => {
    const extra = makeExtra();
    extra.tableauAuthInfo = {
      type: 'Passthrough',
      username: 'test-user',
      userId: 'user-id',
      server: MOCK_SERVER,
      siteId: 'site-id',
      siteName: 'site-a',
      raw: 'x-tableau-auth-session-token',
    };

    const result = await getToolResult(extra, 'site-b');

    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    invariant(result.content[0].type === 'text');
    expect(result.content[0].text).toContain('authorization server');
  });

  it('should not expose the raw session token in the response', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ site: 'site-b', previousTokenRevoked: true }), { status: 200 }),
    );

    const result = await getToolResult(makeExtra(), 'site-b');

    const fullText = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(fullText).not.toContain(MOCK_JWE_TOKEN);
  });
});
