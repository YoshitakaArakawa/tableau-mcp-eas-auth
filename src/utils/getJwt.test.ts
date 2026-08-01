import { randomUUID } from 'node:crypto';

import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';

import { getJwt } from './getJwt.js';

vi.mock('node:crypto', () => {
  return { randomUUID: vi.fn(() => '123e4567-e89b-12d3-a456-426614174000') };
});

describe('getJwt', () => {
  const mockUsername = 'test-user';
  const mockScopes = new Set(['read', 'write']);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('connected-app', () => {
    const mockConnectedApp = {
      clientId: 'test-client-id',
      secretId: 'test-secret-id',
      secretValue: 'test-secret-value',
    };

    it('should include correct header in the token', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'connected-app', ...mockConnectedApp },
        scopes: mockScopes,
      });

      const decodedHeader = decodeProtectedHeader(token);
      expect(decodedHeader).toEqual({
        alg: 'HS256',
        typ: 'JWT',
        kid: mockConnectedApp.secretId,
      });
    });

    it('should include correct payload in the token', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'connected-app', ...mockConnectedApp },
        scopes: mockScopes,
      });

      const decodedPayload = decodeJwt(token);
      expect(decodedPayload).toMatchObject({
        jti: '123e4567-e89b-12d3-a456-426614174000',
        iss: mockConnectedApp.clientId,
        aud: 'tableau',
        sub: mockUsername,
        scp: [...mockScopes],
      });

      // Verify timestamp fields are within expected ranges
      const now = Math.floor(Date.now() / 1000);
      expect(decodedPayload.iat).toBeLessThanOrEqual(now);
      expect(decodedPayload.exp).toBeGreaterThan(now);
      expect(decodedPayload.nbf).toBeLessThanOrEqual(now);
    });

    it('should generate a token that can be verified with the secret', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'connected-app', ...mockConnectedApp },
        scopes: mockScopes,
      });

      await expect(
        jwtVerify(token, new TextEncoder().encode(mockConnectedApp.secretValue)),
      ).resolves.not.toThrow();
    });

    it('should throw when verifying with incorrect secret', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'connected-app', ...mockConnectedApp },
        scopes: mockScopes,
      });

      await expect(jwtVerify(token, new TextEncoder().encode('wrong-secret'))).rejects.toThrow();
    });
  });

  describe('uat', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(privateKey);

    const mockUatConfig = {
      tenantId: 'test-tenant-id',
      issuer: 'test-issuer',
      usernameClaimName: 'email',
      username: mockUsername,
      keyId: 'test-key-id',
      privateKey: privateKeyPem,
    };

    it('should include correct header in the token', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: {
          type: 'uat',
          ...mockUatConfig,
        },
        scopes: mockScopes,
      });

      const decodedHeader = decodeProtectedHeader(token);
      expect(decodedHeader).toEqual({
        alg: 'RS256',
        typ: 'JWT',
        kid: mockUatConfig.keyId,
      });
    });

    it('should include correct payload in the token', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'uat', ...mockUatConfig },
        scopes: mockScopes,
      });

      const decodedPayload = decodeJwt(token);
      expect(decodedPayload).toMatchObject({
        jti: `${mockUatConfig.issuer}-${decodedPayload.iat}`,
        iss: mockUatConfig.issuer,
        email: mockUsername,
        scp: [...mockScopes],
        'https://tableau.com/tenantId': mockUatConfig.tenantId,
      });

      // Verify timestamp fields are within expected ranges
      const now = Math.floor(Date.now() / 1000);
      expect(decodedPayload.iat).toBeLessThanOrEqual(now);
      expect(decodedPayload.exp).toBeGreaterThan(now);
      expect(decodedPayload.nbf).toBeLessThanOrEqual(now);
    });

    it('should generate a token that can be verified with the secret', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'uat', ...mockUatConfig },
        scopes: mockScopes,
      });

      await expect(jwtVerify(token, publicKey)).resolves.not.toThrow();
    });

    it('should include the username claim in the payload', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'uat', ...mockUatConfig, usernameClaimName: 'username' },
        scopes: mockScopes,
      });
      const decodedPayload = decodeJwt(token);
      expect(decodedPayload.username).toBe(mockUsername);
      expect(decodedPayload.email).toBeUndefined();
    });

    it('should throw when verifying with incorrect secret', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'uat', ...mockUatConfig },
        scopes: mockScopes,
      });

      const { publicKey: wrongPublicKey } = await generateKeyPair('RS256');
      await expect(jwtVerify(token, wrongPublicKey)).rejects.toThrow();
    });
  });

  describe('eas', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const privateKeyPem = await exportPKCS8(privateKey);

    const mockEasConfig = {
      issuer: 'https://mcp.example.com',
      audience: 'tableau',
      keyId: 'test-key-id',
      privateKey: privateKeyPem,
    };

    it('should include correct header in the token', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'eas', ...mockEasConfig },
        scopes: mockScopes,
      });

      const decodedHeader = decodeProtectedHeader(token);
      expect(decodedHeader).toEqual({
        alg: 'RS256',
        typ: 'JWT',
        kid: mockEasConfig.keyId,
      });
    });

    it('should include correct payload in the token', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'eas', ...mockEasConfig },
        scopes: mockScopes,
      });

      const decodedPayload = decodeJwt(token);
      expect(decodedPayload).toMatchObject({
        jti: '123e4567-e89b-12d3-a456-426614174000',
        iss: mockEasConfig.issuer,
        aud: mockEasConfig.audience,
        sub: mockUsername,
        scp: [...mockScopes],
      });

      // Verify timestamp fields are within expected ranges
      const now = Math.floor(Date.now() / 1000);
      expect(decodedPayload.iat).toBeLessThanOrEqual(now);
      expect(decodedPayload.exp).toBeGreaterThan(now);
      expect(decodedPayload.nbf).toBeLessThanOrEqual(now);
    });

    it('should use the configured audience', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'eas', ...mockEasConfig, audience: 'tableau:test-site-luid' },
        scopes: mockScopes,
      });

      expect(decodeJwt(token).aud).toBe('tableau:test-site-luid');
    });

    it('should generate a unique jti for each token', async () => {
      // Tableau rejects a reused jti with error 10091, so every call must produce a new one.
      vi.mocked(randomUUID)
        .mockReturnValueOnce('11111111-1111-1111-1111-111111111111')
        .mockReturnValueOnce('22222222-2222-2222-2222-222222222222');

      const [first, second] = await Promise.all([
        getJwt({
          username: mockUsername,
          config: { type: 'eas', ...mockEasConfig },
          scopes: mockScopes,
        }),
        getJwt({
          username: mockUsername,
          config: { type: 'eas', ...mockEasConfig },
          scopes: mockScopes,
        }),
      ]);

      expect(decodeJwt(first).jti).not.toBe(decodeJwt(second).jti);
    });

    it('should generate a token that can be verified with the public key', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'eas', ...mockEasConfig },
        scopes: mockScopes,
      });

      await expect(jwtVerify(token, publicKey)).resolves.not.toThrow();
    });

    it('should throw when verifying with incorrect key', async () => {
      const token = await getJwt({
        username: mockUsername,
        config: { type: 'eas', ...mockEasConfig },
        scopes: mockScopes,
      });

      const { publicKey: wrongPublicKey } = await generateKeyPair('RS256');
      await expect(jwtVerify(token, wrongPublicKey)).rejects.toThrow();
    });
  });
});
