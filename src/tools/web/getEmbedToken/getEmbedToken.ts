import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ok } from 'ts-results-es';

import { EmbedTokenNotAvailableError } from '../../../errors/mcpToolError.js';
import { getFeatureGate } from '../../../features/init.js';
import { buildAuthConfig } from '../../../sdks/tableau/buildAuthConfig.js';
import { WebMcpServer } from '../../../server.web.js';
import { Provider } from '../../../utils/provider.js';
import { WebTool } from '../tool.js';
import { EMBED_SCOPE, resolveEmbedToken } from './resolveEmbedToken.js';

const paramsSchema = {};

/**
 * Returns an embed token (a Tableau-signed JWT) used to authenticate the embedded
 * Tableau viz in the MCP app UI. Resolves the token from whatever signing material
 * the current server configuration provides:
 *   - an embed JWT signed on the server (AUTH=direct-trust, AUTH=uat or AUTH=eas), or
 *   - a passed-through Tableau Bearer JWT (AUTH=oauth, Tableau authZ server).
 * Server signing wins when both are available: a server-signed JWT always carries the
 * embed scope, while the user's Bearer token may not (client-dependent).
 * When no material is available the tool reports not-available and the app skips
 * embedding. The token value is never exposed to the model.
 */
export const getEmbedTokenTool = (server: WebMcpServer): WebTool<typeof paramsSchema> => {
  const getEmbedTokenTool = new WebTool({
    server,
    name: 'get-embed-token',
    description: `Returns an embed token (a Tableau-signed JWT) used to authenticate the embedded Tableau viz in the app UI.

This tool resolves the embed token from the current session's signing material — a passed-through Tableau Bearer JWT, or an embed JWT signed on the server under direct-trust or uat. It requires no input and is only visible to the app, never the model. If no token is available for the current configuration, it reports that and the app falls back to a non-embedded view.`,
    paramsSchema,
    annotations: {
      title: 'Get Embed Token',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    meta: {
      ui: {
        visibility: ['app'], // Only visible to the app, not the model
      },
    },
    disabled: new Provider(async () => !(await getFeatureGate().isFeatureEnabled('mcp-apps'))),
    callback: async (_args, extra): Promise<CallToolResult> => {
      return getEmbedTokenTool.logAndExecute<{ token: string }>({
        extra,
        args: {},
        callback: async () => {
          const { config, tableauAuthInfo } = extra;

          // 1. Server signing first: when the server holds signing material (direct-trust,
          // uat, eas), sign an embed JWT that is guaranteed to carry tableau:views:embed.
          // The user's OAuth Bearer token is NOT guaranteed to carry that scope — real
          // clients (e.g. ChatGPT's connector) obtain tokens with MCP scopes only, and
          // passing such a token to the Embedding API surfaces a sign-in prompt instead
          // of the viz.
          const authConfig = buildAuthConfig({
            config,
            tableauAuthInfo,
            scopes: new Set([EMBED_SCOPE]),
          });

          if (authConfig) {
            const result = await resolveEmbedToken({ authConfig });
            if (result.isOk()) {
              return Ok({ token: result.value.token });
            }
          }

          // 2. Bearer pass-through: the only option when the server cannot sign
          // (oauth has no signing material; pat cannot sign embed JWTs).
          if (tableauAuthInfo?.type === 'Bearer') {
            return Ok({ token: tableauAuthInfo.raw });
          }

          // No embed token available for this configuration.
          return new EmbedTokenNotAvailableError().toErr();
        },
        constrainSuccessResult: (result) => ({ type: 'success', result }),
      });
    },
  });

  return getEmbedTokenTool;
};
