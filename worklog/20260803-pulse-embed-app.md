# Pulse メトリックの MCP App(iframe)描画

日付: 20260803
関連文書: [verification/pulse-embed/FINDINGS.md](../verification/pulse-embed/FINDINGS.md)、
README「Viz 状態スナップショット」節、
[worklog/20260802-viz-state-snapshot.md](20260802-viz-state-snapshot.md)

## 背景

`render-interactive-viz` はワークブック/ビューをチャット UI 内の iframe に描画し、ユーザーの
操作状態をモデルコンテキストへ push する。Tableau Pulse メトリックには同じ経路が無く、
「このメトリックを見せて」に対してモデルができるのは数値の読み上げだけだった。

Pulse は Embedding API v3 に `<tableau-pulse>` というカスタム要素を持つ。viz 側で既に成立して
いる構成(ツール → 単一ファイル HTML バンドル → Embedding API → 状態ブリッジ)がそのまま
対称に写せる見込みが立ったため、実装した。

## 変更内容

サーバー側:

- `src/tools/web/renderPulseMetric/renderPulseMetric.ts`(新規): `render-pulse-metric` ツール。
  `metricId`(必須)と `layout`(任意、`default` / `card` / `ban`)を取る。Pulse REST API で
  metric → definition の順に引き、definition 名を表示名として返す。返却は
  `render-interactive-viz` と同じ 2 ブロック構成(`content[0]` = 生 JSON、`content[1]` = ガイダンス文)
- `src/tools/web/utils/pulseUrlUtils.ts`(新規): `{server}/pulse/site/{siteName}/metrics/{metricId}`
  の組み立て。viz と違いハッシュではなく実パス
- `src/errors/mcpToolError.ts`: `PulseMetricNotFoundError` を追加
- `src/tools/web/getEmbedToken/`: `get-embed-token` に任意パラメータ `target`(`viz` / `pulse`)を追加。
  `resolveEmbedToken` のスコープ集合を引数化し、`VIZ_EMBED_SCOPES` / `PULSE_EMBED_SCOPES` を定義
- 登録まわり: `toolName.ts`(`webToolNames` と `mcp-apps` グループ)、`tools.ts`(ファクトリ)、
  `scopes.ts`(`toolScopeMap` と mcp-apps 無効時の削除)、`appConfig.ts`(`embed-pulse` バンドル)、
  `build.ts`(vite エントリ追加)

iframe 側 `src/web/apps/src/pulse/`(新規):

- `mcp-pulse.html` / `mcp-pulse.ts` / `mcp-pulse.css` — エントリと Pulse 固有のスタイル
- `handlePulseToolResult.ts` — 再配送ガード付きの描画フロー(parse → API ロード → トークン取得 →
  マウント → ブリッジ起動)
- `embedTableauPulse.ts` — `<tableau-pulse>` の生成、サイズ追従、エラーイベント配線
- `pulseState/` — 状態スナップショットのブリッジ(`pulseStateBridge` / `capturePulseState` /
  `pushPulseState` / `pulsePayload` / `pulseEmbeddingApiTypes`)

既存の iframe コードへの変更は 2 点のみ:

- `loadTableauEmbeddingApi.ts` — 待機するカスタム要素名を引数化(既定は `tableau-viz` のまま)
- `getEmbedTokenToolClient.ts` — 任意の `target` を受け取り、指定時のみ引数に載せる

## 設計判断

### 採用: iframe 埋め込み(HTML 再実装案は別トラック)

Pulse メトリックを「MCP サーバーが REST でデータを引き、HTML を自前で組み立てて描画する」案も
あった。却下ではなく**別トラックに分離**した判断である。

iframe 案を先に採った理由は、Pulse の価値の大半が**インサイト文と時系列の見せ方**にあり、
それは Tableau 側が生成している成果物だからである。自前 HTML はそれを再現するのではなく
別物を作ることになる。加えて、viz 側で成立済みの経路をそのまま写せるのでリスクが低い。

