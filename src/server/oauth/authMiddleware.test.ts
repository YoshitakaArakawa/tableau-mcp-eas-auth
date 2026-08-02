import { NextFunction, Response } from 'express';
import { Err, Ok } from 'ts-results-es';

import { AccessTokenValidator } from './accessTokenValidator.js';
import { authMiddleware } from './authMiddleware.js';
import { AuthenticatedRequest } from './types.js';

const MOCK_RESOURCE_URI = 'https://mcp.example.com';
const INTERNAL_ERROR = 'Invalid access token: tableauSiteId must be a string at "tableauSiteId"';

function makeValidator(
  result: Awaited<ReturnType<AccessTokenValidator['validate']>>,
): AccessTokenValidator {
  return { validate: vi.fn().mockResolvedValue(result) } as unknown as AccessTokenValidator;
}

function makeResponse(): Response & {
  headers: Record<string, string>;
  body: unknown;
  statusCode: number;
  sseHeaders: Record<string, string>;
  writtenData: string[];
} {
  const res = {
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    statusCode: 0,
    sseHeaders: {} as Record<string, string>,
    writtenData: [] as string[],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    header(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    writeHead(code: number, headers: Record<string, string>) {
      res.statusCode = code;
      res.sseHeaders = headers;
      return res;
    },
    write(chunk: string) {
      res.writtenData.push(chunk);
      return true;
    },
    end() {
      return res;
    },
  };

  return res as unknown as ReturnType<typeof makeResponse>;
}

function makeRequest(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer some-token' },
    body: {},
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH', 'oauth');
    vi.stubEnv('OAUTH_ISSUER', 'https://sso.example.com');
    vi.stubEnv('OAUTH_EMBEDDED_AUTHZ_SERVER', 'false');
    vi.stubEnv('OAUTH_DISABLE_SCOPES', 'true');
    vi.stubEnv('OAUTH_RESOURCE_URI', MOCK_RESOURCE_URI);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('access token validation failure', () => {
    it('responds 401 with a WWW-Authenticate challenge', async () => {
      const middleware = authMiddleware(makeValidator(new Err(INTERNAL_ERROR)));
      const res = makeResponse();
      const next = vi.fn() as unknown as NextFunction;

      await middleware(makeRequest(), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.headers['WWW-Authenticate']).toBe(
        'Bearer realm="MCP", error="invalid_token", error_description="The access token is invalid or expired", ' +
          `resource_metadata="${MOCK_RESOURCE_URI}/.well-known/oauth-protected-resource"`,
      );
    });

    it('does not leak the internal validation error into the challenge', async () => {
      const middleware = authMiddleware(makeValidator(new Err(INTERNAL_ERROR)));
      const res = makeResponse();

      await middleware(makeRequest(), res, vi.fn() as unknown as NextFunction);

      expect(res.headers['WWW-Authenticate']).not.toContain(INTERNAL_ERROR);
      expect(res.headers['WWW-Authenticate']).not.toContain('tableauSiteId');
    });

    it('sets the WWW-Authenticate challenge on the SSE error response', async () => {
      const middleware = authMiddleware(makeValidator(new Err(INTERNAL_ERROR)));
      const res = makeResponse();
      const req = makeRequest({
        method: 'GET',
        headers: { authorization: 'Bearer some-token', accept: 'text/event-stream' },
      } as Partial<AuthenticatedRequest>);

      await middleware(req, res, vi.fn() as unknown as NextFunction);

      expect(res.statusCode).toBe(401);
      expect(res.sseHeaders['WWW-Authenticate']).toContain('error="invalid_token"');
      expect(res.sseHeaders['WWW-Authenticate']).toContain(
        `resource_metadata="${MOCK_RESOURCE_URI}/.well-known/oauth-protected-resource"`,
      );
      expect(res.sseHeaders['WWW-Authenticate']).not.toContain(INTERNAL_ERROR);
    });
  });

  it('calls next() when the access token is valid', async () => {
    const authInfo = {
      token: 'some-token',
      clientId: 'client-1',
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const middleware = authMiddleware(makeValidator(new Ok(authInfo)));
    const res = makeResponse();
    const next = vi.fn() as unknown as NextFunction;
    const req = makeRequest();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.auth).toEqual(authInfo);
  });
});
