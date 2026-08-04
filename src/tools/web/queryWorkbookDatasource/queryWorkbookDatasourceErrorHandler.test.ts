import { describe, expect, it } from 'vitest';

import {
  DATASOURCE_NOT_IN_SESSION_MESSAGE,
  handleQueryWorkbookDatasourceError,
  MISSING_SESSION_HEADERS_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
} from './queryWorkbookDatasourceErrorHandler.js';

// The inputs below are the response bodies measured against a live site; see
// verification/vds-embedding-id/FINDINGS.md sections 6 and 9.
describe('handleQueryWorkbookDatasourceError', () => {
  it('translates an expired or forged session into a re-render instruction', () => {
    const error = handleQueryWorkbookDatasourceError('Session is no longer valid.', 401, '401002');

    expect(error.message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(error.statusCode).toBe(401);
    expect(error.type).toBe('vizql-session-expired');
  });

  it('keeps a genuine bad-credentials 401 on the generic path', () => {
    const error = handleQueryWorkbookDatasourceError(
      'Invalid authentication token.',
      401,
      '401002',
    );

    expect(error.message).toBe('Invalid authentication token.');
    expect(error.internalError).toBe('Invalid authorization credentials');
  });

  it('reports a cross-workbook datasource id as not found, not as access denied', () => {
    // Measured: this comes back as 500, which a caller would otherwise read as a server fault.
    const error = handleQueryWorkbookDatasourceError(
      'Cannot find datasource sqlproxy.0abcdef1234567890abcdef12',
      500,
      undefined,
    );

    expect(error.message).toBe(DATASOURCE_NOT_IN_SESSION_MESSAGE);
    expect(error.statusCode).toBe(404);
    expect(error.internalStatusCode).toBe(500);
  });

  it('names a dropped session header as such', () => {
    const missingSessionId = handleQueryWorkbookDatasourceError(
      'VizQL Session ID is required when using workbook datasource.',
      400,
      '400803',
    );
    const missingGlobalHeader = handleQueryWorkbookDatasourceError(
      'Global Session Header is required for online when using workbook datasource.',
      400,
      '400803',
    );

    expect(missingSessionId.message).toBe(MISSING_SESSION_HEADERS_MESSAGE);
    expect(missingGlobalHeader.message).toBe(MISSING_SESSION_HEADERS_MESSAGE);
    expect(missingSessionId.internalStatusCode).toBe(400803);
  });

  it('leaves other 400803 validation failures to the generic VDS error table', () => {
    // 400803 is the generic "validation failed" code, so the code alone must not be read as a
    // missing header — an unknown field lands here too.
    const error = handleQueryWorkbookDatasourceError('Unknown Field: Foobar.', 400, '400803');

    expect(error.message).toBe('Unknown Field: Foobar.');
    expect(error.internalError).toBe('Validation failed');
    expect(error.type).toBe('tableau-error');
  });

  it('falls back to the generic table for unrelated errors', () => {
    const error = handleQueryWorkbookDatasourceError('Too many requests', 429, '429000');

    expect(error.message).toBe('Too many requests');
    expect(error.internalError).toBe('Too many requests');
  });
});
