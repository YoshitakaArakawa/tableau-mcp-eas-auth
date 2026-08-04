import { McpToolError } from '../../../errors/mcpToolError.js';
import { parseNumber } from '../../../utils/parseNumber.js';
import { handleQueryDatasourceError } from '../queryDatasource/queryDatasourceErrorHandler.js';

/**
 * The failure modes measured against a live site for the session/workbook-datasource form of VDS,
 * rewritten as instructions the model can act on.
 *
 * The generic VDS error table (`handleQueryDatasourceError`) is still the fallback; it just cannot
 * explain these three, because the condition it names is right and the remedy is wrong. See
 * verification/vds-embedding-id/FINDINGS.md section 9.
 */
export const SESSION_EXPIRED_MESSAGE =
  'The VizQL session is no longer valid. Session values are captured from a rendered viz and do not ' +
  'survive forever. Ask the user to re-render the viz, then retry with the vizqlSessionId and ' +
  'globalSessionHeader from the fresh viz state snapshot.';

export const DATASOURCE_NOT_IN_SESSION_MESSAGE =
  'The VizQL session could not resolve this workbookDatasourceId. The id and the session must come ' +
  'from the SAME viz state snapshot: a session only resolves ids belonging to its own workbook. ' +
  'Re-read the snapshot and pass the id and session values together.';

export const MISSING_SESSION_HEADERS_MESSAGE =
  'Tableau rejected the request because the VizQL session headers were missing or incomplete. Both ' +
  'vizqlSessionId and globalSessionHeader are required for a workbook datasource query.';

/** Matches the `500 Cannot find datasource ...` body measured for a cross-workbook id. */
const CANNOT_FIND_DATASOURCE_PATTERN = /cannot find datasource/i;

/** Matches the `401002 Session is no longer valid` body measured for an expired/forged session. */
const SESSION_INVALID_PATTERN = /session is no longer valid/i;

/**
 * Matches the two 400803 bodies measured when a session header is dropped:
 * 'VizQL Session ID is required when using workbook datasource.' and
 * 'Global Session Header is required for online when using workbook datasource.'
 *
 * 400803 is the generic "validation failed" code — it also covers unknown fields — so the message,
 * not the code alone, decides.
 */
const SESSION_HEADER_REQUIRED_PATTERN = /(session id|session header) is required/i;

export function handleQueryWorkbookDatasourceError(
  errorMessage: string,
  errorStatusCode: number,
  errorTableauStatusCode: string | undefined,
): McpToolError {
  // 401 with this body is an expired or unknown session, not a bad auth token. A caller that reads
  // it as "credentials rejected" would retry forever with the same stale session values.
  if (errorStatusCode === 401 && SESSION_INVALID_PATTERN.test(errorMessage)) {
    return new McpToolError({
      type: 'vizql-session-expired',
      message: SESSION_EXPIRED_MESSAGE,
      statusCode: 401,
      internalStatusCode: 401,
      internalError: 'VizQL session expired',
    });
  }

  // Measured: a datasource id from a different workbook answers 500, NOT 403/404. It is a
  // not-found, not an authorization failure — the caller must not report it as "access denied".
  if (errorStatusCode === 500 && CANNOT_FIND_DATASOURCE_PATTERN.test(errorMessage)) {
    return new McpToolError({
      type: 'workbook-datasource-not-found',
      message: DATASOURCE_NOT_IN_SESSION_MESSAGE,
      statusCode: 404,
      internalStatusCode: 500,
      internalError: 'Datasource not found in this VizQL session',
    });
  }

  // A header was dropped between the tool and Tableau — the tool always sends both, so reaching
  // here is a bug on our side rather than a caller mistake.
  if (SESSION_HEADER_REQUIRED_PATTERN.test(errorMessage)) {
    return new McpToolError({
      type: 'vizql-session-headers-missing',
      message: MISSING_SESSION_HEADERS_MESSAGE,
      statusCode: 400,
      internalStatusCode: parseNumber(errorTableauStatusCode),
      internalError: 'Validation failed',
      internalErrorDetails: errorMessage,
    });
  }

  return handleQueryDatasourceError(
    'tableau-error',
    errorMessage,
    errorStatusCode,
    errorTableauStatusCode,
  );
}
