# Tableau Server で AUTH=eas を使う場合の読み替えガイド

作成: 20260801。Tableau Cloud(サンドボックス)での E2E 検証を完了した時点で、
同じことを Tableau Server でやる場合に何がどう変わるかを整理した作業ログ。
Cloud 実測の詳細は PR #1 の本文を参照。

**確度のラベル**: 本書は Cloud での実測 + Server 公式ドキュメントの読み取りで構成している。
Server 実機での検証は行っていないため、[要実測] の項目は導入時に必ず確認すること。

---

## 結論(先に要点)

- **本リポジトリのコード変更は不要という見込み**。`AUTH=eas` の実装は Tableau 側の登録方法に
  依存しない(サーバーは「issuer を名乗って RS256 署名し、JWKS を公開する」だけ)。
  読み替えが必要なのは env 設定と Tableau 側の登録手順のみ
- Cloud で最大の制約だった2点(JWKS の公開インターネット到達性、OAuth ログイン層の
  loopback 制約)は、**Server ではどちらも緩む方向**に変わる。オンプレならむしろ構成は簡単になる

---

## 読み替え1: EAS の登録方法

| | Tableau Cloud(実測済み) | Tableau Server |
|---|---|---|
| 登録単位 | サイト単位のみ | **サーバー単位(TSM)** + 2024.2 以降はサイト単位も可 |
| 登録手段 | サイト設定 → Connected Apps → OAuth 2.0 Trust(Name / Issuer URL / Enable) | TSM(下記コマンド)またはサイト設定 UI(2024.2+) |

サーバー単位登録の TSM コマンド(公式ドキュメント記載):

```
tsm configuration set -k vizportal.oauth.external_authorization.enabled -v true
tsm configuration set -k vizportal.oauth.external_authorization_server.issuer -v "<issuer_url>"
tsm restart
```

関連キー:

- `vizportal.oauth.external_authorization_server.max_expiration_period_in_minutes` —
  JWT 有効期限の上限を変更可能(Cloud は 10 分固定)。本実装の exp は iat+5 分なので既定でも収まる
- `vizportal.oauth.external_authorization_server.blocklisted_jws_algorithms` — 署名アルゴリズムの
  ブロックリスト。RS256 を使う本実装には通常影響しない
- JWKS URI を明示する TSM キーはドキュメントに記載なし [要確認]。Cloud 同様
  issuer メタデータ経由の発見が前提と読める

## 読み替え2: aud クレーム

- Cloud 実測: `tableau:<site_luid>` が必須(素の `"tableau"` はエラー 10084 で拒否)
- Server のドキュメント(クレーム表)は `"tableau"` と記載。ただし Cloud のドキュメントも
  同様の記載のまま実態が site LUID 形式だったので、**Server の実効値は実測でしか確定しない** [要実測]
- 推測: サーバー単位登録(サイトに紐付かない)なら `"tableau"`、サイト単位登録(2024.2+)なら
  `tableau:<site_luid>` の可能性が高い
- 本実装は `EAS_AUDIENCE` で切り替え可能にしてあるので、コード変更なしに両対応できる。
  導入時は `EAS_AUDIENCE=tableau` から試し、10084 が出たら site LUID 形式に切り替える

## 読み替え3: JWKS の到達性(Cloud より楽になる)

- Cloud: Tableau のデータセンターから fetch されるため、issuer は公開インターネット到達可能な
  HTTPS URL が必須。ローカル検証にトンネルやリモートデプロイが必要だった
- Server: fetch の主体は **Tableau Server 自身**。Server から MCP サーバーへネットワーク到達できれば
  よいので、**イントラネット内の URL で完結する**。公開露出は不要
- issuer の HTTPS 要件("Unique issuer URI, in HTTPS")はドキュメント上 Server でも同じ [要実測]。
  社内 CA 証明書の場合、Tableau Server が MCP サーバーの証明書を信頼できるかも確認が必要 [要実測]