自前 HTML 案が優位になる条件は残っている(ホスト側 CSP でネスト iframe がブロックされる環境。
README「既知の制約」の Issue #40 がまさにそれ)。その場合の代替として温存する。

### スコープ分岐を `get-embed-token` の任意パラメータにした

Pulse 埋め込みは `tableau:insights:embed` と `tableau:views:embed` の**両方**を要求する
(実測。[FINDINGS](../verification/pulse-embed/FINDINGS.md) 参照)。分岐の入れ方は 3 案あった。

| 案 | 判定 | 決め手 |
|---|---|---|
| 常に両スコープを署名する | 却下 | viz 経路の JWT の権能が黙って広がる。最小権限に反する |
| Pulse 専用のツールを別に生やす | 却下 | app-only ツールが 2 つに増え、iframe 側の呼び分けが増えるだけで得が無い |
| **任意パラメータ `target`** | **採用** | 省略時は従来と完全に同一。viz バンドルのビルド出力も `arguments:{}` のまま変わらない |

`toolScopeMap['get-embed-token'].api` には `tableau:insights:embed` を**足していない**。ここは
OAuth セッションが保持すべきスコープの宣言であり、embed JWT はサーバーが署名するもので
セッションのスコープから導出されない。足すと viz だけを使う既存デプロイに新しいスコープを
要求してしまうため、意図的に据え置いた。

なお Bearer パススルー経路(`AUTH=oauth`)では、渡ってくるトークンのスコープをこちらで変えられない。
`insights:embed` を持たないトークンはそのまま渡り、Pulse 側は session-expired として失敗する。
これはコード上の欠陥ではなく構成上の限界なので、`getEmbedToken.ts` の JSDoc に明記した。

### バンドルを分けた(`embed-viz` に相乗りしなかった)

単一ファイル HTML は 340KB 前後あり、その大半は ext-apps SDK である。1 バンドルに両方の
描画経路を入れると、viz を出すときにも Pulse のコードを、逆も同様に読み込むことになる。
分けた理由は容量よりも**失敗の独立性**で、Pulse 側のイベント配線の誤りが viz の描画を
壊せない構造にしておきたかった。ビルドは vite エントリを 1 行足すだけで済む。

### 状態スナップショットに数値を入れない

viz 版のスナップショットはアクティブシートの要約データ(行データ)を含む。Pulse 版は
**意図的に数値を持たない**。`<tableau-pulse>` に要約データリーダーに相当する API が無く、
メトリック値は Pulse のインサイト API(= サーバー側の
`generate-pulse-metric-value-insight-bundle`)の担当だからである。

「メトリックのスナップショット」はモデルに数値を語らせる誘因が強いので、push のプリアンブルに
**数値は入っていない・数値が要るならこのツールを呼べ**と明示的に書いた。

### 共通ユーティリティは複製せず import した

`debounce` / `serialQueue` / `sanitize` / `PUSH_BUDGET_BYTES` は `embed/vizState/` から import して
再利用している。`shared/` へ移動する案もあったが、既存の viz 側テストを含む十数ファイルの
import を書き換える差分が本筋と無関係に膨らむため見送った。移動は後で単独でやればよい。

### エラー UI は共有のものを使った

`showError.ts` は `tableauVizContainer` という id のコンテナに描画する。Pulse の HTML でも
同じ id を使い、エラー UI をそのまま再利用している。ただし見出し文は
「Unable to load this Tableau view」で固定であり、Pulse に対しては語が正確でない。
共有 UI の文言変更は viz 側の挙動にも触るため、この PR では触っていない(follow-ups 参照)。

## 検証

- `npm test`: 2,907 件中 2,906 件成功。失敗 1 件は `src/features/init.test.ts` の
  パス区切り(`/` 前提)による Windows 環境固有のもので、**変更前のツリーでも同様に失敗する**
  ことを確認済み(本変更とは無関係)
- `npm run lint`: エラーなし
- `npm run build`: 成功。`build/web/apps/dist/mcp-pulse.html`(342KB)が出力され、
  `createElement("tableau-pulse")` と 7 つの Pulse イベント名がバンドルに含まれることを確認。
  `mcp-app.html` には `tableau-pulse` の出現が 0 件で、viz バンドルへの混入が無いことも確認
- 実機検証: [verification/pulse-embed/FINDINGS.md](../verification/pulse-embed/FINDINGS.md)

## Follow-ups

- **実ホストでの E2E は再デプロイ後に実施**。iframe 側のコードはイメージに焼き込まれるため、
  ホストでの確認には再デプロイが要る
- `getFiltersAsync()` / `getTimeDimensionAsync()` の戻り値の形は未確定。実機で確定したら
  `capturePulseState.ts` の寛容な射影を実測ベースの whitelist に締める
- `showError.ts` の見出し「Unable to load this Tableau view」が Pulse では不正確。
  シナリオ別の見出しに一般化する場合は viz 側のテストも合わせて更新する
- `embed/vizState/` の共通ユーティリティ(debounce / serialQueue / sanitize)を `shared/` へ
  移す整理。今は Pulse バンドルが viz フォルダに依存している
- ウィジェット恒久破損(README 参照)の復旧手順に `render-pulse-metric` も該当する。
  リネームが必要な箇所は viz と同じ 3 ファイル(ツール本体 / `toolName.ts` / `scopes.ts`)
