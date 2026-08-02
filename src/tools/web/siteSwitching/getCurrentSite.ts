import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Err, Ok } from 'ts-results-es';

import { getConfig } from '../../../config.js';
import { WebMcpServer } from '../../../server.web.js';
import invariant from '../../../utils/invariant.js';
import { toSiteDisplayName } from '../../../utils/siteName.js';
import { WebTool } from '../tool.js';
import { getUnsupportedAuthError, isSiteSwitchingDisabled } from './siteSwitching.js';

const paramsSchema = {};

type CurrentSite = {
  site: string;
  siteLuid: string;
};

/**
 * Reports the Tableau site the session is currently operating on.
 *
 * The value comes from the authenticated session rather than from configuration, so it already
 * reflects any switch that has taken effect.
 */
export const getGetCurrentSiteTool = (server: WebMcpServer): WebTool<typeof paramsSchema> => {
  const config = getConfig();

  const getCurrentSiteTool = new WebTool({
    server,
    name: 'get-current-site',
    description: `Returns the Tableau site this session is currently operating on.

The value reflects the live session, so calling this after \`switch-site\` confirms whether the switch has taken effect yet.

This tool requires no input.`,
    paramsSchema,
    annotations: {
      title: 'Get Current Site',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    disabled: isSiteSwitchingDisabled(config),
    callback: async (_args, extra): Promise<CallToolResult> => {
      return getCurrentSiteTool.logAndExecute<CurrentSite>({
        extra,
        args: {},
        callback: async () => {
          const { tableauAuthInfo } = extra;
          invariant(tableauAuthInfo, 'tableauAuthInfo must be set in OAuth mode');

          const unsupportedAuthError = getUnsupportedAuthError(tableauAuthInfo);
          if (unsupportedAuthError) {
            return new Err(unsupportedAuthError);
          }

          return Ok({
            site: toSiteDisplayName(tableauAuthInfo.siteName),
            siteLuid: tableauAuthInfo.siteId ?? '',
          });
        },
        constrainSuccessResult: (result) => ({ type: 'success', result }),
      });
    },
  });

  return getCurrentSiteTool;
};
