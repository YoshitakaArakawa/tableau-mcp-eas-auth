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

### 5. Bearer パススルーの embed トークンではサインイン画面になる。サーバー署名で解消

`ADVERTISE_API_SCOPES=false` で接続した後、viz 埋め込み(get-view)を実行すると、
App の iframe に Tableau のサインイン画面が表示された。原因は `get-embed-token` が
ユーザーの OAuth アクセストークン(Bearer)を無条件でパススルーしていたこと。
項2のとおり ChatGPT のトークンには `tableau:views:embed` が載らないため、
Embedding API が認証不成立としてサインイン画面へフォールバックする。

`get-embed-token` をサーバー署名優先(`AUTH=eas` では EAS 秘密鍵で
`tableau:views:embed` を載せた embed JWT を署名)に変更した結果、同じ操作で
viz が直接描画されることを実測確認した(サインイン画面なし・操作可能な状態で表示)。

### 6. App iframe の sandbox に allow-popups がない。サインインボタンは silent fail する

ChatGPT の App iframe を実測した属性:

```
src:     https://asdk_app_<app-id>.web-sandbox.oaiusercontent.com/...
sandbox: allow-scripts allow-same-origin allow-forms
allow:   local-network-access *; microphone *; midi *
```

`allow-popups` / `allow-top-navigation` が無いため、Embedding API のサインイン
ボタン(ポップアップでログイン画面を開く)はクリックしても何も起きない。
つまり ChatGPT 内では「ユーザーにサインインさせて埋め込む」経路は成立せず、
埋め込みトークンをサーバー側で完結させる(項5)ことが必須になる。

### 7. アクセストークン失効後、ChatGPT は自動リフレッシュせずツール呼び出しが 401 になる

コネクタ登録から約40分後、ツール呼び出しがミドルウェアのトークン検証
(`getCurrentServerSession`)で Tableau の 401002 により拒否された。ChatGPT は
この 401 を受けてもトークンリフレッシュを試みず、会話上にエラーを表示した。

設定 → プラグイン → 対象コネクタ → 管理 → 「更新する」でアクション再読み込みを
行った後、新規チャットからの呼び出しは成功した(再サインインは要求されなかった)。
リフレッシュがどの時点で走ったか(再読み込み時か次回呼び出し時か)は**未確認**。

### 8. ChatGPT ホストで updateModelContext の full E2E が機能する

viz 状態スナップショット(App iframe から `app.updateModelContext` で push)は ChatGPT の
モデルに実際に届く。実測では、埋め込んだ Superstore ダッシュボードで州を選択した後の
質問に対し、ChatGPT が選択州・期間フィルター・Region 状態を正確に列挙した。操作後の
更新 push も届く(初回だけでなく、選択変更が次のターンの回答に反映された)。

注意: 操作直後の質問では一つ前の状態を報告する場面も観測された。debounce 2 秒 +
キャプチャ最大 15 秒のラグに加え、push が次ターンからしか見えない可能性がある(**未確認**)。

### 9. スナップショットの誘導で「見えているデータ」の再クエリが成立する

push preamble の誘導(データはサンプル、フルデータは datasources を query-datasource で、
状態をフィルターに翻訳して引く)に対する ChatGPT の実挙動:

1. スナップショットから状態を読み取り(期間 2017-01-03〜2020-12-30、州選択 Texas、
   Region 全件)、クエリ条件へ翻訳した。マーク選択→カテゴリカルフィルターの翻訳を含む
2. データソース解決は name 経由だった。`list-datasources` は「見つからない/権限なし」を
   返し、`search-content` で名前検索して published datasource の LUID を解決した
3. 再クエリした全体集計(売上 $170,188.05 / 利益 -$25,729.36 / 利益率 -15.12%)が、
   画面のダッシュボード KPI 表示と完全一致した。年別・カテゴリ別・サブカテゴリ別の
   掘り下げまでフルデータで実行された
4. ChatGPT は自発的に「アクションフィルターを分析全体に適用した」という解釈の注記と、
   「検索で解決したデータソースが viz の参照先と同一である厳密な確認はできていない」
   という限界の申告を行った(caveat の意図どおりの挙動)

`DataSource.id`(Embedding API)が published datasource LUID と一致するかは**未確認**のまま
(ChatGPT はツール履歴から id 値を再掲できず、id を直接 datasourceLuid には使わなかった)。
誘導文の name フォールバックが実際の成立経路である。

実際のツール呼び出し列(ChatGPT の自己申告。引数は会話上で確認できた範囲のみ):

1. `list-datasources` `{}` → 「見つからない/権限なし」
2. `search-content` `{"terms": "Superstore"}` → published datasource を解決
3. `get-datasource-metadata` `{"datasourceLuid": "<解決した LUID>"}` → フィールド一覧
4. `query-datasource` ×4(全体集計・年別・カテゴリ別・サブカテゴリ別。引数 JSON は
   ChatGPT が後から再掲できず**未確認**。Texas と期間のフィルターが入っていたことは
   集計結果が画面 KPI・注文数 487 件と一致したことからの推定)

「フルデータの再クエリ」の実体は、VDS(query-datasource)がフィルター適用後の全行を
サーバー側で集計した結果であり、行データのダウンロードではない。

