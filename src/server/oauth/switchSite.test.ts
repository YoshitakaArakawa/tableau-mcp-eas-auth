import { generateKeyPairSync } from 'crypto';
import express from 'express';
import { CompactEncrypt } from 'jose';
import request from 'supertest';
import { Err, Ok } from 'ts-results-es';

import { RestApi } from '../../sdks/tableau/restApi.js';
import { ExpiringMap } from '../../utils/expiringMap.js';
import { EmbeddedOAuthProvider } from './provider.js';
import { switchSite } from './switchSite.js';
import { AUDIENCE } from './token.js';
import { RefreshTokenData } from './types.js';

const mocks = vi.hoisted(() => ({
  getTokenResult: vi.fn(),
}));

vi.mock('../../sdks/tableau-oauth/methods.js', () => ({
  getTokenResult: mocks.getTokenResult,
}));

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ISSUER = 'https://mcp.example.com';
const CLIENT_ID = 'test-client-id';
const TABLEAU_SERVER = 'https://tableau.example.com';
const TABLEAU_ACCESS_TOKEN = 'wg|session-a|site-luid-a';
const SWITCHED_ACCESS_TOKEN = 'wg|session-b|site-luid-b';
const REFRESH_TOKEN_ID = 'refresh-token-id';

function futureSeconds(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

function makeTokenPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    exp: futureSeconds(),
    iat: Math.floor(Date.now() / 1000),
    sub: 'user@example.com',
    clientId: CLIENT_ID,
    tableauServer: TABLEAU_SERVER,
    jti: 'jti-1',
    scope: 'tableau:mcp:content:read tableau:site:site-a',
    tableauAccessToken: TABLEAU_ACCESS_TOKEN,
    tableauRefreshToken: 'tableau-refresh-token',
    tableauExpiresAt: futureSeconds(),
    tableauUserId: 'user-luid',
    tableauSiteId: 'site-luid-a',
    ...overrides,
  };
}

async function makeJwe(payload: Record<string, unknown>): Promise<string> {
  return await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
    .encrypt(publicKey);
}

function makeGrant(siteContentUrl = 'site-a'): RefreshTokenData {
  return {
    user: { id: 'user-luid', name: 'user@example.com' },
    clientId: CLIENT_ID,
    server: TABLEAU_SERVER,
    tokens: {
      accessToken: TABLEAU_ACCESS_TOKEN,
      refreshToken: 'tableau-refresh-token',
      expiresInSeconds: 3600,
    },
    scopes: ['tableau:mcp:content:read'],
    siteContentUrl,
    siteScope: 'tableau:site:site-a',
    expiresAt: futureSeconds(),
    tableauClientId: 'tableau-client-id',
  };
}

function mockSwitchedSession(contentUrl: string, id = 'site-luid-b'): void {
  vi.mocked(RestApi).mockImplementationOnce(
    () =>
      ({
        setCredentials: vi.fn(),
        authenticatedServerMethods: {
          getCurrentServerSession: vi.fn().mockResolvedValue(
            new Ok({
              site: { id, name: 'site-name', contentUrl },
              user: { id: 'user-luid', name: 'user@example.com' },
            }),
          ),
        },
      }) as unknown as RestApi,
  );
}

function mockSwitchedTokens(): void {
  mocks.getTokenResult.mockResolvedValue({
    accessToken: SWITCHED_ACCESS_TOKEN,
    refreshToken: 'switched-refresh-token',
    expiresInSeconds: 3600,
    originHost: 'tableau.example.com',
  });
}

