import { createPublicKey } from 'node:crypto';

import express from 'express';
import { exportJWK, JWK } from 'jose';

import { Config } from '../../config.js';

/**
 * Derives the public JWK of the EAS signing key from the configured PKCS8 private key.
 *
 * The `kid` must match the `kid` header of the JWTs signed by {@link getJwt} so Tableau can pick
 * the right key out of the JWKS.
 */
export async function getEasPublicJwk(config: Config): Promise<JWK> {
  const publicKey = createPublicKey(config.easPrivateKey);
  return {
    ...(await exportJWK(publicKey)),
    kid: config.easKeyId,
    use: 'sig',
    alg: 'RS256',
  };
}

/**
 * External Authorization Server (EAS) discovery endpoints.
 *
 * When `AUTH` is `eas`, this server signs Tableau JWTs with its own RSA key, so Tableau must be
 * able to fetch the matching public key. It does that by fetching the IdP metadata document from
 * the registered issuer URL and following its `jwks_uri` — both requests come from Tableau over
 * the public internet, so these routes are unauthenticated.
 */
export async function setupEasWellKnownRoutes(
  app: express.Application,
  config: Config,
): Promise<void> {
  // The signing key can't change while the process is running, so derive the JWK once at startup.
  // This also fails fast when the configured private key is unusable.
  const jwks = { keys: [await getEasPublicJwk(config)] };

  app.get('/.well-known/jwks.json', (_req, res) => {
    res.json(jwks);
  });

  const metadata = {
    issuer: config.easIssuer,
    jwks_uri: `${config.easIssuer}/.well-known/jwks.json`,
  };

  app.get('/.well-known/openid-configuration', (_req, res) => {
    res.json(metadata);
  });

  // Tableau nodes are not consistent about which metadata path they probe when discovering the
  // EAS JWKS — some fetch the OpenID configuration, others the OAuth authorization server
  // metadata. Serve the same minimal document on both paths, unless the embedded authorization
  // server is active, in which case it registers a full metadata document on this path itself.
  if (!config.oauth.enabled || !config.oauth.embeddedAuthzServer) {
    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.json(metadata);
    });
  }
}
