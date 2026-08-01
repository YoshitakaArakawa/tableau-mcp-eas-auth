---
sidebar_position: 6
---

# External Authorization Server

When `AUTH` is `eas`, the MCP server acts as the [External Authorization Server (EAS)][eas] of a
Tableau Connected App configured with OAuth 2.0 Trust. It signs a scoped JSON Web Token (JWT) with
its own RSA key and uses it to authenticate to the Tableau REST APIs and to mint embedding tokens.

Unlike [Direct Trust](./direct-trust.md), where Tableau validates the JWT with a shared secret, an
EAS JWT is validated with a public key that Tableau fetches from this server. The MCP server
therefore publishes two anonymous endpoints when `AUTH` is `eas`:

- `/.well-known/jwks.json` — the JSON Web Key Set containing the public key of the EAS signing key.
- `/.well-known/openid-configuration` — the IdP metadata document pointing Tableau at the JWKS URI.

The generated JWT will have the minimum set of scopes necessary to invoke the methods called by the
tool being executed.

For example, for the [`query-datasource`](../../../tools/data-qna/query-datasource.md) tool, since
it internally calls into VizQL Data Service, the JWT will only have the
`tableau:viz_data_service:read` scope.

## Prerequisites

- An RSA key pair (2048-bit minimum). The private key stays on the MCP server; the public key is
  served from the JWKS endpoint.
- The MCP server must be reachable from Tableau over the public internet with HTTPS, because Tableau
  fetches the metadata and JWKS documents itself. During local development, put the server behind an
  HTTPS tunnel and use the tunnel URL as the issuer.
- A Connected App registered on the Tableau site with OAuth 2.0 Trust:
  1. Go to **Settings** → **Connected Apps** → **New Connected App** → **OAuth 2.0 Trust**.
  2. Enter a **Name** and the **Issuer URL** — the public HTTPS URL of this MCP server, matching
     [`EAS_ISSUER`](#eas_issuer).
  3. Enable the connected app.
- The registration UI has no field for the JWKS URI. Tableau discovers it from the metadata document
  served at the issuer URL. To register the JWKS URI explicitly instead, use the [Register EAS REST
  API method][register-eas] and set its `jwksUri` parameter to `<EAS_ISSUER>/.well-known/jwks.json`.

## Environment Variables

### `EAS_ISSUER`

The issuer URL registered on the Tableau connected app.

- Must start with `https://` — Tableau requires the issuer to be an HTTPS URI and fetches the IdP
  metadata document from it.
- Used as the `iss` claim of the JWT, and as the base URL advertised in the metadata document.
- Example: `https://mcp.example.com`

<hr />

### `EAS_PRIVATE_KEY`

The RSA private key (PKCS8 PEM) used to sign the EAS JWTs.

- The corresponding public key is published at `<EAS_ISSUER>/.well-known/jwks.json`.
- It or `EAS_PRIVATE_KEY_PATH` must be provided, but not both.
- Example:

  ```
  -----BEGIN PRIVATE KEY-----\nMIIE...HZ3Q==\n-----END PRIVATE KEY-----
  ```

<hr />

### `EAS_PRIVATE_KEY_PATH`

The absolute path to the RSA private key (.pem) file used to sign the EAS JWTs.

- It or `EAS_PRIVATE_KEY` must be provided, but not both.

<hr />

### `EAS_KEY_ID`

The key identifier of the public key that Tableau uses to validate the signature of the EAS JWTs.

- Used as the `kid` header of the JWT and as the `kid` of the JWK published in the JWKS document.
- Example: `mcp-eas-key-1`

<hr />

### `EAS_AUDIENCE`

The audience the EAS JWTs are issued for.

- Used as the `aud` claim of the JWT.
- Defaults to `tableau`.
- Tableau documents the audience as `tableau:<site_luid>`, where the site LUID is available from
  **Copy Site ID** on the connected app. If sign-in fails with an audience-related error, set this
  variable to `tableau:<site_luid>`.

<hr />

### `JWT_SUB_CLAIM`

The Tableau username the JWT is issued for, used as the `sub` claim.

- Can either be a hard-coded username, or the OAuth username by setting it to `{OAUTH_USERNAME}`.
- Tableau usernames are case sensitive.

<hr />

### `JWT_ADDITIONAL_PAYLOAD`

A JSON string that includes any additional claims and user attributes to include on the JWT. It also
supports dynamically including the OAuth username.

Example:

```json
{
  "username": "{OAUTH_USERNAME}",
  "region": "West"
}
```

[eas]: https://help.tableau.com/current/online/en-us/connected_apps_eas.htm
[register-eas]:
  https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_connected_app.htm
