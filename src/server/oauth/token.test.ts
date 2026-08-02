import { generateKeyPairSync } from 'crypto';
import express from 'express';
import { compactDecrypt } from 'jose';
import request from 'supertest';

import { generateCodeChallenge } from './generateCodeChallenge.js';
import { token } from './token.js';
import { AuthorizationCode, RefreshTokenData } from './types.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const CODE_VERIFIER = 'test-code-verifier';
const REDIRECT_URI = 'https://client.example.com/callback';
const CLIENT_ID = 'test-client-id';

function makeAuthorizationCode(): AuthorizationCode {
  return {
    user: { id: 'user-luid', name: 'user@example.com' },
    clientId: CLIENT_ID,
    server: 'https://tableau.example.com',
    tokens: {
      accessToken: 'wg|session|site-luid-1',
      refreshToken: 'tableau-refresh-token',
      expiresInSeconds: 3600,
    },
    scopes: ['tableau:mcp:content:read'],
    siteContentUrl: 'site-a',
    redirectUri: REDIRECT_URI,
    codeChallenge: generateCodeChallenge(CODE_VERIFIER),
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    tableauClientId: 'tableau-client-id',
  };
}

async function decryptAccessToken(jwe: string): Promise<Record<string, unknown>> {
  const { plaintext } = await compactDecrypt(jwe, privateKey);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

describe('token endpoint', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH', 'oauth');
    vi.stubEnv('OAUTH_ISSUER', 'https://mcp.example.com');
    vi.stubEnv('OAUTH_JWE_PRIVATE_KEY', privateKeyPem);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function startApp(authorizationCodes: Map<string, AuthorizationCode>): express.Application {
    const app = express();
    app.use(express.json());
    token(
      app,
      authorizationCodes,
      new Map<string, RefreshTokenData>(),
      publicKey,
      new Map<string, string>(),
    );
    return app;
  }

  async function exchangeCode(app: express.Application, code: string): Promise<string> {
    const response = await request(app).post('/oauth2/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: CODE_VERIFIER,
      client_id: CLIENT_ID,
    });

    expect(response.status).toBe(200);
    return response.body.access_token as string;
  }

  it('issues an access token carrying a jti claim', async () => {
    const authorizationCodes = new Map<string, AuthorizationCode>([
      ['code-1', makeAuthorizationCode()],
    ]);
    const app = startApp(authorizationCodes);

    const payload = await decryptAccessToken(await exchangeCode(app, 'code-1'));

    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.jti).not.toBe('');
  });

  it('issues a distinct jti per access token', async () => {
    const authorizationCodes = new Map<string, AuthorizationCode>([
      ['code-1', makeAuthorizationCode()],
      ['code-2', makeAuthorizationCode()],
    ]);
    const app = startApp(authorizationCodes);

    const first = await decryptAccessToken(await exchangeCode(app, 'code-1'));
    const second = await decryptAccessToken(await exchangeCode(app, 'code-2'));

    expect(first.jti).not.toBe(second.jti);
  });
});
