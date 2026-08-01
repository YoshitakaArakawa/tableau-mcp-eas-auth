import express from 'express';

import { getConfig } from '../../../config.js';
import { getSupportedScopes } from '../scopes.js';

/**
 * OAuth 2.0 Authorization Server Metadata
 *
 * Returns metadata about the authorization server including
 * available endpoints, supported flows, and capabilities.
 */
export function oauthAuthorizationServer(app: express.Application): void {
  app.get('/.well-known/oauth-authorization-server', async (_req, res) => {
    const config = getConfig();
    const { issuer, advertiseApiScopes, enforceScopes, clientIdSecretPairs } = config.oauth;

    const grant_types_supported = ['authorization_code', 'refresh_token'];
    const token_endpoint_auth_methods_supported = ['none'];

    if (clientIdSecretPairs) {
      grant_types_supported.push('client_credentials');
      token_endpoint_auth_methods_supported.push('client_secret_basic');
      token_endpoint_auth_methods_supported.push('client_secret_post');
    }

    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      registration_endpoint: `${issuer}/oauth2/register`,
      revocation_endpoint: `${issuer}/oauth2/revoke`,
      response_types_supported: ['code'],
      grant_types_supported,
      code_challenge_methods_supported: ['S256'],
      scopes_supported: enforceScopes
        ? await getSupportedScopes({ includeApiScopes: advertiseApiScopes })
        : [],
      token_endpoint_auth_methods_supported,
      subject_types_supported: ['public'],
      client_id_metadata_document_supported: true,
      // When this server also acts as a Tableau EAS, advertise where its JWT signing keys are
      // published — Tableau may look for the JWKS here instead of in the OpenID metadata document.
      ...(config.auth === 'eas'
        ? { jwks_uri: `${config.easIssuer}/.well-known/jwks.json` }
        : undefined),
    });
  });
}