- 実装済みの well-known 二重 serve(openid-configuration と oauth-authorization-server の両パス)は
  そのまま活きる。Cloud で観測した「ノードによる参照パスの揺れ」が Server にもあるかは不明だが、
  両方 serve しておいて損はない

## 読み替え4: OAuth ログイン層(Cloud で捨てた構成が Server では正攻法)

Cloud 検証では埋め込み認可サーバーモードがリモートデプロイで使えず
(redirect_uri が loopback 限定)、`OAUTH_ISSUER=https://sso.online.tableau.com` +
`OAUTH_EMBEDDED_AUTHZ_SERVER=false` に切り替えた。**Server ではこれが逆転する**:

- sso.online.tableau.com は Cloud 専用なので使えない
- 代わりに**埋め込み認可サーバーモードがリモートでも成立する**。Tableau Server には
  リモートホストの redirect を許可する TSM 設定が存在するため:

```
tsm configuration set -k oauth.allowed_redirect_uri_hosts -v <mcp-server-host>
tsm pending-changes apply
```

- 前提バージョン: Tableau Server 2025.3 以降(tableau-mcp の OAuth 対応要件)
- env の読み替え(Cloud 構成 → Server 構成):

```
SERVER=https://<tableau-server>
OAUTH_ISSUER=https://<mcp-server>            # MCP サーバー自身(埋め込み AS)
OAUTH_EMBEDDED_AUTHZ_SERVER=true             # 既定値なので省略可
OAUTH_REDIRECT_URI=https://<mcp-server>/Callback   # 既定 ${OAUTH_ISSUER}/Callback で可
OAUTH_JWE_PRIVATE_KEY_PATH=<path>            # 埋め込み AS モードでは必須
AUTH=eas
EAS_ISSUER=https://<mcp-server>
EAS_KEY_ID=<kid>
EAS_AUDIENCE=tableau                          # まずこれ。駄目なら tableau:<site_luid>
JWT_SUB_CLAIM={OAUTH_USERNAME}
```

- 副次効果: 埋め込み AS モードは DCR を実装しているため、**mcp-remote がそのまま使える**
  (Cloud で mcp-remote が使えなかったのは sso が DCR 非対応だったため)。クライアント選択肢が
  Cloud より広い

## 読み替え5: バージョン要件の整理

| 機能 | 必要バージョン |
|---|---|
| EAS(OAuth 2.0 Trust)自体 | 2023.3 以前から利用可(サーバー単位) |
| サイト単位の EAS 登録 UI | Server 2024.2 以降 |
| tableau-mcp の OAuth(埋め込み AS) | Server 2025.3 以降 |

EAS だけ使い OAuth ログイン層を使わない構成(例: `DANGEROUSLY_DISABLE_OAUTH=true` +
社内ゲートウェイで保護)なら 2025.3 未満でも成立する可能性があるが、未検証 [要実測]。

## 導入時の実測チェックリスト

1. TSM 登録後、EAS JWT で REST サインインが通るか(まず `aud=tableau`、駄目なら site LUID 形式)
2. Tableau Server が JWKS を fetch できているか(MCP サーバーのアクセスログで
   /.well-known/* への Server からのアクセスを確認)
3. jti 単回使用の強制が Server にもあるか(本実装は UUID 生成なのでどちらでも安全)
4. exp 上限の既定値(`max_expiration_period_in_minutes` の初期値)
5. 埋め込み viz(Embedding API v3)が EAS JWT を受けるか
6. `oauth.allowed_redirect_uri_hosts` 設定後、OAuth ログイン → per-user EAS 署名の一連が通るか

## 出典

- https://help.tableau.com/current/server/en-us/connected_apps_eas.htm (Server 版 EAS。TSM キー・クレーム表)
- https://help.tableau.com/current/server/en-us/cli_configuration-set_tsm.htm (TSM 設定)
- リポジトリ内 docs/docs/configuration/mcp-config/oauth.md (oauth.allowed_redirect_uri_hosts、Server 2025.3 要件)
- Cloud 側の実測結果: 本リポジトリ PR #1 本文
