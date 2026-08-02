# get-embed-token: サーバー署名を Bearer パススルーより優先する

日付: 20260802
ブランチ: worktree-embed-token-server-signing

## 背景

ChatGPT のカスタムコネクタから viz 表示ツール(get-view / get-workbook)を呼ぶと、
App の iframe に Tableau のサインイン画面が表示された。EAS 構成では埋め込み viz は
サーバー署名の JWT で認証され、ユーザーにサインインを求めない設計のはずだった。

原因は `get-embed-token` の分岐順序。`tableauAuthInfo.type === 'Bearer'` のとき
ユーザーの OAuth アクセストークンを無条件でパススルーしており、`AUTH=eas` +
Tableau 認可サーバー構成では常にこの分岐に入るため、EAS 署名パスに到達しなかった。

そして ChatGPT が取得するアクセストークンには `tableau:mcp:*` しか載らず
`tableau:views:embed` を含まない(verification/chatgpt-connector/FINDINGS.md 項2)。
embed スコープのないトークンを `<tableau-viz token=...>` に渡した結果、Embedding API
がサインイン画面へフォールバックした。

## 変更

- `src/tools/web/getEmbedToken/getEmbedToken.ts`
  - 分岐順序を逆転。サーバーが署名素材を持つ(direct-trust / uat / eas)なら
    `tableau:views:embed` を載せた embed JWT をサーバー署名で返す
  - Bearer パススルーはサーバーが署名できない場合(oauth / pat)のフォールバックに降格
- `src/tools/web/getEmbedToken/getEmbedToken.test.ts`
  - 回帰テスト追加: `AUTH=eas` + Bearer authInfo のとき、パススルーせず EAS 署名 JWT
    (scp=[tableau:views:embed]、sub は Bearer の username)を返すこと

## 設計判断

- **Bearer トークンの scope を検査して embed スコープがあればパススルーする案は不採用**。
  サーバー署名 JWT は常に embed スコープを保証でき、分岐が単純。scope 文字列の解析は
  クライアント実装差(スコープ表記の揺れ)に依存するリスクがある。
- **oauth の Bearer パススルーは維持**。oauth モードはサーバーに署名素材がなく、
  パススルーが唯一の手段。upstream の挙動もそのまま。
- pat + Bearer(パススルー認証)の組み合わせも従来どおりパススルーで動く
  (pat は embed JWT を署名できないため resolver が Err を返し、フォールバックに落ちる)。

## 検証

- 単体テスト: `src/tools/web/getEmbedToken/` 18/18 通過。全体スイートの失敗1件
  (FeatureGate のパス解決)は main でも失敗する既存問題で、本変更と無関係
- 実機検証: デプロイ後、ChatGPT カスタムコネクタから get-view を実行し、
  サインイン画面なしで viz が描画されることを確認。あわせて App iframe の
  sandbox 属性(allow-popups なし=サインインボタンが silent fail する構造)も実測。
  詳細は verification/chatgpt-connector/FINDINGS.md の項5〜7

## フォローアップ

- fly 停止時のセッション消失(`Rejected request: no valid session ID`)への対応は別件
  (DISABLE_SESSION_MANAGEMENT の採否)
- ChatGPT はアクセストークン失効後に自動リフレッシュしない(FINDINGS 項7)。
  サーバー側で対処できる余地があるかは未調査
