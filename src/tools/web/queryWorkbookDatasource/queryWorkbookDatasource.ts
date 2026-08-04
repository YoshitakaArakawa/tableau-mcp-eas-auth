import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Err, Ok, Result } from 'ts-results-es';
import { z } from 'zod';

import {
  ArgsValidationError,
  FeatureDisabledError,
  McpToolError,
  QueryValidationError,
  ZodiosValidationError,
} from '../../../errors/mcpToolError.js';
import { useRestApi } from '../../../restApiInstance.js';
import {
  MetadataResponse,
  Query,
  QueryOutput,
  querySchema,
  QueryWorkbookDatasourceRequest,
  WorkbookDatasource,
} from '../../../sdks/tableau/apis/vizqlDataServiceApi.js';
import VizqlDataServiceMethods, {
  VdsQueryError,
  VizqlSessionHeaders,
} from '../../../sdks/tableau/methods/vizqlDataServiceMethods.js';
import { ProductVersion } from '../../../sdks/tableau/types/serverInfo.js';
import { WebMcpServer } from '../../../server.web.js';
import { getExceptionMessage } from '../../../utils/getExceptionMessage.js';
import { getResultForTableauVersion } from '../../../utils/isTableauVersionAtLeast.js';
import {
  FieldsResult,
  simplifyReadMetadataResult,
} from '../getDatasourceMetadata/datasourceMetadataUtils.js';
import { getVizqlDataServiceDisabledError } from '../getVizqlDataServiceDisabledError.js';
import { validateFields } from '../queryDatasource/validators/validateFields.js';
import { validateFilters } from '../queryDatasource/validators/validateFilters.js';
import {
  QueryValidationError as FieldValidationError,
  validateFieldsAgainstDatasourceMetadata,
  validateParametersAgainstDatasourceMetadata,
} from '../queryDatasource/validators/validateQueryAgainstDatasourceMetadata.js';
import { ToolRules, WebTool } from '../tool.js';
import { queryWorkbookDatasourceToolDescription } from './description.js';
import { handleQueryWorkbookDatasourceError } from './queryWorkbookDatasourceErrorHandler.js';

const paramsSchema = {
  workbookDatasourceId: z.string().nonempty(),
  vizqlSessionId: z.string().nonempty(),
  globalSessionHeader: z.string().nonempty(),
  query: querySchema.optional(),
  limit: z.number().int().min(1).optional(),
};

/** A 36-character 8-4-4-4-12 GUID — a published datasource LUID, which this tool cannot use. */
const LUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LUID_SUPPLIED_MESSAGE =
  'workbookDatasourceId looks like a published datasource LUID. This tool addresses datasources by ' +
  'their workbook-internal id (sqlproxy.* or federated.*), which comes from a viz state snapshot. ' +
  'To query by LUID, use the query-datasource tool instead.';

export const METADATA_NEXT_STEP =
  'Call query-workbook-datasource again with the same workbookDatasourceId and session values, ' +
  'plus a query naming these fields.';

/** Returned when `query` is omitted: the field list the model needs before it can write a query. */
export type WorkbookDatasourceMetadataResult = {
  fields: FieldsResult;
  nextStep: string;
};

type QueryWorkbookDatasourceResult = QueryOutput | WorkbookDatasourceMetadataResult;

