import { KeyObject } from 'crypto';
import express from 'express';
import { z } from 'zod';
import { fromError } from 'zod-validation-error/v3';

import { getConfig } from '../../config.js';
import { log } from '../../logging/logger.js';
import { RestApi } from '../../sdks/tableau/restApi.js';
import { ExpiringMap } from '../../utils/expiringMap.js';
import { getSiteLuidFromAccessToken } from '../../utils/getSiteLuidFromAccessToken.js';
import { toSiteContentUrl, toSiteDisplayName } from '../../utils/siteName.js';
import { decryptEmbeddedAccessToken } from './accessTokenValidator.js';
import { mcpAccessTokenSchema } from './schemas.js';
import { exchangeRefreshToken, siteScopeFor } from './token.js';
import { RefreshTokenData } from './types.js';

const switchSiteSchema = z.object({
  token: z.string().min(1, 'token is required'),
  site: z.string(),
});

/**
 * Site Switch Endpoint
 *
 * Moves an existing grant to another Tableau site without a new authorization round trip. The site
 * is exchanged immediately — not reserved for the next refresh — so a site the user cannot reach
 * fails here, synchronously, instead of silently leaving the session on the old site.
 *
 * The grant is rewritten in place and the submitted access token is revoked by jti. The client's
 * next request therefore gets a 401, refreshes with the refresh token it already holds, and the
 * unchanged refresh handler mints a token for the new site because the grant now names it.
 *
 * Mounted only when OAUTH_SWITCHABLE_SITES is set: with no allowlist there is nothing to switch to,
 * and the route must not exist at all so the default deployment is byte-for-byte the old one.
 */
export function switchSite(
  app: express.Application,
  refreshTokens: Map<string, RefreshTokenData>,
  privateKey: KeyObject,
  refreshTokenIndex: Map<string, string>,
  revokedJtis: ExpiringMap<string, true>,
): void {
  const config = getConfig();

  app.post('/oauth2/switchSite', async (req, res) => {
    const result = switchSiteSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: fromError(result.error).toString(),
      });
      return;
    }

    const requestedSite = toSiteContentUrl(result.data.site);

    const decrypted = await decryptEmbeddedAccessToken({
      token: result.data.token,
      privateKey,
      revokedJtis,
      issuer: config.oauth.issuer,
    });

    if (decrypted.isErr()) {
      res.status(401).json({
        error: 'invalid_token',
        error_description: 'Invalid or expired access token',
      });
      return;
    }

    const parsedToken = mcpAccessTokenSchema.safeParse(decrypted.value.payload);
    if (!parsedToken.success) {
      res.status(401).json({
        error: 'invalid_token',
        error_description: 'The access token does not carry a Tableau session',
      });
      return;
    }

    // The allowlist is the authorization boundary. The tool checks it too, but only to give the
    // model a better message — a request that reaches here is re-checked against the server's own
    // configuration.
    if (!config.oauth.switchableSites.includes(requestedSite)) {
      res.status(403).json({
        error: 'invalid_site',
        error_description: `Site ${toSiteDisplayName(requestedSite)} is not one of the sites this server allows switching to.`,
      });
      return;
    }

    const { tableauAccessToken, tableauUserId } = parsedToken.data;
    const refreshTokenId = refreshTokenIndex.get(tableauAccessToken);
    const grant = refreshTokenId ? refreshTokens.get(refreshTokenId) : undefined;

    if (!refreshTokenId || !grant) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description:
          'No grant matches this access token. The server may have restarted, or the grant may have been revoked. Reconnect to Tableau MCP.',
      });
      return;
    }

    // Switching to the current site changes nothing, so nothing is exchanged and the submitted
    // token stays valid: a no-op must not cost the client a 401 and a refresh.
    if (grant.siteContentUrl === requestedSite) {
      res.status(200).json({
        site: toSiteDisplayName(requestedSite),
        siteLuid: getSiteLuidFromAccessToken(grant.tokens.accessToken),
        previousTokenRevoked: false,
      });
      return;
    }

    const tokensResult = await exchangeRefreshToken(
      grant.server,
      grant.tokens.refreshToken,
      grant.tableauClientId,
      requestedSite,
    );

    // Nothing is written on failure. The grant keeps its old tokens, which Tableau may have rotated
    // away during the failed exchange; that costs a reconnect, whereas a half-applied switch would
    // leave the session pointing at a site it has no tokens for.
    if (tokensResult.isErr()) {
      res.status(400).json({
        error: 'switch_failed',
        error_description: `Tableau refused to issue a session for site ${toSiteDisplayName(requestedSite)}.`,
      });
      return;
    }

    const tokens = {
      accessToken: tokensResult.value.accessToken,
      refreshToken: tokensResult.value.refreshToken,
      expiresInSeconds: tokensResult.value.expiresInSeconds,
    };

    // Tableau is the authority on which sites the user may reach. Asking the new session where it
    // landed is what turns the allowlist from an authorization claim into a verified fact, and it
    // also catches a server that quietly ignored site_namespace.
    const restApi = new RestApi({
      maxRequestTimeoutMs: config.maxRequestTimeoutMs,
    });

    restApi.setCredentials(tokens.accessToken, tableauUserId);
    const sessionResult = await restApi.authenticatedServerMethods.getCurrentServerSession();

    if (sessionResult.isErr()) {
      log({
        message: 'Failed to read the Tableau session after a site switch',
        level: 'error',
        logger: 'oauth',
        data: sessionResult.error,
      });
      res.status(400).json({
        error: 'switch_failed',
        error_description: `Unable to confirm the Tableau session for site ${toSiteDisplayName(requestedSite)}.`,
      });
      return;
    }

    const switchedSite = sessionResult.value.site.contentUrl ?? '';
    if (switchedSite !== requestedSite) {
      res.status(403).json({
        error: 'invalid_site',
        error_description: `Tableau put the session on site ${toSiteDisplayName(switchedSite)} instead of ${toSiteDisplayName(requestedSite)}. The user may not have access to that site.`,
      });
      return;
    }

    // Rewrite in place: the MCP refresh token ID is the value the client already holds, so it must
    // survive the switch. Only the Tableau tokens and the site the grant names change.
    refreshTokenIndex.delete(grant.tokens.accessToken);
    grant.tokens = tokens;
    grant.siteContentUrl = requestedSite;
    grant.siteScope = siteScopeFor(requestedSite);
    refreshTokenIndex.set(tokens.accessToken, refreshTokenId);

    // Revoking the submitted token is what triggers the client's silent refresh. A token issued
    // before the jti claim existed cannot be revoked individually, so the switch only takes hold
    // when that token expires — the response says so rather than pretending it was immediate.
    const { jti, exp } = parsedToken.data;
    if (jti) {
      const remainingMs = exp * 1000 - Date.now();
      revokedJtis.set(
        jti,
        true,
        Math.min(Math.max(remainingMs, 1), revokedJtis.defaultExpirationTimeMs),
      );
    }

    res.status(200).json({
      site: toSiteDisplayName(requestedSite),
      siteLuid: sessionResult.value.site.id,
      previousTokenRevoked: !!jti,
    });
  });
}
