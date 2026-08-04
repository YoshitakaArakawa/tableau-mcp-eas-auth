# Embedding API × VizQL Data Service — データソースID解決の実機検証記録

実施日: 20260804
対象: Embedding API で表示中の viz が使うデータソースを VizQL Data Service (VDS) で
クエリする 2 経路の実機検証 — LUID 解決方式(呼称「ルートB」)と
セッション方式(Embedding API 3.16 の `getVizQLDataServiceSessionInfo()` +
`workbookDatasourceId`。呼称「ルートA」)
結果: **両経路とも成立**(ルートB: 解決チェーン 3 段すべて成立。
ルートA: サーバーサイドから成立、埋め込みデータソースにも到達)

## この記録の位置づけ

Embedding API の `DataSource.id`、Metadata API のリネージ、VDS の `datasourceLuid` は
それぞれ別の識別子空間で、公式ドキュメントには相互のマッピング仕様がない。
自動テストのモックではこの「実物どうしの突合が成立するか」は検証できないため、
実サイトで経路全体を通して仮定を潰した。その証跡。

公式ドキュメントはルートAを「ブラウザ内からセッションクッキー込みで呼ぶ」構成と
してのみ記述しており、サーバーサイドから自前トークンで呼べるかは書かれていない。
本記録の後半はその未記載領域を実測で確定させたもの。

## 検証環境

- Tableau Cloud 開発者サンドボックス
- 認証: EAS(外部認可サーバー)発行 JWT。REST サインイン → `X-Tableau-Auth` で
  Metadata API / VDS を呼び出し。埋め込みは scope `tableau:views:embed` の embed JWT
- Embedding API v3(`tableau.embedding.3.latest.min.js`、実施日時点の配信版 = 3.16+)
- 対象: コミュニティ配布のスターターダッシュボード(published 抽出データソース
  1 件を参照するワークシートを選定)。候補 163 ワークシートから
  「published データソースちょうど 1 件に紐づく」条件で自動選定
- ハーネスはローカル(git 管理外)。再現手順の要点は末尾

## 実機で確定した事実

### 1. Embedding API の `DataSource.id` は LUID ではない(直接証拠つき)

- published データソース参照時の実測値は **`sqlproxy.<26文字英数>` 形式**。
  調査時の仮説は `federated.*` だったが、published 参照では `sqlproxy.*` になる。
  接頭辞でフィルタする実装は両方を考慮する必要がある
- 実体は接続 ID。`getActiveTablesAsync()` の `connectionId` と同値で、
  `serverURI` は `localhost` を指す
- この id を VDS の `datasourceLuid` に渡すと
  **`400803 Invalid characters in the data source LUID`** で拒否される。
  「変換なしでは渡せない」ことの直接証拠
- `isPublished` は `true` を返した(2021.4+ で利用可)。`publishedUrl()` は
  **`undefined`** で、LUID 解決の近道にはならなかった

### 2. LUID はリネージ(グラフ構造)で解決でき、名前は不要

Metadata API で `Sheet.parentEmbeddedDatasources.upstreamDatasources { name luid }`
を辿ると、シートの背後の published データソース LUID が構造だけで確定する。

**ワークブック単位の edge は信用しないこと**(過小・過大の両方を実測):

| edge | 実測 | 意味 |
|---|---|---|
| `Workbook.embeddedDatasources` | 6 件 | ワークブックが持つ接続すべて(過大) |
| `Workbook.upstreamDatasources` | 1 件 | シート経由と一致した例。ただし別ワークブックでは 15 件に対しシート経由 14 件(過大)も観測 |
| `Sheet.parentEmbeddedDatasources.upstreamDatasources` | 1 件 | そのシートが実際に使うもの。**これを使う** |

付随して確定した Metadata API (Cloud) の挙動:
- introspection は無効(`INTROSPECTION_DISABLED`)
- `Sheet` は具象型。`... on Worksheet` は `Unknown type 'Worksheet'` で失敗する

### 3. 解決した LUID で VDS が通る

- `read-metadata`: 200(67 フィールド)
- `query-datasource`(集計 1 本): 200(9,133 行)
- API Access パーミッション起因の 403 は発生しなかった(対象データソースの
  既定パーミッションのまま)

スコープの実測(想定と食い違い):

| JWT の scp | read-metadata |
|---|---|
| `viz_data_service:read` + `content:read` | 200 |
| `viz_data_service:read` のみ | 200 |
| `content:read` のみ | **200**(公式が要求する VDS スコープ無しで通る) |
| `projects:read` のみ | 403 `403800 User does not have appropriate scopes` |

`tableau:viz_data_service:read` は実測上必須ではないが、スコープ検査自体は
生きている。**この緩さに依存せず、VDS スコープは明示的に付与する設計にする**
(将来の厳格化で壊れるのを避ける)。

### 4. 名前に依存しない照合キー: `logicalTableId`

