# viz のセッションでワークブックのデータソースを引く (query-workbook-datasource)

日付: 20260804
ブランチ: claude/tableau-vds-embedding-id

## 背景

20260802 の viz スナップショットで `datasources[].id` を payload に載せたが、その id が
何者かは当時**未確認**だった。誘導文は「id が LUID でないかもしれないので、
解決しなければ name で list-datasources から引き直せ」という保険付きだった。

実機検証([verification/vds-embedding-id/FINDINGS.md](../verification/vds-embedding-id/FINDINGS.md))
でその保険が外れた。確定した事実は3つ。

1. `DataSource.id` は LUID ではない。published データソース参照では `sqlproxy.*`、
   ワークブック埋め込みでは `federated.*`。VDS の `datasourceLuid` に渡すと
   `400803 Invalid characters in the data source LUID` で拒否される
2. その id は VDS の `workbookDatasourceId` として使える。ただし Embedding API 3.16+ の
   `viz.getVizQLDataServiceSessionInfo()` が返すセッション2値を
   `X-Session-Id` / `Global-Session-Header` で添える必要がある(3ヘッダとも必須)
3. **埋め込みデータソースには LUID が存在しない**。name 解決も LUID 解決も原理的に
   到達できず、この経路が唯一の手段

つまり従来の name フォールバックは、published なら遠回り、埋め込みなら不可能だった。
本 PR はその穴を埋める。

## 変更内容

### iframe 側 (`src/web/apps/src/embed/vizState/`)

- `embeddingApiTypes.ts`: `TableauDataSource.isPublished` と
  `TableauVizElement.getVizQLDataServiceSessionInfo()` を型として追加。
  返り値は「値または Promise」で宣言した — 検証ハーネスが await していたため
  同期/非同期の別が確定していない
- `captureVizState.ts`: datasource ref に `isPublished` を追加(API が答えたときだけ。
  無回答を false と偽らない)。datasources を採れたときだけセッションを読み、
  `payload.vds = { sessionId, globalSessionHeader }` として載せる。
  メソッド不在・呼び出し失敗・片側だけの返り値は degrade し、機能全体は壊さない
- `payload.ts`: `VdsSessionRef` 型、`MAX_SESSION_VALUE_LENGTH=512`、
  `VDS_SESSION_CAVEAT`。予算トリムのはしごでは `vds` を `datasources` と同格に
  identity rung まで残す
- `pushVizState.ts`: preamble を新ツール前提に書き換え。`datasources[].id` は LUID では
  ないこと、3値をまとめて `query-workbook-datasource` に渡すこと、クエリ結果は
  画面のフィルタ状態を反映しないことを明記

### サーバー側 SDK (`src/sdks/tableau/`)

- `apis/vizqlDataServiceApi.ts`: `workbookDatasourceSchema` を新設。
  read-metadata / query-datasource のリクエストスキーマの `datasource` を
  `datasourceLuid` 版との union に広げた
- `methods/vizqlDataServiceMethods.ts`: `VizqlSessionHeaders` 型と、
  `queryWorkbookDatasource` / `readWorkbookDatasourceMetadata` を追加。
  既存メソッドのシグネチャは変更していない

### 新ツール (`src/tools/web/queryWorkbookDatasource/`)

`query-workbook-datasource`。`workbookDatasourceId` + セッション2値 + 省略可能な `query`。
`query` 省略時は read-metadata の結果(フィールド一覧)を返す。
`toolName.ts` / `tools.ts` / `scopes.ts` に登録。web 系のみ(`src/tools/web/tools.ts` 経由)。

### ログ

`logging/secretMask.ts` に `X-Session-Id` のマスクを追加。ツール側では
`logAndExecute` に渡す args のセッション2値を `<redacted>` に差し替える。

## 設計判断

### ルートB(LUID 解決)をツール化しない

検証では Metadata API のリネージ
(`Sheet.parentEmbeddedDatasources.upstreamDatasources`)で LUID を構造的に解決できることも
確認した。それでも実装しなかった理由:

- published データソースなら、既存の `search-content` / `list-datasources` +
  `query-datasource` で**モデルが今日すでに到達できる**。新しい配管の価値が薄い
- 埋め込みデータソース(LUID が存在しない)には効かない。ルートAが埋める穴を
  ルートBは埋められない
- Metadata API のリネージ解決はワークブック単位の edge が過大/過小になる実測があり
  (`Workbook.upstreamDatasources` が 15 件に対しシート経由 14 件など)、
  正しく実装するとシート単位の照合と `logicalTableId` 突合を抱え込む。
  得られるものに対して保守コストが高い

published か埋め込みかは `isPublished` として payload に載せてあるので、
モデルは「LUID 経路に戻れるか」を自分で判断できる。

### セッション値をモデルコンテキストに載せる

デプロイは `DISABLE_SESSION_MANAGEMENT=true` のステートレス構成で、iframe とツール呼び出しの
間にサーバー側の状態を置く場所がない。値を運ぶ経路は「iframe → vizState push → モデルが
ツール引数として渡す」しかない。

