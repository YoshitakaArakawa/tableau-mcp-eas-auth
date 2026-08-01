# EAS 認証(AUTH=eas) — 実測で確定した事実の記録

実施日: 20260801
対象: Tableau Cloud に対する EAS(External Authorization Server)JWT 認証の実機検証
環境: Tableau Cloud 開発者サンドボックス(10ax ポッド)

## この記録の位置づけ

EAS 実装(AUTH=eas)の設計判断は、公式ドキュメントに記載がない・またはドキュメント内で
矛盾している挙動の実測に依拠している。それらの事実をここに固定する。自動テストは
Tableau 側の挙動をモックで置き換えているため、以下の各項は自動テストでは検証できない。

## 確定した事実

### 1. EAS JWT の `aud` は `tableau:<site_luid>` が正

素の `"tableau"` はエラー 10084 で拒否される(REST サインインで実測)。
ヘルプの Troubleshoot 表(エラー 10084 の項)に残る `"tableau"` 記述は旧仕様であり、
同ページのクレーム表(`tableau:<site_luid>`)と文書内で矛盾している。クレーム表が正しい。
site LUID は Connected App 登録後の UI「Copy Site ID」で取得できる。

### 2. JWKS 発見は well-known 2 パスの両方を serve しないと不安定

Tableau Cloud は issuer URL から IdP メタデータを fetch して JWKS URI を辿るが、
参照パスは `/.well-known/openid-configuration` と `/.well-known/oauth-authorization-server` の
**両方をノードによって使い分ける**。片方だけ serve すると確率的に 401 になる
(実測時の成功率 ~1/6)。両パスに同一の最小メタデータ `{issuer, jwks_uri}` を serve する
ことで REST サインイン 8/8 安定(対応コミット 5dcb4dbe)。

UI 登録(Issuer URL のみ)で JWKS 発見は機能する。REST API の `jwksUri` 明示登録
(`POST .../connected-apps/external-authorization-servers`)は必須ではない。

### 3. issuer / JWKS は公開インターネット到達可能な HTTPS が必要

fetch の主体は Tableau Cloud のサーバー側。localhost での開発検証には HTTPS トンネル
(cloudflared 等)が必須で、issuer にはトンネル URL を登録する。URL が変わったら
Connected App の再登録(または Update EAS API での issuerUrl 更新)が要る。

### 4. Tableau Cloud の OAuth は redirect_uri に loopback しか受けない

`client_type=tableau-mcp` の認可リクエストで、redirect_uri に受理されるのは
`http://127.0.0.1:<port>` の loopback のみ。公開 HTTPS・`localhost` ホスト名・
tableau.com いずれも 400 invalid_request(実測)。リモートホスト許可は Tableau Server の
TSM 設定(`oauth.allowed_redirect_uri_hosts`)にしかなく、Cloud に該当機能はない。

→ tableau-mcp の埋め込み認可サーバーモード(OAUTH_EMBEDDED_AUTHZ_SERVER=true)は、
Cloud 相手ではローカル実行専用。リモートデプロイでは成立しない。

### 5. sso.online.tableau.com は DCR 非対応・CIMD のみ

Cloud の認可サーバーは Dynamic Client Registration を受けない。DCR 前提のクライアント
(実測時点の mcp-remote 0.1.38)は接続不可。CIMD(Client ID Metadata Document)で
接続するクライアント(claude.ai のカスタムコネクタ)は接続できる。

### 6. EAS 管理系 REST は Connected App JWT セッションでは 401

`external-authorization-servers` 系のエンドポイントは、Connected App JWT で得た
セッションでは 401 になる(UI 操作か上位権限が必要)。

### 7. クレームの細部

- `scp` はリスト型必須。欠落は 10099 で拒否(空にはできない)。REST サインインは
  メソッド別 scope(例 `["tableau:content:read"]`)、埋め込みは `["tableau:views:embed"]`
- `jti` は必須かつ単回使用(再利用は 10091 JTI_ALREADY_USED)→ トークンごとに UUID 生成
- `exp` は最大 10 分。`sub` は Tableau ユーザー名で大文字小文字を区別
- 同一の EAS JWT 方式で REST サインインと Embedding API v3 の viz 描画の両方が通る
  (scp を切り替えるだけで一本化できる)

## 再検証の手順(要点)

ハーネスはコミットしていない。再検証する場合の構成要素:

1. RS256・2048bit の鍵ペアを用意し、公開鍵を JWKS として serve する HTTPS エンドポイントを
   立てる(well-known 2 パス両方に `{issuer, jwks_uri}` を返すこと。本リポの AUTH=eas
   実装はこれを内蔵している)
2. Tableau Cloud の Settings → Connected Apps → OAuth 2.0 Trust で issuer URL を登録し、
   「Copy Site ID」で `aud` 用の site LUID を取得する
3. `iss` / `aud` / `sub` / `jti`(UUID) / `scp` / `exp` を載せた JWT を秘密鍵で署名し、
   REST `/auth/signin` の `<credentials jwt="...">` に渡す
4. 安定性の確認は同一構成でサインインを複数回実行する(片パス serve 時の間欠 401 は
   確率事象のため、1 回の成功では判定できない)

機微情報(サイト名・サイト LUID・ユーザー名・issuer URL・鍵)は環境変数で注入し、
生成物・コミット物に含めないこと。

## 参照

- https://help.tableau.com/current/online/en-us/connected_apps_eas.htm
- https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_connected_app.htm
- https://help.tableau.com/current/online/en-us/connected_apps_scopes.htm
