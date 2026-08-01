# Tableau MCP — EAS auth mode fork

> **これは [tableau/tableau-mcp](https://github.com/tableau/tableau-mcp) の実験的フォークです。**
> 本家プロダクトの README・ドキュメント・Issue・サポートは upstream と
> [公式ドキュメント](https://tableau.github.io/tableau-mcp/) を参照してください。
> This is an experimental fork of tableau/tableau-mcp adding an `AUTH=eas` mode. For the official
> product, please refer to the upstream repository.

## 背景 — なぜ EAS モードが必要か

tableau-mcp の MCP Apps 機能は、チャット UI 内の iframe に Tableau viz を埋め込み表示できる
(`render-interactive-viz` / `get-embed-token`)。この埋め込みには Embedding API v3 用の JWT が
必要で、upstream 4.0.6 時点でサーバーが署名に使える材料は次の2つしかない:

- **direct-trust**(Connected App / Direct Trust): サイト単位の共有 secret(HS256)。動作するが、
  site-wide の secret をサーバーに置く運用になる
- **uat**(User Access Token): Tableau 内部向けの仕組みで、一般の Tableau Cloud サイトでは使えない

一方でログイン体験としては「OAuth リダイレクトで Tableau にログインし、サイトを選ぶだけ」を
維持したい。ユーザーに PAT や Connected App を意識させたくない。

そこで第3の署名方式として **EAS(Connected App / OAuth 2.0 Trust = 外部認可サーバー)** を実装した。
MCP サーバー自身を Tableau サイトに EAS として登録し、サーバーが保持する RS256 鍵で
REST サインイン用 JWT と embed JWT の両方を署名する。EAS はサーバー内部への「署名器」の追加であり、
既存の OAuth ログイン層(`src/server/oauth/`)には一切手を入れていない。

## 変更内容

- `AUTH=eas` の追加。環境変数は `EAS_ISSUER` / `EAS_PRIVATE_KEY`(または `_PATH`)/ `EAS_KEY_ID` /
  `EAS_AUDIENCE`。設定の詳細は [docs/.../authentication/eas.md](docs/docs/configuration/mcp-config/authentication/eas.md)
- JWKS / IdP メタデータの公開エンドポイント(新規モジュール `src/server/eas/wellKnown.ts`):
  `/.well-known/jwks.json` に公開鍵、`/.well-known/openid-configuration` と
  `/.well-known/oauth-authorization-server` の**両方**に `{issuer, jwks_uri}` を serve する
  (理由は下記の実測知見)
- 署名分岐(`getJwt` / `authConfig` / REST サインイン / embed トークン解決)への eas ケース追加

## Tableau Cloud で実測して確定した仕様

公式ドキュメントに無い・矛盾している挙動。2026年8月時点、Tableau Cloud サンドボックスでの実測:

1. **`aud` クレームは `tableau:<site_luid>` が正**。ヘルプの一部に残る素の `"tableau"` は
   エラー 10084 で拒否される(旧仕様)。site LUID は Connected App 登録後の「Copy Site ID」で
   取得できる
2. **Tableau は EAS の JWKS 発見時、issuer の `/.well-known/openid-configuration` と
   `/.well-known/oauth-authorization-server` をノードによって使い分ける**。片方だけ serve すると
   サインインが確率的に失敗する(実測で成功率 ~1/6 まで低下)。両パスに同一メタデータを
   serve することで安定する
3. `jti` は**単回使用**として強制される(エラー 10091)。トークンごとに UUID を生成する必要がある
4. UI 登録(Name / Issuer URL / Enable のみ)だけで JWKS 発見は機能する。`jwksUri` の明示指定は
   REST API(Register EAS)でのみ可能だが、必須ではなかった
5. REST サインインも Embedding API v3 も EAS 署名 JWT を受理する(embed は scp
   `["tableau:views:embed"]`)

## デプロイ構成の注意(Tableau Cloud)

- **issuer は Tableau Cloud から到達可能な公開 HTTPS URL であること**。Tableau 側がメタデータと
  JWKS を能動的に fetch しに来るため localhost 不可。ローカル検証には HTTPS トンネルか
  リモートデプロイが必要
- **埋め込み認可サーバーモード(`OAUTH_EMBEDDED_AUTHZ_SERVER=true`)は Cloud のリモートデプロイでは
  使えない**。Tableau Cloud の OAuth エンドポイント(client_type=tableau-mcp)は認可コードの
  返し先(redirect_uri)を `http://127.0.0.1:<port>` の loopback に限定しており(公開 HTTPS は
  400)、この許可リストを広げる設定は Tableau Server の TSM にしか存在しない。Cloud では
  `OAUTH_ISSUER=https://sso.online.tableau.com` + `OAUTH_EMBEDDED_AUTHZ_SERVER=false` を使う
- **sso.online.tableau.com は動的クライアント登録(DCR)非対応・CIMD のみ対応**。DCR 前提の
  mcp-remote(0.1.38 時点)では接続できない。CIMD 対応の MCP クライアント
  (claude.ai のカスタムコネクタ等)を使う
- サーバーの配置リージョンは Tableau ポッドの近傍を推奨(JWKS fetch のレイテンシ対策)

## 既知の制約(サーバー外)

Claude Desktop / claude.ai の MCP Apps サンドボックスは UI リソースの `csp.frameDomains` 宣言を
無視して `frame-src 'self'` を強制するため、Tableau viz のネスト iframe がブロックされ
「Authentication was unsuccessful」表示になる
([anthropics/claude-ai-mcp#40](https://github.com/anthropics/claude-ai-mcp/issues/40))。
サーバー側の実装・JWT は正常で、スタンドアロンの Embedding API v3 ページでは同じ JWT で viz が
描画されることを確認済み。frameDomains を尊重するホストでは動作する見込み。

## Tableau Server への読み替え

Server では EAS 登録が TSM(サーバー単位)になる、JWKS の公開露出が不要になる、
埋め込み認可サーバーモードが TSM 設定でリモートでも成立する、など複数の点が変わる。
[.work/notes/tableau-server-eas.md](.work/notes/tableau-server-eas.md) に整理してある(未実測)。

## 変更履歴

実装単位の diff とテスト計画は
[PR #1](https://github.com/YoshitakaArakawa/tableau-mcp-eas-auth/pull/1) を参照。

## License

Upstream に従い [Apache-2.0](LICENSE.txt)。
