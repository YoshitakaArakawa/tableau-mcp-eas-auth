# ChatGPT カスタムコネクタ接続 — 実測で確定した事実の記録

実施日: 20260802
対象: ChatGPT の開発者モード(カスタムコネクタ)から、リモート運用中の tableau-mcp
(`TRANSPORT=http` / `AUTH=eas` / `OAUTH_EMBEDDED_AUTHZ_SERVER=false`)への接続
環境: Tableau Cloud 開発者サンドボックス + 公開 HTTPS にデプロイした MCP サーバー

## この記録の位置づけ

ChatGPT がどのスコープを要求してアクセストークンを取得するかは、クライアント側の
実装依存であり、こちらのコードにも自動テストにも現れない。スコープ検査
([authMiddleware.ts](../../src/server/oauth/authMiddleware.ts))は自動テストでは
「要求されたスコープが揃っている前提」でしか検証されていないため、実クライアントとの
組み合わせはここでしか確定できない。

Tableau Cloud 側の OAuth 挙動(CIMD のみ・DCR 非対応など)は
[eas-auth/FINDINGS.md](../eas-auth/FINDINGS.md) を参照。

## 確定した事実

### 1. ChatGPT は CIMD で Tableau Cloud の認可サーバーと OAuth を完了できる

保護リソースメタデータ(`/.well-known/oauth-protected-resource`)から Tableau Cloud の
認可サーバーを発見し、CIMD(Client ID Metadata Document)で認可コードフローを完走する。
DCR は不要。Tableau Cloud が DCR 非対応であることは接続の障害にならない。

これは claude.ai のカスタムコネクタと同じ経路
([eas-auth/FINDINGS.md](../eas-auth/FINDINGS.md) の項5)。

### 2. ChatGPT が取得するトークンには `tableau:mcp:*` しか含まれない

実測されたサーバー側ログ(抜粋):

```
Insufficient scopes: missing [tableau:content:read, tableau:mcp_site_settings:read,
 tableau:viz_data_service:read, tableau:views:embed, tableau:views:download,
 tableau:insight_definitions_metrics:read, tableau:insight_metrics:read,
 tableau:metric_subscriptions:read, tableau:insights:read, tableau:insight_brief:create]
```

不足しているのは Tableau API スコープのみで、MCP スコープ(`tableau:mcp:*`)は
すべて揃っている。`WWW-Authenticate` の `scope` パラメータと保護リソースメタデータの
`scopes_supported` には両方の系統を広告しているにもかかわらず、API スコープ側は
付与されない。要求段階で落ちているのか認可サーバーが絞っているのかは**未確認**。

### 3. その結果、症状は「接続済みだがツール0件」になる

拒否されるのは `initialize` リクエストであり、`tools/list` まで到達しない。
`initialize` は「サポートする全スコープ」を要求する経路のため、判定が最も厳しい
([authMiddleware.ts](../../src/server/oauth/authMiddleware.ts) の
`getRequiredMcpScopesForRequest` / `getRequiredApiScopesForRequest`)。

ChatGPT の UI 上は接続成功・ツール一覧が空として表示されるため、サーバーが
403 を返していることは画面からは判別できない。切り分けにはサーバー側ログが要る。

### 4. `ADVERTISE_API_SCOPES=false` で解消する。機能は失われない

`AUTH=eas` では、Tableau REST 呼び出しに使う認証情報はツール定義由来のスコープで
署名した EAS JWT([restApiInstance.ts](../../src/restApiInstance.ts) の `buildAuthConfig`
呼び出し)。ユーザーの OAuth トークンに載る API スコープは、ミドルウェアのスコープ検査
でしか参照されていない。

したがって API スコープの広告・検査を止めても、ツールの実行能力は変わらない。
MCP スコープの検査は維持されるため、ツール単位の権限分離も残る。

`OAUTH_DISABLE_SCOPES=true` はスコープ検査そのものを無効化するため、同じ症状を
解消できるが権限分離まで失う。採用しない。

**実測で解消を確認した(20260802)**。`false` に変更して再デプロイした後、ChatGPT から
ツール一覧が取得できるようになった。変更が反映されたことは、保護リソースメタデータの
`scopes_supported` と未認証時の `WWW-Authenticate` の `scope` が、どちらも
`tableau:mcp:*` の7件だけになったことで確認している。

再デプロイ後、コネクタの再登録は不要だった。設定画面の「更新する」だけでツールが
現れる。既存のアクセストークンをそのまま使える(トークン側は元々 MCP スコープを
満たしており、変わったのはサーバー側の要求スコープだけ)。

## 再現手順の要点

1. `TRANSPORT=http` / `AUTH=eas` / `OAUTH_EMBEDDED_AUTHZ_SERVER=false` /
   `ADVERTISE_API_SCOPES=true` で MCP サーバーを公開 HTTPS にデプロイする
2. ChatGPT(Web)の設定 → プラグイン/コネクタ → 開発者モードを有効化
3. MCP エンドポイント URL を登録し、認証方式に OAuth を選んで Tableau にサインイン
4. 会話からツール一覧を要求すると 0 件になる。同時刻のサーバーログに
   `Insufficient scopes` が出ていることを確認する
5. `ADVERTISE_API_SCOPES=false` にして再デプロイし、コネクタ設定の「更新する」を押す。
   ツールが現れれば再現と解消の両方が取れている
