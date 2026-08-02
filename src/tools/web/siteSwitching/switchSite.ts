import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Err, Ok } from 'ts-results-es';
import { z } from 'zod';

import { getConfig } from '../../../config.js';
import { McpToolError } from '../../../errors/mcpToolError.js';
import { WebMcpServer } from '../../../server.web.js';
import invariant from '../../../utils/invariant.js';
import { toSiteContentUrl, toSiteDisplayName } from '../../../utils/siteName.js';
import { WebTool } from '../tool.js';
import {
  getUnsupportedAuthError,
  isSiteSwitchingDisabled,
  listSwitchableSites,
} from './siteSwitching.js';

const paramsSchema = {
  site: z
    .string()
    .describe(
      'Content URL of the site to switch to, as returned by list-sites. Use "Default" for the Default site.',
    ),
};

/**
 * Switches the Tableau site this session operates on.
 *
 * The site is not part of the MCP session — it belongs to the OAuth grant — so the tool posts the
 * session's own access token to the embedded authorization server's `/oauth2/switchSite` endpoint,
 * which exchanges Tableau tokens for the new site and revokes the current access token. The client
 * then refreshes silently and the following request runs on the new site.
 */
export const getSwitchSiteTool = (server: WebMcpServer): WebTool<typeof paramsSchema> => {
  const config = getConfig();

  const switchSiteTool = new WebTool({
    server,
    name: 'switch-site',
    description: `Switches the Tableau site that this session operates on.

The switch takes effect from the **next** request onwards, not within the current one. The session's credentials are renewed automatically, so no reconnection or sign-in is required.

Only sites configured by the server administrator can be selected — call \`list-sites\` for the allowed values. Access to the selected site is verified against Tableau as part of the switch, so a site the user cannot reach fails with an error and nothing changes.

**When to use:**
- The user asks to work with content on a different Tableau site
- Content the user is asking about was not found on the current site and is expected on another one`,
    paramsSchema,
    annotations: {
      title: 'Switch Site',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    disabled: isSiteSwitchingDisabled(config),
    callback: async ({ site }, extra): Promise<CallToolResult> => {
      return switchSiteTool.logAndExecute<string>({
        extra,
        args: { site },
        callback: async () => {
          const { tableauAuthInfo, config: extraConfig, signal } = extra;
          invariant(tableauAuthInfo, 'tableauAuthInfo must be set in OAuth mode');

          const unsupportedAuthError = getUnsupportedAuthError(tableauAuthInfo);
          if (unsupportedAuthError) {
            return new Err(unsupportedAuthError);
          }

          const allowedSites = listSwitchableSites(extraConfig);
          const requestedSite = toSiteContentUrl(site);

          // Checked here purely so the model gets the allowed values back instead of an opaque
          // rejection. The authorization boundary is the same check on the server.
          if (!extraConfig.oauth.switchableSites.includes(requestedSite)) {
            return new Err(
              new McpToolError({
                type: 'invalid-site',
                message: `Site ${toSiteDisplayName(requestedSite)} cannot be switched to. Allowed sites: ${allowedSites.join(', ')}.`,
                statusCode: 400,
              }),
            );
          }

          if (tableauAuthInfo.siteName === requestedSite) {
            return Ok(`Already on site ${toSiteDisplayName(requestedSite)}. Nothing was changed.`);
          }

          const rawMcpToken = extra.authInfo?.token;
          invariant(rawMcpToken, 'authInfo.token must be set in OAuth mode');

          const response = await fetch(`${extraConfig.oauth.issuer}/oauth2/switchSite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: rawMcpToken, site: requestedSite }),
            signal,
          });

          if (!response.ok) {
            return new Err(
              new McpToolError({
                type: 'switch-site-failed',
                message: `${await getErrorDescription(response)} Allowed sites: ${allowedSites.join(', ')}.`,
                statusCode: response.status,
              }),
            );
          }

          const { previousTokenRevoked } = (await response.json()) as {
            previousTokenRevoked?: boolean;
          };

          const effect =
            previousTokenRevoked === false
              ? 'It takes effect once the current credentials are renewed; requests made before then still run on the previous site.'
              : 'It takes effect from the next request onwards. Credentials are renewed automatically, so no further action is required.';

          return Ok(`Switched to site ${toSiteDisplayName(requestedSite)}. ${effect}`);
        },
        constrainSuccessResult: (result) => ({ type: 'success', result }),
      });
    },
  });

  return switchSiteTool;
};

async function getErrorDescription(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_description?: string };
    if (body.error_description) {
      return body.error_description;
    }
  } catch {
    // Fall through to the status-only message below.
  }

  return `The authorization server rejected the site switch (HTTP ${response.status}).`;
}
