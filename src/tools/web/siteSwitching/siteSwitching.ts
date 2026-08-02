import { Config } from '../../../config.js';
import { McpToolError } from '../../../errors/mcpToolError.js';
import { TableauAuthInfo } from '../../../server/oauth/schemas.js';
import { toSiteDisplayName } from '../../../utils/siteName.js';

/**
 * Site switching rewrites an OAuth grant held by the embedded authorization server, so it exists
 * only when this server issues its own tokens and an administrator has named the sites it may
 * switch to. Without an allowlist the tools are not registered at all.
 */
export function isSiteSwitchingDisabled(config: Config): boolean {
  return (
    config.auth !== 'oauth' ||
    !config.oauth.embeddedAuthzServer ||
    config.oauth.switchableSites.length === 0
  );
}

/**
 * The configured sites, named the way a caller writes them (the Default site has no content URL).
 */
export function listSwitchableSites(config: Config): string[] {
  return config.oauth.switchableSites.map(toSiteDisplayName);
}

/**
 * Rejects any session that is not backed by a grant of this server's own authorization server.
 * Passthrough callers bring their own Tableau session, which this server cannot move and must not
 * describe as switchable.
 */
export function getUnsupportedAuthError(
  tableauAuthInfo: TableauAuthInfo | undefined,
): McpToolError | undefined {
  if (tableauAuthInfo?.type === 'X-Tableau-Auth') {
    return undefined;
  }

  return new McpToolError({
    type: 'not-supported',
    message:
      'Site switching is only available for sessions authenticated by this MCP server acting as its own OAuth authorization server.',
    statusCode: 400,
  });
}