describe('switch site endpoint', () => {
  let refreshTokens: Map<string, RefreshTokenData>;
  let refreshTokenIndex: Map<string, string>;
  let revokedJtis: ExpiringMap<string, true>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH', 'oauth');
    vi.stubEnv('OAUTH_ISSUER', ISSUER);
    vi.stubEnv('OAUTH_JWE_PRIVATE_KEY', privateKeyPem);
    vi.stubEnv('OAUTH_SWITCHABLE_SITES', 'site-a,site-b,Default');

    refreshTokens = new Map<string, RefreshTokenData>([[REFRESH_TOKEN_ID, makeGrant()]]);
    refreshTokenIndex = new Map<string, string>([[TABLEAU_ACCESS_TOKEN, REFRESH_TOKEN_ID]]);
    revokedJtis = new ExpiringMap<string, true>({ defaultExpirationTimeMs: 60_000 });
  });

  afterEach(() => {
    revokedJtis.clear();
    vi.unstubAllEnvs();
  });

  function startApp(): express.Application {
    const app = express();
    app.use(express.json());
    switchSite(app, refreshTokens, privateKey, refreshTokenIndex, revokedJtis);
    return app;
  }

  async function postSwitch(
    app: express.Application,
    site: string,
    token?: string,
  ): Promise<request.Response> {
    return await request(app)
      .post('/oauth2/switchSite')
      .send({ token: token ?? (await makeJwe(makeTokenPayload())), site });
  }

  it('rejects a site outside the allowlist without touching the grant', async () => {
    const app = startApp();

    const response = await postSwitch(app, 'site-c');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('invalid_site');
    expect(mocks.getTokenResult).not.toHaveBeenCalled();
    expect(refreshTokens.get(REFRESH_TOKEN_ID)?.siteContentUrl).toBe('site-a');
    expect(revokedJtis.size).toBe(0);
  });

  it('rejects a token whose jti has already been revoked', async () => {
    revokedJtis.set('jti-1', true);
    const app = startApp();

    const response = await postSwitch(app, 'site-b');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_token');
    expect(mocks.getTokenResult).not.toHaveBeenCalled();
  });

  it('is a no-op when the grant is already on the requested site', async () => {
    const app = startApp();

    const response = await postSwitch(app, 'site-a');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      site: 'site-a',
      siteLuid: 'site-luid-a',
      previousTokenRevoked: false,
    });
    expect(mocks.getTokenResult).not.toHaveBeenCalled();
    expect(revokedJtis.size).toBe(0);
  });

  it('returns invalid_grant when no grant matches the access token', async () => {
    refreshTokenIndex.clear();
    const app = startApp();

    const response = await postSwitch(app, 'site-b');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_grant');
    expect(mocks.getTokenResult).not.toHaveBeenCalled();
  });

  it('leaves the grant unchanged when the Tableau exchange fails', async () => {
    mocks.getTokenResult.mockRejectedValue(new Error('Tableau rejected the exchange'));
    const app = startApp();

    const response = await postSwitch(app, 'site-b');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('switch_failed');

    const grant = refreshTokens.get(REFRESH_TOKEN_ID);
    expect(grant?.siteContentUrl).toBe('site-a');
    expect(grant?.tokens.accessToken).toBe(TABLEAU_ACCESS_TOKEN);
    expect(refreshTokenIndex.get(TABLEAU_ACCESS_TOKEN)).toBe(REFRESH_TOKEN_ID);
    expect(revokedJtis.size).toBe(0);
  });

  it('leaves the grant unchanged when Tableau lands the session on another site', async () => {
    mockSwitchedTokens();
    mockSwitchedSession('site-a');
    const app = startApp();

    const response = await postSwitch(app, 'site-b');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('invalid_site');

    const grant = refreshTokens.get(REFRESH_TOKEN_ID);
    expect(grant?.siteContentUrl).toBe('site-a');
    expect(grant?.tokens.accessToken).toBe(TABLEAU_ACCESS_TOKEN);
    expect(refreshTokenIndex.has(SWITCHED_ACCESS_TOKEN)).toBe(false);
    expect(revokedJtis.size).toBe(0);
  });

  it('exchanges the Tableau refresh token against the requested site', async () => {
    mockSwitchedTokens();
    mockSwitchedSession('site-b');
    const app = startApp();

    await postSwitch(app, 'site-b');

    expect(mocks.getTokenResult.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        grant_type: 'refresh_token',
        refresh_token: 'tableau-refresh-token',
        site_namespace: 'site-b',
      }),
    );
  });

  it('rewrites the grant in place and revokes the submitted token', async () => {
    mockSwitchedTokens();
    mockSwitchedSession('site-b');
    const app = startApp();

    const response = await postSwitch(app, 'site-b');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      site: 'site-b',
      siteLuid: 'site-luid-b',
      previousTokenRevoked: true,
    });

    const grant = refreshTokens.get(REFRESH_TOKEN_ID);
    expect(grant?.siteContentUrl).toBe('site-b');
    expect(grant?.siteScope).toBe('tableau:site:site-b');
    expect(grant?.tokens).toEqual({
      accessToken: SWITCHED_ACCESS_TOKEN,
      refreshToken: 'switched-refresh-token',
      expiresInSeconds: 3600,
    });
    expect(refreshTokenIndex.get(SWITCHED_ACCESS_TOKEN)).toBe(REFRESH_TOKEN_ID);
    expect(refreshTokenIndex.has(TABLEAU_ACCESS_TOKEN)).toBe(false);
    expect(revokedJtis.has('jti-1')).toBe(true);
  });

  it('keeps the MCP refresh token ID so the client can still refresh', async () => {
    mockSwitchedTokens();
    mockSwitchedSession('site-b');
    const app = startApp();

    await postSwitch(app, 'site-b');

    expect([...refreshTokens.keys()]).toEqual([REFRESH_TOKEN_ID]);
  });

  it('records no site scope when switching to the Default site', async () => {
    mockSwitchedTokens();
    mockSwitchedSession('');
    const app = startApp();

    const response = await postSwitch(app, 'Default');

    expect(response.status).toBe(200);
    expect(response.body.site).toBe('Default');
    expect(refreshTokens.get(REFRESH_TOKEN_ID)?.siteScope).toBeUndefined();
  });

  it('switches a token issued without a jti but reports that it was not revoked', async () => {
    mockSwitchedTokens();
    mockSwitchedSession('site-b');
    const app = startApp();
    const { jti: _jti, ...withoutJti } = makeTokenPayload();

    const response = await postSwitch(app, 'site-b', await makeJwe(withoutJti));

    expect(response.status).toBe(200);
    expect(response.body.previousTokenRevoked).toBe(false);
    expect(refreshTokens.get(REFRESH_TOKEN_ID)?.siteContentUrl).toBe('site-b');
    expect(revokedJtis.size).toBe(0);
  });

  it('rejects a token that carries no Tableau session', async () => {
    const app = startApp();
    const { tableauAccessToken: _accessToken, ...withoutSession } = makeTokenPayload();

    const response = await postSwitch(app, 'site-b', await makeJwe(withoutSession));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_token');
  });

  it('reports a failure to read the switched session as a failed switch', async () => {
    mockSwitchedTokens();
    vi.mocked(RestApi).mockImplementationOnce(
      () =>
        ({
          setCredentials: vi.fn(),
          authenticatedServerMethods: {
            getCurrentServerSession: vi
              .fn()
              .mockResolvedValue(new Err({ type: 'unauthorized', message: 'unauthorized' })),
          },
        }) as unknown as RestApi,
    );
    const app = startApp();

    const response = await postSwitch(app, 'site-b');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('switch_failed');
    expect(refreshTokens.get(REFRESH_TOKEN_ID)?.siteContentUrl).toBe('site-a');
  });
});

describe('switch site route registration', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH', 'oauth');
    vi.stubEnv('OAUTH_ISSUER', ISSUER);
    vi.stubEnv('OAUTH_JWE_PRIVATE_KEY', privateKeyPem);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function startProviderApp(): express.Application {
    const app = express();
    app.use(express.json());
    new EmbeddedOAuthProvider().setupRoutes(app);
    return app;
  }

  it('does not mount the endpoint when no switchable sites are configured', async () => {
    const response = await request(startProviderApp())
      .post('/oauth2/switchSite')
      .send({ token: 'irrelevant', site: 'site-b' });

    expect(response.status).toBe(404);
  });

  it('mounts the endpoint when switchable sites are configured', async () => {
    vi.stubEnv('OAUTH_SWITCHABLE_SITES', 'site-b');

    const response = await request(startProviderApp())
      .post('/oauth2/switchSite')
      .send({ token: 'not-a-jwe', site: 'site-b' });

    expect(response.status).toBe(401);
  });
});
