# Pulse スナップショットの取りこぼし修正(実測形状への追随)

日付: 20260804
関連文書: [verification/pulse-embed/FINDINGS.md](../verification/pulse-embed/FINDINGS.md)、
[worklog/20260803-pulse-embed-app.md](20260803-pulse-embed-app.md)

## 背景

`render-pulse-metric` が push する状態スナップショットに、実機で 2 つの欠落があった。
ChatGPT ホストでの確認(20260804)で `timeDimension` が常に無く、`insights` が常に空だった。

原因はローカルハーネス(Tableau Cloud 2026.2、Embedding API 3.16.0)のプローブ実測で確定した。
20260803 の実装時点で `getFiltersAsync()` / `getTimeDimensionAsync()` の戻り値の形は未確定であり、
複数の候補キーを許容する寛容な射影で凌いでいた。その候補が実物と当たっていなかった。

確定した事実は 3 点。

1. **`getTimeDimensionAsync()` は文字列を返す。** 実測値 `"MonthToDate"`。オブジェクト前提の
   射影は文字列に対して `undefined` を返し、`timeDimension` を黙って落としていた
2. **フィルター要素の own キーは下線接頭辞。** `_fieldName` / `_filterType` / `_appliedValues` /
   `_isExcludeMode` / `_isAllSelected` など。候補キーに `_fieldName` と `_filterType` が無く、
   field と operator が読めていなかった
3. **`pulseinsightdiscovered` は初期描画では発火しない。** 画面にインサイト文が出ていても 0 件。
   ユーザーが探索操作をして初めて届く

3 点目はコードの欠陥ではない。欠陥は「空を無しと読ませてしまう」ことのほうにある。

## 変更内容

`src/web/apps/src/pulse/pulseState/capturePulseState.ts`:

- `serializeTimeDimension` に文字列経路を追加。非空文字列を受けたら `{ range: ... }` を返す。
  オブジェクト経路は現状維持
- 候補キーを追加(いずれも既存の優先順の末尾)。`FILTER_FIELD_KEYS` に `_fieldName`、
  `FILTER_OPERATOR_KEYS` に `_filterType`、`FILTER_VALUE_KEYS` に `_appliedValues`
- フィルター射影に任意 boolean を 2 つ追加。`isExcludeMode` と `isAllSelected`。
  読み取りは `firstBoolean` ヘルパーで、boolean 以外は捨てる(真偽値への強制変換をしない)

`src/web/apps/src/pulse/pulseState/pulsePayload.ts`:

- `PulseFilterSnapshot` に `isExcludeMode?` / `isAllSelected?` を追加
- `BASE_PULSE_CAVEATS` に 1 行追加。insights はユーザーがウィジェット内でインサイトを
  探索したときにのみ蓄積され、空はインサイト非表示を意味しない旨

テスト:

- `pulseTestFakes.ts` に `makeMeasuredPulseFilter` を追加(実測形状の fake)。既存の
  `makePulseFilter` は残した
- `capturePulseState.test.ts` に 5 件追加。実測形状のフィルター(完全一致で射影を検証)、
  プロトタイプ getter 経由の読み取り、boolean 以外のフラグの破棄、文字列 timeDimension、
  空文字列 timeDimension

`verification/pulse-embed/FINDINGS.md`:

- 「未確定として残したもの」にあった戻り値形状の項を、結果 4(戻り値の形)と
  結果 5(インサイトイベントの発火条件)へ昇格。追測の再現手順の要点も併記

## 設計判断

### 文字列は `range` に入れた(`granularity` ではなく)

`"MonthToDate"` は期間の呼び名であって粒度の名前ではない。`field` と `granularity` は
この形状には情報が無いので**空のまま**にした。埋められない欄を推測で埋めると、
モデルが実際には測定されていない前提で語り始める。

### 候補キーは置換ではなく追加

実測で当たったキーだけの whitelist に締める案もあった(20260803 の follow-up にはそう書いてある)。
採らなかった。下線接頭辞は Embedding API の内部フィールドがそのまま露出しているもので、
**予告なく変わりうる**。公開名が生えたときに黙って読めなくなる構造にしたくないので、
公開名の候補を先、下線名を後、という優先順で並べた追加に留めた。

### `isAllSelected` / `isExcludeMode` を足した理由は「空の意味」の区別

実測では無操作のフィルターが `_appliedValues: []` と `_isAllSelected: true` の組で返る。
このフラグが無いと、スナップショット上で「全選択なので値が空」と「値が読めなかった」が
同じ見た目になる。既存の `note`(読めなかった形状の記録)と同じ趣旨を 1 段下で成立させたもの。

boolean 以外を捨てる判定にしたのは、`'false'` のような文字列を truthy と読んで
**フィルター状態を逆に報告する**事故を避けるため。読めなければ欄ごと欠落させるほうが安全である。

### insights の空は caveat で処理した(挙動は変えない)

イベントが来ないだけなので、capture 側でできることは無い。DOM を走査してインサイト文を
読む案は却下した。iframe 内の Pulse は別オリジンであり、そもそも到達できない。

## 検証

- `npx vitest run src/web/apps/src/pulse`: 6 ファイル 70 件すべて成功(変更前は 65 件)
- `npm run lint`: エラー・警告なし
- 実機プローブの根拠: [verification/pulse-embed/FINDINGS.md](../verification/pulse-embed/FINDINGS.md)
  の結果 4 / 結果 5

## Follow-ups

- **ChatGPT ホストでの再確認は再デプロイ後に別途行う。** iframe 側のコードはイメージに
  焼き込まれるため、この PR だけでは実ホストの挙動は変わらない。確認する項目は
  `timeDimension` が入ること、フィルターに field / operator / `isAllSelected` が入ること
- `_filterType` が `categorical` 以外に何を取るかは未測定。日付・数値フィルターを持つ
  メトリックで追測が要る
- `getTimeDimensionAsync()` の文字列の値域も未測定。粒度が別途取れる形状が存在するなら、
  `granularity` を埋める経路を足す余地がある
- 20260803 の follow-up にあった「実測ベースの whitelist に締める」は**採らない方針に変更**した。
  理由は上記「候補キーは置換ではなく追加」のとおり
