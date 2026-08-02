# サイト切替実験で実測確定した事実

日付: 20260802
ブランチ: claude/site-switching-experiment(ワークツリー)
対象: MCP クライアントの OAuth 挙動(項1〜3)と Tableau Cloud の認可エンドポイント挙動(項4)

自動テスト(`npm test` / `npm run test:oauth:embedded`)はクライアントと Tableau をモックで
代替している。ここに書くのは、そのモックが置き換えている「本物」の実測結果である。

---

## 項1: Claude Code は 403 insufficient_scope で step-up 再認可を起動しない

クライアント: Claude Code CLI 2.1.29(Windows)。計測装置は自作のモック AS/RS
(単一 Node スクリプト。認可エンドポイントは自動承認、全リクエストを JSONL 記録)。

ツール呼び出しに対し HTTP 403 と次のヘッダを返した:

```
WWW-Authenticate: Bearer realm="mock", error="insufficient_scope",
  error_description="site b requires reauthorization",
  scope="mcp:tools tableau:site:b", resource_metadata="<PRM URL>"
```

観測された挙動:

1. PRM と AS メタデータを再取得
2. **同一トークンのまま**再接続(initialize)し、同じ tools/call を1回だけ再試行 → 再び 403
3. 打ち切り。`/authorize` にも `/token` にも一切アクセスなし。ブラウザ起動なし

チャレンジの `scope` パラメータは完全に無視された。anthropics/claude-code#44652
(closed as not planned)の報告と一致。**MCP 仕様 (SEP-835/2350) の step-up
authorization を切替トリガーの主線にはできない。**

## 項2: Claude Code は 401 invalid_token でサイレントリフレッシュし、元の呼び出しを自動再試行する

同じ計測装置で、ツール呼び出しに対し HTTP 401 と
`WWW-Authenticate: Bearer realm="mock", error="invalid_token", ...` を返し、
当該アクセストークンを失効扱いにした。

観測された挙動:

1. 即座に `POST /token grant_type=refresh_token` を実行(ブラウザなし・ユーザー操作なし)
2. 新トークンで**元の tools/call を自動再試行**
3. モックが毎回失効させる設計にしたところ、リフレッシュ→再試行を3サイクルで打ち切り
4. リフレッシュトークンのローテーション(毎回新 refresh_token)にも正しく追随

**この経路が本機能(switch-site → 401 → 無音で新サイトのトークンに入れ替え)の成立根拠。**
切替あたり 401 は1回しか発生しない設計のため、サイクル上限には触れない。

## 項3: Claude Code のスコープ要求挙動

- authorize 時: PRM の `scopes_supported` に列挙された**全スコープをそのまま要求**する。
  取捨選択しない。→ サイトスコープ(`tableau:site:<contentUrl>`)を `scopes_supported`
  に載せると初回認可で全サイト分を要求される。載せない設計にした根拠
- refresh 時: `scope` パラメータを**送らない**。→ リフレッシュ発行するトークンの
  サイトは認可サーバーの裁量で決められる。切替の成立根拠のもう半分

## 項4: Tableau Cloud は埋め込み認可サーバーモードの authorize を拒否する

環境: Tableau Cloud(開発者サンドボックスポッド)。ワークツリーのビルドを
`AUTH=oauth` + `OAUTH_EMBEDDED_AUTHZ_SERVER=true` でローカル起動し、
埋め込み AS が組み立てる Tableau authorize URL
(`<SERVER>/oauth2/v1/auth?...&client_type=tableau-mcp&target_site=...&redirected=true`)
を叩いた。

結果: **HTTP 400 `{"error": "invalid_request"}`**(vizportal、
`tableau_error_code: 0xE3C7443A`)。ブラウザからの実フローでも同じ JSON に着地する。

整合する事実: 本リポジトリの docs は埋め込み AS モードを Tableau Server
(2025.3+)のデプロイガイドでのみ案内し、Tableau Cloud ガイドは
`OAUTH_EMBEDDED_AUTHZ_SERVER=false`(Tableau 認可サーバーモード)のみを示す。

**帰結: サイト切替機能(埋め込み AS 専用)の実環境検証は Tableau Cloud では実施
できない。Tableau Server 2025.3+ かつ2サイト以上にアクセスできる環境が必要。**

未確認: Cloud 側のサイト設定(接続済みクライアント許可等)でこの拒否が変わる可能性は
検証していない。

---

## 未実測のまま残る仮定(実装はこの仮定の上に立っている)

| # | 仮定 | 検証方法(Tableau Server 環境で) |
| --- | --- | --- |
| 1 | 同一 Tableau リフレッシュトークンで別サイトの `site_namespace` を指定した交換が通る | `/oauth2/switchSite` 経由で切替を1回実行 |
| 2 | 1 が通らない場合、REST `POST /auth/switchSite` が OAuth 由来セッションで使える | SDK にエンドポイント追加のうえ実測 |
| 3 | アクセス権のないサイト指定時、Tableau がエラーを返す(or 別サイト着地を安全弁が検出) | 権限外サイトで切替を実行 |
| 4 | 現行 401 に `WWW-Authenticate` が無くてもサイレントリフレッシュが起動するか(本実装はヘッダを付けたので前提ではないが、upstream PR 1 の必須性判定に効く) | 項1の計測装置からヘッダだけ落として再計測 |

## 再現手順の要点

- 項1〜3: ツール3個(成功 / 403 / 401+失効)のモック AS/RS を Node 単体で立て、
  `claude mcp add --transport http <name> http://localhost:<port>/mcp` で登録、
  対話セッションで一度認可後、`claude -p "Call <tool> ..." --allowedTools ...` を
  ツールごとに実行してサーバー側の記録(JSONL)を読む。判定に効くのは
  /authorize と /token に来るリクエストの有無・順序・scope 生値
- 項4: ワークツリーで `npm run build` 後、`AUTH=oauth` 構成の `.env` を置いて
  `node build/index.js`。`/oauth2/register` → `/oauth2/authorize` を curl で叩き、
  302 の Location(Tableau URL)を認証なしで GET してステータスを見る
