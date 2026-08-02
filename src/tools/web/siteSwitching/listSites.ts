import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Err, Ok } from 'ts-results-es';

import { getConfig } from '../../../config.js';
import { WebMcpServer } from '../../../server.web.js';
import { WebTool } from '../tool.js';
import {
  getUnsupportedAuthError,
  isSiteSwitchingDisabled,
  listSwitchableSites,
} from './siteSwitching.js';

const paramsSchema = {};

type SwitchableSites = {
  sites: string[];
  note: string;
};

const ACCESS_NOTE =
  'These are the sites the server administrator allows switching to, not the sites this user can necessarily reach. Access is verified against Tableau when switch-site is called.';

/**
 * Lists the sites `switch-site` accepts.
 *
 * The list is the configured allowlist verbatim. Tableau is not queried: a site the user cannot
 * reach is rejected at switch time, and probing every site here would cost a REST round trip per
 * site to produce an answer that can still be stale.
 */
export const getListSitesTool = (server: WebMcpServer): WebTool<typeof paramsSchema> => {
  const config = getConfig();

  const listSitesTool = new WebTool({
    server,
    name: 'list-sites',
    description: `Lists the Tableau sites that \`switch-site\` accepts.

The list is configured by the server administrator. It is not a list of sites the current user has access to — access is checked against Tableau when the switch is performed.

This tool requires no input.`,
    paramsSchema,
    annotations: {
      title: 'List Sites',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    disabled: isSiteSwitchingDisabled(config),
    callback: async (_args, extra): Promise<CallToolResult> => {
      return listSitesTool.logAndExecute<SwitchableSites>({
        extra,
        args: {},
        callback: async () => {
          const unsupportedAuthError = getUnsupportedAuthError(extra.tableauAuthInfo);
          if (unsupportedAuthError) {
            return new Err(unsupportedAuthError);
          }

          return Ok({
            sites: listSwitchableSites(extra.config),
            note: ACCESS_NOTE,
          });
        },
        constrainSuccessResult: (result) => ({ type: 'success', result }),
      });
    },
  });

  return listSitesTool;
};
