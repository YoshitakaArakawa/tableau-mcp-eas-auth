import { isErrorFromAlias, Zodios, ZodiosError } from '@zodios/core';
import { Err, Ok, Result } from 'ts-results-es';

import { AxiosRequestConfig, isAxiosError } from '../../../utils/axios.js';
import {
  DatasourceModelResponse,
  GetDatasourceModelRequest,
  MetadataResponse,
  QueryOutput,
  QueryRequest,
  QueryWorkbookDatasourceRequest,
  ReadMetadataRequest,
  ReadWorkbookDatasourceMetadataRequest,
  vizqlDataServiceApis,
} from '../apis/vizqlDataServiceApi.js';
import { RestApiCredentials } from '../restApi.js';
import AuthenticatedMethods from './authenticatedMethods.js';

export type VdsQueryError =
  | { type: 'feature-disabled' }
  | { type: 'api-error'; message: string; httpStatus: number; errorCode: string | undefined }
  | { type: 'zodios-error'; error: ZodiosError };

/**
 * The VizQL session a `workbookDatasourceId` resolves inside of, as returned by the Embedding API's
 * `viz.getVizQLDataServiceSessionInfo()`.
 *
 * Measured behaviour (see verification/vds-embedding-id/FINDINGS.md): BOTH headers are required
 * alongside `X-Tableau-Auth`; dropping either one answers 400 `400803`. Authorization is still
 * enforced on the calling token — the session only resolves the id, it does not grant access.
 *
 * `vizqlSessionId` is the secret half and must never reach a log line, a notification or an error
 * message. `globalSessionHeader` is base64 node-affinity routing information, not a credential.
 */
export type VizqlSessionHeaders = {
  vizqlSessionId: string;
  globalSessionHeader: string;
};

/**
 * The VizQL Data Service (VDS) provides a programmatic way for you to access your published data outside of a Tableau visualization.
 *
 * @export
 * @class VizqlDataServiceMethods
 * @extends {AuthenticatedMethods<typeof vizqlDataServiceApis>}
 * @link https://help.tableau.com/current/api/vizql-data-service/en-us/index.html
 */
export default class VizqlDataServiceMethods extends AuthenticatedMethods<
  typeof vizqlDataServiceApis