export const getQueryWorkbookDatasourceTool = (
  server: WebMcpServer,
  productVersion: ProductVersion,
): WebTool<typeof paramsSchema> => {
  const rules = getQueryWorkbookDatasourceRules(productVersion);
  const queryWorkbookDatasourceTool = new WebTool({
    server,
    name: 'query-workbook-datasource',
    description: queryWorkbookDatasourceToolDescription,
    paramsSchema,
    annotations: {
      title: 'Query Workbook Datasource',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    callback: async (
      { workbookDatasourceId, vizqlSessionId, globalSessionHeader, query, limit },
      extra,
    ): Promise<CallToolResult> => {
      const { getConfigWithOverrides } = extra;
      const session: VizqlSessionHeaders = { vizqlSessionId, globalSessionHeader };

      return await queryWorkbookDatasourceTool.logAndExecute<QueryWorkbookDatasourceResult>({
        extra,
        // The session values are replaced before they reach `logAndExecute`, which writes `args`
        // verbatim into a debug log line and an MCP notification. Neither goes through the outbound
        // header masking in logging/secretMask.ts, so redacting here is what keeps the session id
        // out of the logs.
        args: {
          workbookDatasourceId,
          vizqlSessionId: REDACTED,
          globalSessionHeader: REDACTED,
          query,
          limit,
        },
        callback: async () => {
          if (LUID_PATTERN.test(workbookDatasourceId)) {
            return new ArgsValidationError(LUID_SUPPLIED_MESSAGE).toErr();
          }

          if (query) {
            try {
              validateFields(query.fields);
              validateFilters(query.filters, rules);

              if (!querySchema.safeParse(query).success) {
                throw new Error('The query does not match the expected schema.');
              }
            } catch (error) {
              return new ArgsValidationError(getExceptionMessage(error)).toErr();
            }
          }

          const configWithOverrides = await getConfigWithOverrides();

          // resourceAccessChecker.isDatasourceAllowed is deliberately NOT called here: it resolves a
          // published datasource by LUID, and a workbook-internal id is not one, so there is nothing
          // for the allowlist to match. The tool description says so, since a deployment that relies
          // on INCLUDE_DATASOURCE_IDS / EXCLUDE_DATASOURCE_IDS has to exclude this tool to keep the
          // restriction meaningful.

          const datasource: WorkbookDatasource = { workbookDatasourceId };
          const maxResultLimit = configWithOverrides.getMaxResultLimit(
            queryWorkbookDatasourceTool.name,
          );
          const rowLimit = maxResultLimit
            ? Math.min(maxResultLimit, limit ?? Number.MAX_SAFE_INTEGER)
            : limit;

          return await useRestApi({
            ...extra,
            jwtScopes: queryWorkbookDatasourceTool.requiredApiScopes,
            callback: async (
              restApi,
            ): Promise<Result<QueryWorkbookDatasourceResult, McpToolError>> => {
              const vds = restApi.vizqlDataServiceMethods;

              if (!query) {
                return await readFields(vds, datasource, session);
              }

              if (!configWithOverrides.disableQueryDatasourceValidationRequests) {
                const metadataResult = await vds.readWorkbookDatasourceMetadata(
                  { datasource },
                  session,
                );

                // Unlike the LUID path, a failed metadata read is NOT shrugged off: on this path the
                // only ways it fails are an expired session or an id the session cannot resolve, and
                // both of those will fail the query too. Reporting it here gives the caller the
                // actionable message instead of a second, identical round trip.
                if (metadataResult.isErr()) {
                  return Err(toToolError(metadataResult.error));
                }

                const validationMessage = validateQueryAgainstMetadata(query, metadataResult.value);
                if (validationMessage !== undefined) {
                  return new QueryValidationError(validationMessage).toErr();
                }
              }

              const queryRequest: QueryWorkbookDatasourceRequest = {
                datasource,
                query,
                options: {
                  returnFormat: 'OBJECTS',
                  debug: true,
                  disaggregate: false,
                  ...(rules.dontSpecifyRowLimits ? {} : { rowLimit }),
                },
              };

              const result = await vds.queryWorkbookDatasource(queryRequest, session);
              if (result.isErr()) {
                return Err(toToolError(result.error));
              }

              if (rowLimit && result.value.data && result.value.data.length > rowLimit) {
                result.value.data.length = rowLimit;
              }

              return Ok(result.value);
            },
          });
        },
        constrainSuccessResult: (result) => ({ type: 'success', result }),
      });
    },
  });

  return queryWorkbookDatasourceTool;
};

const REDACTED = '<redacted>';

/** Reads the field list, which is what the model needs before it can name fields in a query. */
async function readFields(
  vds: VizqlDataServiceMethods,
  datasource: WorkbookDatasource,
  session: VizqlSessionHeaders,
): Promise<Result<WorkbookDatasourceMetadataResult, McpToolError>> {
  const metadataResult = await vds.readWorkbookDatasourceMetadata({ datasource }, session);

  if (metadataResult.isErr()) {
    return Err(toToolError(metadataResult.error));
  }

  return Ok({
    fields: simplifyReadMetadataResult(metadataResult.value),
    nextStep: METADATA_NEXT_STEP,
  });
}

/** Maps a VDS failure onto the tool error the model sees. */
function toToolError(error: VdsQueryError): McpToolError {
  if (error.type === 'feature-disabled') {
    return new FeatureDisabledError(getVizqlDataServiceDisabledError());
  }
  if (error.type === 'zodios-error') {
    return new ZodiosValidationError(error.error);
  }
  return handleQueryWorkbookDatasourceError(error.message, error.httpStatus, error.errorCode);
}

/**
 * Runs the shared field/parameter checks against metadata that was already fetched, and joins any
 * failures into one message. Returns `undefined` when the query is consistent with the datasource.
 */
function validateQueryAgainstMetadata(
  query: Query,
  metadata: MetadataResponse,
): string | undefined {
  if (!metadata.data) {
    return undefined;
  }

  const errors: FieldValidationError[] = [];
  validateFieldsAgainstDatasourceMetadata(query.fields, metadata, errors);

  if (query.parameters) {
    validateParametersAgainstDatasourceMetadata(query.parameters, metadata, errors);
  }

  return errors.length > 0 ? errors.map((error) => error.message).join('\n\n') : undefined;
}

function getQueryWorkbookDatasourceRules(productVersion: ProductVersion): ToolRules {
  return getResultForTableauVersion({
    productVersion,
    mappings: {
      '2026.1.0': {},
      default: {
        dontSpecifyRowLimits: true,
        restrictFunctionsAndCalculationsInFilters: true,
      },
    },
  });
}
