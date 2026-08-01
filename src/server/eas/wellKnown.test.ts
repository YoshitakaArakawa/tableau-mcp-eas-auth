import express from 'express';
import { exportPKCS8, generateKeyPair } from 'jose';
import request from 'supertest';

import { Config } from '../../config.js';
import { setupEasWellKnownRoutes } from './wellKnown.js';

const easIssuer = 'https://mcp.example.com';
const easKeyId = 'test-key-id';

// The routes only read the EAS fields, so a minimal cast keeps these tests focused on the unit.
const easConfig = (easPrivateKey: string): Config =>
  ({ easIssuer, easKeyId, easPrivateKey }) as unknown as Config;

describe('EAS well-known routes', async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);

  async function startApp(): Promise<express.Application> {
    const app = express();
    await setupEasWellKnownRoutes(app, easConfig(privateKeyPem));
    return app;
  }

  it('serves the public JWK of the EAS signing key', async () => {
    const app = await startApp();

    const response = await request(app).get('/.well-known/jwks.json');
    expect(response.status).toBe(200);
    expect(response.body.keys).toHaveLength(1);

    const [jwk] = response.body.keys;
    expect(jwk).toMatchObject({
      kty: 'RSA',
      kid: easKeyId,
      use: 'sig',
      alg: 'RS256',
    });
    expect(jwk.n).toBeTruthy();
    expect(jwk.e).toBeTruthy();
  });

  it('does not expose the private key components in the JWKS', async () => {
    const app = await startApp();

    const response = await request(app).get('/.well-known/jwks.json');
    const [jwk] = response.body.keys;
    expect(jwk.d).toBeUndefined();
    expect(jwk.p).toBeUndefined();
    expect(jwk.q).toBeUndefined();
  });

  it('serves IdP metadata pointing at the JWKS URI', async () => {
    const app = await startApp();

    const response = await request(app).get('/.well-known/openid-configuration');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      issuer: easIssuer,
      jwks_uri: `${easIssuer}/.well-known/jwks.json`,
    });
  });

  it('throws when the configured private key is unusable', async () => {
    const app = express();

    await expect(setupEasWellKnownRoutes(app, easConfig('not-a-pem'))).rejects.toThrow();
  });
});