Embedding 側 `getLogicalTablesAsync()` の論理テーブル `id` と、
VDS `read-metadata`(LUID 指定)が返す `logicalTableId` が一致した
(観測サンプル 4 件全一致。**公式にマッピング保証の記述はない**)。

シートの上流に published データソースが複数あり「Embedding 側のどの
`DataSource` がどの LUID か」の結合が要る場合、候補 LUID ごとに
read-metadata を 1 回ずつ投げて論理テーブル ID 集合の交差で突合できる。

### 5. `getVizQLDataServiceSessionInfo()`(ルートAの部品)は実在し値を返す

- viz 要素(`TableauViz`)上に存在する。workbook オブジェクト側には無い
- 返り値は `vizqlServerSessionId` と `globalSessionHeader`(base64。デコードすると
  VizQL ノードの内部エンドポイントを含む)

### 6. ルートA: サーバーサイドから、クッキー無しで成立する

ブラウザのセッションクッキー(`workgroup_session_id`)無しで、Node から
自前の `X-Tableau-Auth`(EAS JWT サインイン)+ セッションヘッダ 2 つ +
`{"datasource":{"workbookDatasourceId":"sqlproxy.…"}}` で VDS が通った。

- `read-metadata`: 200(67 フィールド)
- `query-datasource`: 200(9,133 行。**ルートBと行数完全一致** —
  同一データソースを別経路で引いている裏取り)

ヘッダ組み合わせの実測マトリクス(**3 ヘッダすべて必須**):

| ヘッダ構成 | 結果 |
|---|---|
| `X-Tableau-Auth` + `X-Session-Id` + `Global-Session-Header` | **200** |
| `X-Tableau-Auth` のみ | 400 `400803 VizQL Session ID is required when using workbook datasource.` |
| セッションヘッダのみ(認証無し) | 401 `401002 Invalid authentication token.` |
| `X-Tableau-Auth` + `X-Session-Id`(GSH 無し) | 400 `400803 Global Session Header is required for online when using workbook datasource.` |
| `X-Tableau-Auth` + GSH(`X-Session-Id` 無し) | 400(SID 必須と同メッセージ) |

エラーメッセージ自体が Cloud(`online`)での `Global-Session-Header` 必須を明言している。
リクエストスキーマ上、`workbookLuid` の併記は
`Additional property 'workbookLuid' is not allowed` で拒否される。

### 7. ルートA: セッションはページを閉じても生き続ける

「ビズと同寿命」という当初想定は**外れた**。埋め込みページを閉じた後、
60 秒間隔 25 回のプローブが**すべて 200**。最終観測は採取から
**1,593 秒(26.6 分)後も生存**。上限は観測窓が先に尽きたため未測定。
セッション値を会話ターンをまたいで保持する設計が成立する。

### 8. ルートA: LUID を持たない埋め込みデータソースにも到達できる

`upstreamDatasources` が 0 件(= published でなく LUID が存在しない)の
埋め込みデータソースで実測:

- `DataSource.id` は **`federated.*` 形式**、`isPublished: false`
  (published 参照の `sqlproxy.*` と接頭辞が異なる — 両形式の実在を確認)
- `read-metadata`: 200(31 フィールド)、`query-datasource`: 200(1,862 行)
- ヘッダ要件は published 版と完全に同一

**これがルートAの固有価値**。LUID が無い以上ルートBでは原理的に到達できない。

### 9. ルートA: セッションは呼び出しトークンの権限を超えない(単一ユーザー範囲の実測)

「セッション値を握れば caller の権限を超えられるか」を 3 つの独立した観点で測定。
すべて安全側だった。各テストの前後に baseline(200)を挟み、失効由来の 4xx との
取り違えを排除している。

| テスト | 構成 | 結果 | 判定 |
|---|---|---|---|
| スコープ剥奪 | 不足スコープのトークン + 有効セッション | 403 `403800` | 安全(セッションはスコープ検査をバイパスしない) |
| クロス ds | セッションA + 別ワークブックの ds id | 500 `Cannot find datasource …` | 安全(セッションは自ワークブックの id しか解決しない) |
| セッション偽造 | ランダム `X-Session-Id` | 401 `401002 Session is no longer valid` | 安全 |

- 認可は**呼び出しトークン側**で検査され、セッションは ID 解決のハンドルにすぎない、
  という構図を支持する結果
- `X-Session-Id` が実体の秘密。`Global-Session-Header` は VizQL ノードの
  `IP:port` を base64 化しただけのノードアフィニティ情報で、秘密ではない
- クロス ds は 400/403 でなく **500** で返る。「見つからない」と認可失敗を
  区別してハンドリングすること
- 実装ガード: セッション値はログ・エラーメッセージに出さない。クライアントから
  渡されたセッション値は、その iframe を開いているユーザーと同一主体の
  トークンでのみ使う(別主体のセッション値を受け入れる経路を作らない)