> {
  constructor(baseUrl: string, creds: RestApiCredentials, axiosConfig: AxiosRequestConfig) {
    super(new Zodios(baseUrl, vizqlDataServiceApis, { axiosConfig }), creds);
  }

  /**
   * Queries a specific data source and returns the resulting data.
   *
   * Required scopes: `tableau:viz_data_service:read`
   *
   * @param {QueryRequest} queryRequest
   * @link https://help.tableau.com/current/api/vizql-data-service/en-us/reference/index.html#tag/HeadlessBI/operation/QueryDatasource
   */
  queryDatasource = async (
    queryRequest: QueryRequest,
  ): Promise<Result<QueryOutput, VdsQueryError>> => {
    try {
      return Ok(await this._apiClient.queryDatasource(queryRequest, { ...this.authHeader }));
    } catch (error) {
      if (isErrorFromAlias(this._apiClient.api, 'queryDatasource', error)) {
        if (error.response.status === 404) {
          return Err({ type: 'feature-disabled' });
        }
        return Err({
          type: 'api-error',
          message: error.response.data.message ?? 'Unknown Tableau error',
          httpStatus: 400,
          errorCode: error.response.data.errorCode,
        });
      }

      if (error instanceof ZodiosError) {
        return Err({ type: 'zodios-error', error });
      }

      throw error;
    }
  };

  /**
   * Requests metadata for a specific data source. The metadata provides information about the data fields, such as field names, data types, and descriptions.
   *
   * Required scopes: `tableau:viz_data_service:read`
   *
   * @param {ReadMetadataRequest} readMetadataRequest
   * @link https://help.tableau.com/current/api/vizql-data-service/en-us/reference/index.html#tag/HeadlessBI/operation/ReadMetadata
   */
  readMetadata = async (
    readMetadataRequest: ReadMetadataRequest,
  ): Promise<Result<MetadataResponse, 'feature-disabled'>> => {
    try {
      return Ok(await this._apiClient.readMetadata(readMetadataRequest, { ...this.authHeader }));
    } catch (error) {
      if (
        isErrorFromAlias(this._apiClient.api, 'readMetadata', error) &&
        error.response.status === 404
      ) {
        return Err('feature-disabled');
      }

      throw error;
    }
  };

  /**
   * Requests the data model for a specific data source, including logical tables and relationships.
   *
   * Required scopes: `tableau:viz_data_service:read`
   *
   * @param {GetDatasourceModelRequest} getDatasourceModelRequest
   * @link https://help.tableau.com/current/api/vizql-data-service/en-us/reference/index.html#tag/HeadlessBI/operation/GetDatasourceModel
   */
  getDatasourceModel = async (
    getDatasourceModelRequest: GetDatasourceModelRequest,
  ): Promise<Result<DatasourceModelResponse, 'feature-disabled'>> => {
    try {
      return Ok(
        await this._apiClient.getDatasourceModel(getDatasourceModelRequest, {
          ...this.authHeader,
        }),
      );
    } catch (error) {
      if (
        isErrorFromAlias(this._apiClient.api, 'getDatasourceModel', error) &&
        error.response.status === 404
      ) {
        return Err('feature-disabled');
      }

      throw error;
    }
  };

  /**
   * Queries a datasource named by its workbook-internal id, inside a live VizQL session.
   *
   * Reaches datasources a LUID cannot address at all — an embedded (non-published) datasource has no
   * LUID to look up. Results reflect the datasource, NOT the on-screen filter state of the viz the
   * session came from.
   *
   * Required scopes: `tableau:viz_data_service:read`
   */
  queryWorkbookDatasource = async (
    queryRequest: QueryWorkbookDatasourceRequest,
    session: VizqlSessionHeaders,
  ): Promise<Result<QueryOutput, VdsQueryError>> => {
    try {
      return Ok(
        await this._apiClient.queryDatasource(queryRequest, this.sessionRequestConfig(session)),
      );
    } catch (error) {
      return Err(this.toVdsQueryError(error));
    }
  };

  /**
   * Reads the field metadata of a datasource named by its workbook-internal id, inside a live VizQL
   * session. The field list this returns is what a subsequent `queryWorkbookDatasource` call can
   * name in its query.
   *
   * Required scopes: `tableau:viz_data_service:read`
   */
  readWorkbookDatasourceMetadata = async (
    readMetadataRequest: ReadWorkbookDatasourceMetadataRequest,
    session: VizqlSessionHeaders,
  ): Promise<Result<MetadataResponse, VdsQueryError>> => {
    try {
      return Ok(
        await this._apiClient.readMetadata(readMetadataRequest, this.sessionRequestConfig(session)),
      );
    } catch (error) {
      return Err(this.toVdsQueryError(error));
    }
  };

  /** Auth header plus the two session headers the workbook-datasource form of VDS requires. */
  private sessionRequestConfig(session: VizqlSessionHeaders): { headers: Record<string, string> } {
    return {
      headers: {
        ...this.authHeader.headers,
        'X-Session-Id': session.vizqlSessionId,
        'Global-Session-Header': session.globalSessionHeader,
      },
    };
  }

  /**
   * Normalizes a failed workbook-datasource call into a `VdsQueryError`.
   *
   * Deliberately does NOT go through `isErrorFromAlias`: the read-metadata endpoint declares only a
   * 404 error schema, so the 401 and 500 responses this path actually produces would fall through
   * and be rethrown. The real HTTP status is preserved (rather than flattened to 400) because the
   * caller distinguishes 401 "session expired" from 500 "id not in this session's workbook".
   */
  private toVdsQueryError(error: unknown): VdsQueryError {
    if (error instanceof ZodiosError) {
      return { type: 'zodios-error', error };
    }

    if (isAxiosError(error) && error.response) {
      if (error.response.status === 404) {
        return { type: 'feature-disabled' };
      }

      const data = error.response.data as { message?: string; errorCode?: string } | undefined;
      return {
        type: 'api-error',
        message: data?.message ?? 'Unknown Tableau error',
        httpStatus: error.response.status,
        errorCode: data?.errorCode,
      };
    }

    throw error;
  }
}