### 10. 照合指示(preamble の cross-check)の実効性 — 自発実行は不安定、事後照合は不可能

preamble に「クエリ後、結果を `data` サンプルと突き合わせて一致を報告せよ」を追加した
デプロイでの実測(Superstore ダッシュボード・Texas 選択・カテゴリ別分析を依頼):

1. **サンプルを根拠にした捏造拒否は機能した**。トークン失効でクエリできなかったターンで、
   ChatGPT は「サンプルは288行中の一部で切れており、この状態で算出すると不正確になるため
   数値の推測は避けます」と明示的に拒否した。アクションフィルターの `appliedTo`
   (Texas は Sales by Segment のみに適用)まで読んで分析範囲を正しく限定した
2. **成功ターンでの自発的な照合宣言は実行されなかった**。全カテゴリ集計は返ったが
   一致/不一致の報告はなく、後から尋ねると「照合は実施していない」と自己申告した
3. **事後の照合は不可能だった**。後続ターンで照合を指示すると、「スナップショットの
   data サンプルと KPI 値は現在の会話から参照できない」と回答(ChatGPT の自己申告)。
   push された model context が後続ターンまで保持されるかはホスト実装依存で、
   少なくとも事後参照は当てにできない。**照合はクエリと同一ターン内でしか成立しない**
4. 取得値の正しさ自体は外部照合で確認済み: カテゴリ別合計(売上 $2,297,201 /
   利益 $286,397 / 12.5%)は全州状態のダッシュボード KPI 表示と完全一致(操作者が
   画面目視で照合)
5. 経路の変形: このターンで ChatGPT は query-datasource ではなく **get-view-data
   (Product シートの全行 CSV)** を選んだ。ただしこの経路が正しい数字を返したのは、
   **対象シートが実質デフォルト状態だった**(期間・Region・Order Profitable? が
   すべて既定値、Texas アクションは `appliedTo` により当該シートに不適用)からである。
   REST の Query View Data はセッション状態を見ず、`viewFilters`(`vf_` パラメータ)を
   渡さない限りパブリッシュ時のデフォルト状態を返す。非デフォルト状態のシートを
   viewFilters なしで読むと**黙って現在の表示と異なる数字が返る**。シート計算を含む
   viz 側の計算結果が取れる利点はあるが、状態反映にはスナップショットの filters を
   viewFilters へ翻訳して渡すことが必須(`vf_` は範囲・相対日付の表現力が弱いため、
   その場合は query-datasource が優先)。preamble にこの警告を追加した

### 11. 照合指示の再検証(view-data 警告入りデプロイ) — 照合が実行され、丸め差の診断まで行われた

view-data 警告を含む preamble のデプロイ後、ChatGPT の Work モード(モデル表記 5.6 Sol)で
再検証。「画面表示との一致確認も含めて」と依頼した条件で:

- 「フルデータを再取得し、ダッシュボード表示と照合しました」と明示し、州別利益率の
  個別値一致(California 16.7% / Texas −15.1% / Ohio −21.7% 等)を確認・報告した
- 画面表示の合計(整数丸め)と明細合計の差 $58 を検出し、**丸め差である**と原因を
  診断して報告した(不一致の切り分けという設計意図どおりの挙動)
- 別経路比較(表示値 vs 明細再集計)を自発的に設計・実行した

一方で新たに観測された問題:

- このターンでは直前のマーク選択(州選択)がスナップショットとして届いておらず、
  モデルは既定状態を現在状態として扱った(ラグか Work モード面の差異かは**未確認**。
  項8のラグ注意の再発現)
- 分析ターン中に複数ビューのデータ取得が走った際、**表示中の App ウィジェットが
  「Unable to load this Tableau view / The response was not in the expected format」
  (PARSE_ERROR 画面)に置き換わった**。ホストは描画ツール以外の結果も同一ウィジェットに
  再配送することがあり、App 側が非描画ペイロードを受けたときに表示中の viz を守らない
  ことが原因。App の堅牢化(viz 実装済みなら不正配送を無視する)が別修正として必要
- トークン失効時、ChatGPT が**チャット内に「再接続」ボタンを表示する**導線を今回初めて
  観測した(押下で OAuth が再実行され、Tableau セッションが生きていればサインイン画面
  なしで完了し、実行中の分析ターンが自動再開された)。項7の「設定画面から更新する」より
  軽い復旧経路が存在する

## 再現手順の要点

1. `TRANSPORT=http` / `AUTH=eas` / `OAUTH_EMBEDDED_AUTHZ_SERVER=false` /
   `ADVERTISE_API_SCOPES=true` で MCP サーバーを公開 HTTPS にデプロイする
2. ChatGPT(Web)の設定 → プラグイン/コネクタ → 開発者モードを有効化
3. MCP エンドポイント URL を登録し、認証方式に OAuth を選んで Tableau にサインイン
4. 会話からツール一覧を要求すると 0 件になる。同時刻のサーバーログに
   `Insufficient scopes` が出ていることを確認する
5. `ADVERTISE_API_SCOPES=false` にして再デプロイし、コネクタ設定の「更新する」を押す。
   ツールが現れれば再現と解消の両方が取れている