### 10. ルートA: ビズのフィルタ状態は反映されない

ライブのビズにフィルタを適用した状態で同一リクエストを再実行しても、
返る行数は不変(1,862 行のまま)。セッションは内部 ID を解決するための
ハンドルであって、**画面状態のコンテキストではない**。
「今ユーザーが見ているものへの問い合わせ」を実現するには、フィルタ・
パラメータを Embedding API 側から採取し、VDS クエリの `filters` に
明示的に載せる必要がある。

## 設計への含意 — データソース解決の推奨アルゴリズム

1. **シート単位リネージで解決する**(`Sheet.parentEmbeddedDatasources.upstreamDatasources`)。
   結果が 1 件なら即確定。**名前は一切使わない**。ダッシュボードが参照する
   published データソースは少数というのが多数ケースで、大半はここで終わる
2. 複数件なら `logicalTableId` の集合交差で突合(実測ベース。上記 4 の留保つき)
3. 名前一致(`DataSource.name` ↔ `upstreamDatasources.name`)は**最終フォールバック
   のみ**。以下の 2 パターンで壊れることが分かっているため、恒久実装の主経路に
   してはならない:
   - ワークブック内でデータソースのキャプションをリネームしている
     (Embedding 側はキャプション、Metadata 側はサーバー上の published 名)
   - 同名の published データソースを同一シートの上流に複数使っている

### ワークブック作成側へのフィードバック候補

名前結合フォールバックに落ちるワークブックは、作り方の側で回避できる:
- published データソースのキャプションをワークブック内でリネームしない
- 同名の published データソースを(プロジェクト違いで)併用しない

この 2 点はガバナンス上のベストプラクティスとして作成者側に周知する価値がある。

### ルート選択の指針

- **published データソース → ルートB を優先**。セッション不要で
  `X-Tableau-Auth` だけで完結し、壊れる要素が少ない
- **埋め込みデータソース → ルートA 一択**(LUID が無く代替が無い)
- 両対応は `DataSource.isPublished` で分岐するのが素直

アーキテクチャとして成立するのは「iframe が `DataSource.id` と
`getVizQLDataServiceSessionInfo()` の 2 値を MCP クライアント経由でサーバーへ渡し、
サーバーが自前トークンで VDS を叩く」形。ユーザーのブラウザクッキーを
サーバーへ渡す必要がない — 認証はサーバー側資格情報で完結し、セッション値は
データソースを指すハンドルとしてのみ機能する。

## 未検証のまま残っている点

- **cross-user のコンテンツ権限検査**(最重要)。スコープ検査が効くことは
  確認済み(上記 9)だが、「スコープは持つが対象データソースの閲覧権限を
  持たない別ユーザー」がセッション値を使えてしまうかは層が別で、未実施
  (検証サイトに第 2 ユーザーが無い)。ルートAを多ユーザー環境で
  MCP ツール化する前に、対象データソースに未権限の第 2 ユーザーを用意して
  実測すること
- ルートA セッション寿命の上限と、失効時のエラーコード(26.6 分で観測打ち切り。
  ハーネスの `--max-minutes` を伸ばせばそのまま測れる)
- 同名 published データソースが実在する曖昧ケースでの `logicalTableId` 突合
  (検証サイトに重複が無く、ケース自体を再現していない)
- キャプションリネーム時に `DataSource.name` がどちらの名前を返すかの実測
- Metadata API の新規パブリッシュ直後のインデックス反映遅延(推測。未実測)

## 再現手順の要点

1. EAS JWT で REST サインイン(`X-Tableau-Auth` 取得)
2. Metadata API `POST /api/metadata/graphql` で
   `workbooks { luid sheets { name parentEmbeddedDatasources { upstreamDatasources { name luid } } } }`
   を引き、published 1 件のワークシートを選定
3. 対象ビューを Embedding API 3.latest + embed JWT(`tableau:views:embed`)で
   ローカル HTML に埋め込み、`firstinteractive` 後に `getDataSourcesAsync()` /
   `getLogicalTablesAsync()` / `viz.getVizQLDataServiceSessionInfo()` の返り値を採取
4. 解決した LUID で VDS `read-metadata` → `query-datasource`(認証は
   `X-Tableau-Auth`)。ネガティブコントロールとして `sqlproxy.*` id /
   ワークブック LUID / ビュー LUID を `datasourceLuid` に渡し 400 系を確認
5. ルートA: 手順 3 で採取したセッション 2 値を使い、Node から
   `X-Tableau-Auth` + `X-Session-Id` + `Global-Session-Header` +
   `workbookDatasourceId` で VDS を呼ぶ。ヘッダを 1 つずつ落として必須性を確認。
   ページを閉じた後に定間隔で再実行しセッション寿命を観測。
   埋め込みデータソースのみのワークシートでも同手順を反復
