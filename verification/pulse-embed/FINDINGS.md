# Pulse 埋め込み(`<tableau-pulse>`)— 実測で確定した事実

実施日: 20260803(結果 1〜3)、20260804 追測(結果 4〜5)
対象: Tableau Pulse メトリックの Embedding API v3 埋め込み(`render-pulse-metric` 機能の前提調査)
結果: **スコープ要件・イベント名・サイズ通知形式に加え、読み取り API の戻り値の形と
インサイトイベントの発火条件を実機で確定**

## この記録の位置づけ

自動テスト(`npm test`)は Embedding API をモックで置き換えている。「モックが本物と同じ挙動を
する」という仮定は自動テストでは検証できない。とくに Pulse 埋め込みは公式ドキュメントの記述が
薄く、スコープ要件については**ドキュメントの記述が実機と食い違っていた**。ここに置くのは
その食い違いを実機で潰した証跡である。

## 検証環境

- Tableau Cloud developer sandbox (2026.2)
- Embedding API 3.16.0(`tableau.embedding.3.latest.min.js`、実施日時点の配信版)
- 認証: EAS(外部認可サーバー)発行の embed JWT。RS256 署名、有効期限 10 分
- ハーネス: ローカル生成のスタンドアロン HTML。`<tableau-pulse>` に src(Pulse メトリック URL)と
  署名済み JWT を渡してマウントし、DOM イベントと DevTools の Network タブを観察した。
  **ハーネスは git-ignored でありコミットしていない**(`verification/README.md` の方針どおり)

再現手順の要点:

1. EAS 秘密鍵で `scp` を変えた JWT を 2 通り署名する(下表の A / B)
2. 同じ Pulse メトリック URL を `src` に持つ `<tableau-pulse>` を、それぞれの JWT でマウントする
3. Network タブで embed signin 以降のリクエストのステータスを記録する
4. 要素に届く DOM イベントを全件記録する

20260804 の追測(結果 4〜5)は同じハーネスにプローブを足したもので、手順の要点は次のとおり:

1. 完全描画を待ってから `getFiltersAsync()` / `getTimeDimensionAsync()` を呼ぶ
2. 戻り値ごとに `typeof` / `Object.keys()` / `Object.getOwnPropertyNames(prototype)` を記録する
   (JSON 化だけでは prototype getter が見えず、own キーの下線接頭辞にも気づけない)
3. 描画完了から一定時間、`pulseinsightdiscovered` の受信件数を数える(無操作のまま)

## 結果 1: Pulse 埋め込みには `tableau:views:embed` も必須

**確定した事実: `tableau:insights:embed` 単独では Pulse 埋め込みは完成しない。**
`tableau:views:embed` を**併記**して初めて描画が通る。公式ドキュメントに
`views:embed` が必要である旨の記載はない。

| ケース | `scp` | embed signin | 後続 API | 画面 |
|---|---|---|---|---|
| A | `["tableau:insights:embed"]` | **200(成功)** | `getUsers` / `measurementPeriods` / `getDatasourceFieldOptions` が **401**、`insights/exploration` が **400** | session-expired エラーへ遷移 |
| B | `["tableau:views:embed","tableau:insights:embed"]` | 200 | 全て成功 | メトリックが完全に描画される |

ケース A のいちばん厄介な点は **signin が 200 で通ってしまう**ことである。認証段階では成功に
見えるため、切り分けを誤ると「トークンが無効」ではなく「Pulse が壊れている」ように見える。
さらに、ユーザーに見える最終症状が session-expired(セッション切れ)であるため、
**症状の名前が原因を指していない**。

実装への反映: `src/tools/web/getEmbedToken/resolveEmbedToken.ts` の `PULSE_EMBED_SCOPES` は
両スコープを持つ集合として定義してある。`get-embed-token` の `target: 'pulse'` でのみ使われ、
viz 経路は `VIZ_EMBED_SCOPES`(`views:embed` 単独)のまま変えていない。

## 結果 2: DOM イベント名は小文字

**確定した事実: `<tableau-pulse>` の DOM イベントは全て小文字で届く。**
ドキュメントに現れる `TableauEventType` の camelCase 綴りは DOM イベント名としては発火しない
(viz 側の `firstvizsizeknown` などと同じ規則)。

実測で受信を確認した名前:

- `firstpulsemetricsizeknown` — 初回のサイズ確定
- `pulsemetricsizechanged` — 以降のサイズ変更
- `pulseerror` — 実行時エラー
- `pulseurlchanged` — 要素内ナビゲーション
- `pulsefilterschanged` — フィルター変更
- `pulsetimedimensionchanged` — 期間・粒度変更
- `pulseinsightdiscovered` — インサイト提示

