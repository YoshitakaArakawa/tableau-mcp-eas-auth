import { Err, Ok, Result } from 'ts-results-es';

import { AuthConfig } from '../../../sdks/tableau/authConfig.js';
import { getJwt } from '../../../utils/getJwt.js';

/** The Embedding API scope every embed JWT must carry. */
export const EMBED_SCOPE = 'tableau:views:embed';

/** The Pulse-specific Embedding API scope, additional to (never instead of) `EMBED_SCOPE`. */
export const PULSE_EMBED_SCOPE = 'tableau:insights:embed';

/** Scope set for an embedded viz (`<tableau-viz>`). */
export const VIZ_EMBED_SCOPES: ReadonlySet<string> = new Set([EMBED_SCOPE]);

/**
 * Scope set for an embedded Pulse metric (`<tableau-pulse>`).
 *
 * `tableau:views:embed` is required IN ADDITION to `tableau:insights:embed`, which no Tableau
 * documentation states. Measured against a Tableau Cloud developer sandbox (2026.2) with Embedding
 * API 3.16.0: with `tableau:insights:embed` alone the embed sign-in succeeds (200), but several
 * calls the Pulse element makes afterwards answer 401 and the element transitions to a
 * session-expired error instead of rendering. See verification/pulse-embed/FINDINGS.md.
 */
export const PULSE_EMBED_SCOPES: ReadonlySet<string> = new Set([EMBED_SCOPE, PULSE_EMBED_SCOPE]);

export type EmbedTokenError = 'embed-token-not-available';

/**
 * Resolves an embed token by signing with the provided AuthConfig:
 *   - direct-trust: sign an embed JWT via getJwt with connected-app config.
 *   - uat: sign an embed JWT from the UAT RS256 key via getJwt.
 *   - eas: sign an embed JWT from the EAS RS256 key via getJwt.
 *   - pat: return not-available (caller must handle Bearer pass-through
 *     or oauth scenarios before calling this resolver).
 *
 * Always signs with the requested embed scopes (`VIZ_EMBED_SCOPES` by default), overriding any
 * scopes in the AuthConfig (which are sign-in scopes, not embedding scopes).
 */
export async function resolveEmbedToken({
  authConfig,
  scopes = VIZ_EMBED_SCOPES,
}: {
  authConfig: AuthConfig;
  scopes?: ReadonlySet<string>;
}): Promise<Result<{ token: string }, EmbedTokenError>> {
  const embedScopes = new Set(scopes);

  switch (authConfig.type) {
    case 'direct-trust': {
      const token = await getJwt({
        username: authConfig.username,
        config: {
          type: 'connected-app',
          clientId: authConfig.clientId,
          secretId: authConfig.secretId,
          secretValue: authConfig.secretValue,
        },
        scopes: embedScopes,
        additionalPayload: authConfig.additionalPayload,
      });
      return Ok({ token });
    }

    case 'uat': {
      const token = await getJwt({
        username: authConfig.username,
        config: {
          type: 'uat',
          tenantId: authConfig.tenantId,
          issuer: authConfig.issuer,
          usernameClaimName: authConfig.usernameClaimName,
          privateKey: authConfig.privateKey,
          keyId: authConfig.keyId,
        },
        scopes: embedScopes,
        additionalPayload: authConfig.additionalPayload,
      });
      return Ok({ token });
    }

    case 'eas': {
      const token = await getJwt({
        username: authConfig.username,
        config: {
          type: 'eas',
          issuer: authConfig.issuer,
          audience: authConfig.audience,
          privateKey: authConfig.privateKey,
          keyId: authConfig.keyId,
        },
        scopes: embedScopes,
        additionalPayload: authConfig.additionalPayload,
      });
      return Ok({ token });
    }

    case 'pat':
      // PAT cannot sign embed tokens.
      return Err('embed-token-not-available');
  }
}