サーバー側レジストリ(iframe がセッションを預け、ツールが引く)は 20260802 の worklog と
同じ理由で不採用。ステートレスを崩し、セッションの寿命管理という新しい問題を作る。

セキュリティ面は実測で判断した(FINDINGS 節9)。セッションは ID 解決のハンドルであって
権限の昇格ではない — スコープ不足のトークンでは 403、別ワークブックの id は 500、
偽造セッションは 401。**認可は呼び出しトークン側で検査される**。それでも
`X-Session-Id` はログ・エラーメッセージに出さない実装にした。

未解決として残るのは cross-user の権限検査(下記「残課題」)。

### スキーマの持たせ方: union

VDS は未知プロパティを拒否するため `datasourceLuid` と `workbookDatasourceId` は
混在できない。かつ Zodios は同一 method+path のエンドポイント重複を禁止しているので、
`/query-datasource` に別 alias のエンドポイントを増やす手は使えない。
リクエストスキーマの `datasource` を union に広げる形にした。
`datasourceSchema` 自体と `Datasource` 型は据え置きなので、既存呼び出しは無変更。

### エラーは `isErrorFromAlias` を通さない

read-metadata エンドポイントは 404 のエラースキーマしか宣言していない。
この経路が実際に返す 401 / 500 は `isErrorFromAlias` を素通りして再 throw される。
新メソッドは `isAxiosError` で分岐し、**実際の HTTP ステータスを保持する**
(既存 `queryDatasource` は 400 に潰している)。呼び出し側が
401「セッション失効」と 500「この id はこのセッションのワークブックにない」を
区別する必要があるため。

### resourceAccessChecker を通さない

`isDatasourceAllowed` は published LUID 前提で、ワークブック内部 id には適用できない。
セッション無しで id を照合する手段がないので、チェックは行わずコード上に理由を残した。
`INCLUDE_DATASOURCE_IDS` / `EXCLUDE_DATASOURCE_IDS` に依存する運用は
このツールを除外する必要がある旨を tool description に明記した。

### 500 を「見つからない」として扱う

別ワークブックの id は 400/403 ではなく **500** で返る。認可失敗と読むと
モデルは「権限がない」と誤報告する。実測に基づき 404 相当のメッセージ
(「id とセッションは同じスナップショットから取れ」)に翻訳している。

### セッションはキャプチャごとに読み直す

寿命は 26.6 分の観測で打ち切っており上限が未測定。最初のキャプチャの値を
ページ寿命ぶん使い回すと、いつから stale なのか誰も知らない状態になる。
datasource refs と違ってキャッシュしない。

## 検証

事実の証跡は [verification/vds-embedding-id/FINDINGS.md](../verification/vds-embedding-id/FINDINGS.md)。
本 PR のモックは実測値(`sqlproxy.*` / `federated.*` 形式、実測エラーボディ)に基づく。

自動テスト:

- `npm test`: 2941 passed / 1 failed。失敗は `src/features/init.test.ts` の
  パス区切り(Windows で `\` になる)で、本 PR 適用前の HEAD でも同じく失敗する既存問題
- `npm run lint`: 本 PR が触ったファイルはすべてクリーン
  (残る指摘は git 管理外の `.work/` 配下ハーネスのみ、既存)
- `npm run build`: 成功

新規テスト:

- `queryWorkbookDatasource.test.ts` (13): LUID を渡したときの案内、query 省略時の
  フィールド一覧、セッションヘッダ付きの呼び出し、rowLimit のバージョン差、
  メタデータ検証、失効セッション/クロス ds のメッセージ翻訳、
  args にセッション値が載らないこと、allowlist が適用されないこと
- `queryWorkbookDatasourceErrorHandler.test.ts` (6): 実測エラーボディの翻訳と、
  400803 を一律「ヘッダ不足」と読まないこと
- `vizqlDataServiceApi.test.ts`: 両 id 形式の受理と union の挙動
- `captureVizState.test.ts` (+8): セッション捕捉、datasources が無いときは読まないこと、
  API 不在/失敗の degrade、片側だけの返り値の破棄、長さ上限、同期返却の受理
- `payload.test.ts` / `pushVizState.test.ts`: identity rung での `vds` 保持、preamble 文言

**実機での E2E は未実施**。ホスト経由でモデルが新ツールを正しく呼ぶかは未確認。

## 残課題

- **cross-user のコンテンツ権限検査**(最重要・未実施)。「スコープは持つが対象データソースの
  閲覧権限を持たない別ユーザー」がセッション値を使えてしまうかは未測定。
  多ユーザー環境で有効化する前に実測すること
- セッション寿命の上限と、失効時のエラーコード(26.6 分で観測打ち切り)
- 実機 E2E(iframe → push → モデルがツール呼び出し)の確認
- `getVizQLDataServiceSessionInfo()` が同期か非同期かの確定
- ビズのフィルタ状態を VDS クエリの `filters` に自動翻訳する経路。現状はモデル任せで、
  caveat で注意喚起しているだけ