## 結果 3: イベント detail の形式

**確定した事実: detail のフィールド名は先頭アンダースコア付きである。**
これは Embedding API 側の内部フィールドがそのまま露出しているもので、こちらの private 記法ではない。

| イベント | detail |
|---|---|
| `firstpulsemetricsizeknown` / `pulsemetricsizechanged` | `_width` / `_height`(数値) |
| `pulseerror` | `_message` / `_httpStatus` / `_messageVisibility` |
| `pulseurlchanged` | `_context`。セッション切れ時の値は `'session-expired'` |
| `pulseinsightdiscovered` | `id` / `type` / `question` / `markup` / `score` |

viz 側の `firstvizsizeknown` が `detail.vizSize.sheetSize.maxSize.height` という入れ子だったのに対し、
Pulse は `detail._height` のフラットな形式である。**同じ書き方は通用しない。**

## 結果 4: 読み取り API の戻り値の形(20260804 追測)

20260803 時点で未確定として残していた項目である。マウント直後の `<tableau-pulse>` に対して
両 API を呼び、戻り値の own キーとプロトタイプキーを列挙して確定した。

### `getTimeDimensionAsync()` は**文字列**を返す

**確定した事実: オブジェクトではなく素の文字列である。** 実測値は `"MonthToDate"`(`typeof` は
`"string"`)。フィールド名も粒度も伴わない、期間の呼び名だけが返る。

これは実害のある食い違いだった。実装は当初オブジェクト前提で読んでいたため、文字列は
どのキーにも当たらず `undefined` を返し、スナップショットから `timeDimension` が
**常に黙って落ちていた**。文字列経路を足し、値を `range` として記録するよう修正した。

### `getFiltersAsync()` の要素は下線接頭辞の own キーを持つ

**確定した事実: own キーは `_fieldName` / `_filterType` / `_metricId` / `_registryId` /
`_appliedValues` / `_isExcludeMode` / `_isAllSelected` の 7 つ。**
プロトタイプには getter として `isAllSelected` / `appliedValues` / `isExcludeMode` があり、
加えて `getDomainAsync` を持つ。`fieldName` や `field` の getter は**無い**。

つまりフィールド名と演算子は `_fieldName` / `_filterType` からしか読めない。実装の候補キーには
どちらも入っていなかったため、この環境では field と operator が空のまま記録されていた。

もう 1 点、無操作状態のフィルターは `_appliedValues: []` と `_isAllSelected: true` の組で返る。
**値の空配列は「絞り込み無し(全選択)」を意味し、「読めなかった」ではない。**
この 2 つを区別できるよう、スナップショットに `isAllSelected` / `isExcludeMode` を追加した。

実測した要素のうち `_metricId` はメトリックの LUID を持つが、スナップショットには
whitelist していない(識別子を push する必要が無いため)。

補足(実装には未反映): 同セッションで `applyFilterAsync` を試すと以降の
`getFiltersAsync()` / `getTimeDimensionAsync()` が `internal-error: Service not registered:
PulseService` で失敗するようになった。書き込み系メソッドは型宣言から意図的に外してあり
(`pulseEmbeddingApiTypes.ts`)、読み取り専用の本実装はこの経路を踏まない。

## 結果 5: `pulseinsightdiscovered` は初期描画では発火しない

**確定した事実: メトリックが完全に描画され、画面にインサイト文が表示されている状態でも、
`pulseinsightdiscovered` の受信件数は 0 件だった。** イベントはユーザーがウィジェット内で
インサイトを展開するなど探索操作をして初めて届く。

したがって **スナップショットの `insights: []` は「画面にインサイトが無い」ことを意味しない。**
モデルがこれを「インサイト無し」と読むと事実に反する断定をするため、payload の固定 caveat に
この旨を 1 行追加した(`pulsePayload.ts` の `BASE_PULSE_CAVEATS`)。

## 未確定として残したもの

正直に区別しておく。以下は今回の測定では確定していない。

- `_filterType` が `categorical` 以外に何を取るか(日付・数値フィルターでの値)
- `getTimeDimensionAsync()` が返す文字列の値域。`MonthToDate` 以外の綴りは未確認
- `pulseerror` の `_httpStatus` が 401/403 以外で何を返すかの網羅
- MCP Apps ホスト内での full E2E。viz 側と同じくホストの CSP 制約
  (anthropics/claude-ai-mcp Issue #40)の影響下にあり、実ホストでの確認は再デプロイ後に行う
