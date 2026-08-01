# Tableau MCP — EAS auth mode fork

> **これは [tableau/tableau-mcp](https://github.com/tableau/tableau-mcp) の実験的フォークです。**
> 本家プロダクトの情報・Issue・サポートは upstream を参照してください。
> This is an experimental fork of tableau/tableau-mcp. For the official product, issues, and
> support, please refer to the upstream repository.

## このフォークがやりたいこと

tableau-mcp の MCP Apps 機能は、チャット UI 内の iframe に Tableau viz を埋め込み表示できる
(`render-interactive-viz`)。ただし埋め込み用 JWT の署名材料は upstream 4.0.6 時点で
Connected App / Direct Trust(サイト単位の共有 secret)と UAT(一般の Tableau Cloud サイトでは
使えない)しかない。

このフォークは第3の署名方式として **EAS(Connected App / OAuth 2.0 Trust = 外部認可サーバー)**
を実装する(`AUTH=eas`)。MCP サーバー自身を Tableau サイトに EAS として登録し、サーバーが保持する
RS256 鍵で REST サインイン用 JWT と embed JWT の両方を署名する。ユーザー体験は
「OAuth リダイレクトで Tableau にログインし、サイトを選ぶだけ」のまま、per-user の埋め込み viz を
成立させることがゴール。既存の OAuth ログイン層には一切手を入れていない。

### 主な変更

- `AUTH=eas` の追加: `EAS_ISSUER` / `EAS_PRIVATE_KEY(_PATH)` / `EAS_KEY_ID` / `EAS_AUDIENCE`
- JWKS / IdP メタデータの公開エンドポイント(`/.well-known/jwks.json` ほか)
- ドキュメント: `docs/docs/configuration/mcp-config/authentication/eas.md`

実装の背景・Tableau Cloud での実測知見(aud の実効値、well-known パスの揺れ、redirect_uri の
loopback 制約など)・デプロイ構成の注意は
[PR #1](https://github.com/YoshitakaArakawa/tableau-mcp-eas-auth/pull/1) にまとめてある。
Tableau Server への読み替えは [.work/notes/tableau-server-eas.md](.work/notes/tableau-server-eas.md) を参照。

以下は upstream のオリジナル README。

---

[![Tableau Supported](https://img.shields.io/badge/Support%20Level-Tableau%20Supported-53bd92.svg)](https://www.tableau.com/support-levels-it-and-developer-tools)

[![Build and Test](https://github.com/tableau/tableau-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tableau/tableau-mcp/actions/workflows/ci.yml)

[![npm](https://img.shields.io/npm/v/@tableau/mcp-server)](https://www.npmjs.com/package/@tableau/mcp-server)

## Overview

Tableau MCP is a suite of developer primitives, including tools, resources and prompts, that will
make it easier for developers to build AI applications that integrate with Tableau.

## Official Documentation

https://tableau.github.io/tableau-mcp/

## Getting Started

### Hosted Tableau MCP (Recommended for Tableau Cloud)

Tableau MCP is available as a managed service at **`https://mcp.tableau.com`**. It uses OAuth 2.1 so every user signs in with their own Tableau Cloud identity, and all existing per-user permissions are enforced automatically.

Point any MCP-compatible client at `https://mcp.tableau.com` and complete the OAuth sign-in flow when prompted.

See [Popular Client Integrations](https://tableau.github.io/tableau-mcp/docs/hosted-tableau-mcp/client-integrations) for step-by-step setup instructions for Slack, Claude, ChatGPT, and other common AI clients.

> **Tableau Server customers** and Cloud customers who require self-hosted infrastructure should see the [Enterprise Deployment](https://tableau.github.io/tableau-mcp/docs/enterprise) and [Self-Hosted Getting Started](https://tableau.github.io/tableau-mcp/docs/getting-started) guides.

### Self-Hosted / Local (npx)

The quickest way to run Tableau MCP locally. Requires [Node.js](https://nodejs.org/en/download) 22.7.5 or later — no cloning or building needed. Configure your AI tool (MCP client) with:

```json
{
  "mcpServers": {
    "tableau": {
      "command": "npx",
      "args": ["-y", "@tableau/mcp-server@latest"],
      "env": {
        "SERVER": "https://my-tableau-server.com",
        "SITE_NAME": "my_site",
        "PAT_NAME": "my_pat",
        "PAT_VALUE": "pat_value"
      }
    }
  }
}
```

For Docker, building from source, and other self-hosted options, see the [Getting Started guide](https://tableau.github.io/tableau-mcp/docs/getting-started).

## Deploy to Heroku

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://www.heroku.com/deploy?template=https://github.com/tableau/tableau-mcp)

## Example Prompts to Client

#### Prompt #1: Querying Data

```
For the Superstore Datasource, what are the top 5 states with the most sales in 2025?
```

#### Response

```
Based on the Superstore Datasource, here are the top 5 states with the most sales in 2025:
  1. California - $146,388.34
  2. New York - $93,922.99
  3. Washington - $65,539.90
  4. Texas - $43,421.76
  5. Pennsylvania - $42,688.31
California leads by a significant margin with over $146,000 in sales, followed by New York with nearly $94,000. These two states alone account for a substantial portion of the total sales across the top 5 states.
```

#### Prompt #2: Content Exploration

```
Find me the most viewed workbook within the last year.
```

#### Response

```
The most viewed workbook within the last year is:

Global Connections
- Owner: John Doe
- Project: Marketing
- Views in last year: 523
- Last Modified: September 2, 2025
- Workbook ID: 111fb672-9401-4913-a167-17b3d89a3e4f
```

#### Prompt #3: Getting a View

```
Show me the "Economy" view in the "Finances" project.
```

#### Response

![Economy View Image](docs/static/img/economy-view.png)
