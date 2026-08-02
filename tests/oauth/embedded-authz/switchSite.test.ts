import express from 'express';
import http from 'http';
import request from 'supertest';
import { Ok } from 'ts-results-es';

import { getConfig } from '../../../src/config.js';
import { RestApi } from '../../../src/sdks/tableau/restApi.js';
import { startExpressServer } from '../../../src/server/express.js';
import { exchangeAuthzCodeForAccessToken } from './exchangeAuthzCodeForAccessToken.js';
import { resetEnv, setEnv } from './testEnv.js';

const mocks = vi.hoisted(() => ({
  mockGetTokenResult: vi.fn(),
}));

vi.mock('../../../src/sdks/tableau-oauth/methods.js', () => ({
  getTokenResult: mocks.mockGetTokenResult,
}));

const SWITCHED_SITE = 'site-b';

describe('site switching', () => {
  let _server: http.Server | undefined;

  beforeAll(setEnv);
  afterAll(resetEnv);

  beforeEach(() => {
    vi.clearAllMocks();
    _server = undefined;
    process.env.OAUTH_SWITCHABLE_SITES = `mcp-test,${SWITCHED_SITE}`;
  });

  afterEach(async () => {
    delete process.env.OAUTH_SWITCHABLE_SITES;
    await new Promise<void>((resolve) => {
      if (_server) {
        _server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  });

  async function startServer(): Promise<{ app: express.Application }> {
    const { app, server } = await startExpressServer({
      basePath: 'tableau-mcp',
      config: getConfig(),
      logLevel: 'info',
    });

    _server = server;
    return { app };
  }

  function mockTableauTokens(accessToken: string): void {
    mocks.mockGetTokenResult.mockResolvedValue({
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      expiresInSeconds: 3600,
      originHost: '10ax.online.tableau.com',
    });
  }

  // The suite-wide RestApi mock always reports the site the session started on, so the endpoint's
  // post-switch confirmation has to be told where the new session landed.
  function mockSessionOnSite(contentUrl: string): void {
    vi.mocked(RestApi).mockImplementationOnce(
      () =>
        ({
          setCredentials: vi.fn(),
          authenticatedServerMethods: {
            getCurrentServerSession: vi.fn().mockResolvedValue(
              Ok({
                site: { id: 'switched-site-id', name: contentUrl, contentUrl },
                user: { id: 'user_id', name: 'test-user' },
              }),
            ),
          },
        }) as unknown as RestApi,
    );
  }

  async function switchTo(
    app: express.Application,
    token: string,
    site: string,
  ): Promise<request.Response> {
    return await request(app).post('/oauth2/switchSite').send({ token, site });
  }

  it('should move the session to the requested site and refresh into it', async () => {
    const { app } = await startServer();
    mockTableauTokens('initial-access-token');

    const { access_token, refresh_token } = await exchangeAuthzCodeForAccessToken(app);

    mockTableauTokens('switched-access-token');
    mockSessionOnSite(SWITCHED_SITE);

    const switchResponse = await switchTo(app, access_token, SWITCHED_SITE);

    expect(switchResponse.status).toBe(200);
    expect(switchResponse.body).toEqual({
      site: SWITCHED_SITE,
      siteLuid: 'switched-site-id',
      previousTokenRevoked: true,
    });

    // The revoked access token now fails validation, and the challenge tells the client to refresh.
    const rejectedResponse = await request(app)
      .post('/tableau-mcp')
      .set('Authorization', `Bearer ${access_token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(rejectedResponse.status).toBe(401);
    expect(rejectedResponse.body.error).toBe('invalid_token');
    expect(rejectedResponse.headers['www-authenticate']).toContain('error="invalid_token"');

    // The refresh handler is unchanged: it reads the site from the grant, which now names site-b.
    mockTableauTokens('refreshed-access-token');

    const refreshResponse = await request(app).post('/oauth2/token').send({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
    });

    expect(refreshResponse.status).toBe(200);
    expect(mocks.mockGetTokenResult.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        grant_type: 'refresh_token',
        site_namespace: SWITCHED_SITE,
      }),
    );
  });

  it('should keep the session on the original site when the Tableau exchange fails', async () => {
    const { app } = await startServer();
    mockTableauTokens('initial-access-token');

    const { access_token, refresh_token } = await exchangeAuthzCodeForAccessToken(app);

    mocks.mockGetTokenResult.mockRejectedValueOnce(new Error('Tableau rejected the exchange'));

    const switchResponse = await switchTo(app, access_token, SWITCHED_SITE);

    expect(switchResponse.status).toBe(400);
    expect(switchResponse.body.error).toBe('switch_failed');

    mockTableauTokens('refreshed-access-token');

    await request(app).post('/oauth2/token').send({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
    });

    expect(mocks.mockGetTokenResult.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        grant_type: 'refresh_token',
        site_namespace: 'mcp-test',
      }),
    );
  });

  it('should reject a site outside the allowlist', async () => {
    const { app } = await startServer();
    mockTableauTokens('initial-access-token');

    const { access_token } = await exchangeAuthzCodeForAccessToken(app);

    const switchResponse = await switchTo(app, access_token, 'site-c');

    expect(switchResponse.status).toBe(403);
    expect(switchResponse.body.error).toBe('invalid_site');
  });

  it('should not expose the endpoint when no switchable sites are configured', async () => {
    delete process.env.OAUTH_SWITCHABLE_SITES;
    const { app } = await startServer();

    const switchResponse = await switchTo(app, 'irrelevant', SWITCHED_SITE);

    expect(switchResponse.status).toBe(404);
  });
});
