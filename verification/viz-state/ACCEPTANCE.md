# viz 状態スナップショット — 手動受け入れ検証記録

実施日: 20260802
対象: viz 状態スナップショット機能(README の該当節参照)の手動受け入れ 3 項目
結果: **3 項目すべて合格**

## この記録の位置づけ

自動テスト(`npm test`)は Embedding API を実測に基づくモックで置き換えている。
「モックが本物と同じ挙動をする」という仮定は自動テストでは検証できないため、
実 viz に対して本番の capture→push 経路をそのまま実行して仮定を潰した。その証跡。

MCP Apps ホスト内での full E2E(会話で言及 → モデルがスナップショット参照)は
ホスト側の CSP 制約(anthropics/claude-ai-mcp Issue #40。`csp.frameDomains` 不尊重)
により未実施。本記録がカバーするのはキャプチャ側の実機忠実性まで。

## 検証環境

- Tableau Cloud 開発者サンドボックス + Superstore サンプルワークブック
- 認証: EAS(外部認可サーバー)発行の embed JWT(有効期限 10 分、初回サインイン専用)
- Embedding API v3(`tableau.embedding.3.latest.min.js`、実施日時点の配信版)
- ハーネス: ローカル生成のスタンドアロン HTML。実装(`src/web/apps/src/embed/vizState/`)を
  esbuild でバンドルして読み込み、`startVizStateBridge` → `captureVizState` →
  `pushVizState` の本番経路を実行。唯一の代替は push 先で、ext-apps App の代わりに
  `updateModelContext` の受信内容を画面表示する fake App を渡した
- viz への操作は Embedding API の書き込み呼び出し(`applyFilterAsync` /
  `changeParameterValueAsync` / `selectMarksByValueAsync`)で実施。実イベントが
  発火するためキャプチャ検証としてはユーザー操作と等価(マウス操作そのものではない)

## 結果

### 項目 1: フィルター操作が push に一致する — 合格

| 操作 | push 内容 |
|---|---|
| (初期状態) | Region が `values: []` + `isAllSelected: true` + `selectionState: "all"`(全選択 = 空配列の罠が正しく区別される) |
| Region を 1 地域に絞る | `values` に当該地域のみ、`selectionState: "some"`。data 行数 49→11 に追随 |
| Region を除外モードで指定 | `isExcludeMode: true` + 指定値。data 38 行に追随 |
| 日付範囲を変更 | range フィルターの `min` / `max` が Tableau の適用状態と一致(適用値のタイムゾーン解釈は Tableau 側の報告どおり) |

### 項目 2: パラメータ変更が push に反映される — 合格

- 変更値が `formattedValue` 形式(`10.00%` 等)で `parameters` に反映
- **`parameterchanged` イベントは実機で発火する**(設計時は未実測のリスク筆頭だった)
- 許容域外の値を渡すと Tableau が**エラーなしで境界値にクランプ**する。capture は
  クランプ後の実状態を忠実に写す(`getParametersAsync` の生値と一致確認済み)

### 項目 3: マーク選択の反映 + summary data が選択に絞られない — 合格

- 選択した 2 マークが `selection.marks` に正確に反映、`data.selectionActive: true`
- **選択前後で `data.rows` の行数が不変**(35 行のまま)。`ignoreSelection: true` が
  実機でも有効(指定なしだと選択に絞られることは事前の実測で確認済み)

### 横断確認

- 全 8 push、最大 4,301 bytes(予算 30,000 bytes に対し十分な余裕)
- 全 push の文字列に `token`(大文字小文字不問)も embed JWT のリテラルも不含
- 連続操作は debounce(2 秒)で 1 push に集約された

## 実機で新たに確定した事実

1. **`parameterchanged` は発火する**。一方 `summarydatachanged` は「アクティブシートの
   表示に影響しないパラメータ変更」では発火しなかった。バックストップ購読だけでは
   取りこぼすため、`parameterchanged` の直接購読は必須(実装済みの構成が正解)
2. **狭い viewport では Tableau がスマホ向けレイアウトを選び、ダッシュボードの
   画面上ワークシートが減る**(検証時は 4 枚想定のダッシュボードが 1 枚になった)。
   チャット UI のウィジェットパネルは狭いので実運用でも起こり得る。capture は
   その時点の実レイアウトに正しく追随する(不具合ではない)
3. 選択マークの集計測度の `formattedValue` は表示書式でなく生の float 文字列で
   返ることがある(Tableau 側の返答仕様)
4. `selectMarksByValueAsync` の更新種別は `'select-replace'`(`'select'` は不正値で
   即時エラー。永久 pending にはならなかった)

## 再検証の手順(要点)

ハーネスはコミットしていない。再検証する場合の構成要素:

1. EAS の秘密鍵で embed JWT を発行(`sub` = 対象ユーザー名、`aud` = `tableau:<サイト LUID>`、
   exp は最大 10 分)し、viz URL とともにスタンドアロン HTML へ注入する
2. `src/web/apps/src/embed/vizState/` の `startVizStateBridge` / `captureVizState` を
   esbuild で ESM バンドルし、同 HTML から読み込む。push 先には
   `{ getHostCapabilities: () => ({ updateModelContext: { text: true } }),
   updateModelContext: 画面表示 }` の fake App を渡す
3. HTML は `file://` ではなく http で配信する(`file://` は null オリジンになり
   Embedding API の postMessage ハンドシェイクが壊れる)
4. viz を操作(UI または Embedding API の書き込み呼び出し)し、表示された push JSON を
   操作内容と照合する

機微情報(ユーザー名・サイト名・サイト LUID・issuer URL)は環境変数で注入し、
生成物・コミット物に含めないこと。
