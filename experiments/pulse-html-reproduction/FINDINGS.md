# Pulse メトリックの自前 HTML 再現 — 検証所見

対象: Pulse REST API の insight bundle (detail) 1 レスポンスのみを素材に、iframe を使わず
単一ファイル HTML で detail ビューを再現できるか。

- プロトタイプ: `pulse-html-prototype.html` (65,978 B / 64.4 KB)
- 生成スクリプト: `build-prototype.py` (入力 `detail-bundle.json`)
- 検証日: 20260804

入力の `detail-bundle.json` は git-ignored(サイト固有の ID を含みうるため)。
再生成するには、対象メトリックに対して Pulse REST API の
`generate-pulse-metric-value-insight-bundle`(bundleType: `detail`、
output_format: `OUTPUT_FORMAT_HTML`)を呼び、レスポンス全体をこの
ディレクトリに `detail-bundle.json` として保存する。プロトタイプ自体には
UUID・ホスト名が含まれないことをコミット前に確認済み(サンプルデータは
Superstore デモ)。

結論: **描画は再現できる。操作は再現できない。** bundle は「ある 1 つの期間・
フィルタ条件で確定した結果セット」なので、値を変える操作(期間切替・フィルタ・
ドリル)は原理的にサーバー往復を要する。逆に言えば、往復を伴わない表現要素は
ほぼすべて bundle 内に入っている。

---

## 1. 再現できた要素

いずれも `pulse-html-prototype.html` 上で実際に描画済み。

**BAN ブロック**
- 現在値 `$2.6K`、前期比 `-66.3% (-$5.2K)`、方向アイコン。
- 色は **direction ではなく sentiment で決める**。今回は `direction=down` かつ
  `sentiment=neutral` なので赤ではなく中立色。facts に両方あるので判定可能。
- 現在 vs 前期の 2 本バー(`ban` の viz.data.values)。`average:true` の行は
  グレー(`#C8CED8`)、当期は青。Pulse 実 UI と同じ色分けが params から取れる。

**時系列チャート(currenttrend, 82 点)**
- 実データ 80 点の折れ線。`rawValue` が欠測の日でラインを分断。
- `isProjection:true` の 2 点は将来予測ではなく **トレンド線の両端**。破線
  (`lineStrokeDash: [6,3]`)で結ぶと Pulse と同じ見た目になる。
- 軸ラベルは `customFormatterMaps.xAxis` / `.yAxis` にフォーマット済み文字列が
  入っている(`"6963.4040" → "$7.0K"`)。**自前で通貨フォーマッタを書く必要がない。**
- ホバーツールチップは bundle の `tooltipMarkup` をそのまま(サニタイズして)再利用。
  最近傍点の検出だけ自前。

**期待レンジ(anchor / unusualchange)**
- `ci0`/`ci1` の帯、孤立点(Aug 1)、current value の丸+ラベル(`$531.35`)、
  凡例 2 項目、説明文(`legend.explanations[0].text`)まで bundle から復元。
- x 軸は当月 1 日〜末日、active date(Aug 3)のグリッド線と太字ラベルまで params
  (`activeLabelAndGridDate`, `xAxisGridColorActive`)にある。

**インサイト文**
- `ban` / `anchor` の `markup` をサニタイズして表示。`data-type` の span
  (`metric` / `insight-type-keyword` / `entity` / `value` / `period` /
  `actual-label` / `actual-value` の 7 種を実測)にスタイルを当てて活かした。

**ブレークダウン**
- 5 次元(Region / Category / Segment / Sub-Category / State/Province)をタブ切替。
- 横棒 + `formattedValue`。`"$1.8K (-2.8%)"` の括弧部だけ符号で着色
  (`barValueLabelColorPositive #1EA562` / `Negative #C6154A`)。

**フォローアップ**
- 21 件中 4 件(type ごとの最高スコア)をアコーディオンに。負値を含む
  `top-drivers` は 0 基点の発散横棒として同じ描画関数で処理できた。

---

## 2. 再現できなかった要素

**サーバー往復が必須で原理的に不可能**

- 期間の切替(month to date → quarter / year など)。granularity を変えると
  別の bundle になる。
- 比較期間の変更(前期比 → 前年同期比)。
- フィルター適用・解除。bundle は定義済みフィルタ適用後の結果しか含まない。
- ドリルダウン、次元の入れ替え。
- 「Explore in Tableau」等のビューへの遷移、Ask Data 的な自由質問。

**bundle には入っているが今回入れていない(実装コスト判断)**

- followup 21 件すべて。4 件で 2,732 B なので全件でも +10 KB 程度。遅延取得は
  できない(単一ファイル制約)ので全部埋め込むかどうかの二択になる。
- `score` によるインサイトのランキング表示。値はある。

**bundle にない**

- メトリック定義のメタデータ(定義名以外の説明、所有者、更新時刻)。
  `markup` から metric 名を正規表現で抜くしかなかった。
- 購読/フォロー状態、通知履歴、コメント。
- ダークテーマ用の色。params の色はライトテーマ固定値。

**厳密一致を諦めた点**

- 点マーカーのサイズ。spec は全 80 点に `pointStrokeSize: 200`(半径 ≈ 8px)を
  指定するが、そのまま描くと塗り潰しになる。r=2.6 に落とし、点間隔 6px 未満なら
  非表示にした。ピクセル一致は非目標と割り切っている。
- フォント。params の指定は `SF Pro Text` 先頭のシステムスタックなので、
  外部フォント禁止の制約とは矛盾しない(そのまま流用した)。

---

## 3. iframe 版との差分

**失うもの**

- **汎用性**。Vega-Lite なら spec が変わっても描ける。自前 SVG は insight type ごとに
  描画コードが要る。ただし実測では Pulse の viz は「時系列」「帯付き時系列」
  「横棒(正/負)」の 3 型しかなく、28 インサイト全部がこの 3 型に収まった。
  型の追加は Tableau 側のリリース依存で、頻度は低いと推測(未確認)。
- **Pulse 側 UI 更新への追随**。iframe なら Tableau の改善が自動で乗る。
- Vega の selection / legend interaction / 画像エクスポート等の既製機能。
- 公式コンポーネントであること自体(表示内容の正しさの担保が自前になる)。

**得るもの**

- **CSP 非依存**。ホストの `frame-src` / `frame-ancestors` を一切要求しない。
  ネスト iframe が禁止された環境で唯一動く形。
- **ブラウザから Tableau への通信ゼロ**。bundle 取得はサーバー側で完了しているので、
  クライアントに認証 cookie / token / セッションが渡らない。監査面で有利。
  実測: `performance.getEntriesByType('resource')` が `[]`(favicon 以外リクエストなし)。
- **サイズが約 1/13**(次節)。
- スナップショット性。ファイル 1 個で完結し、オフラインで開ける。ホストのテーマに
  合わせたレイアウト改変も自由。
- 描画が同期的で、iframe のロード待ち・高さ調整・postMessage 往復が不要。

---

## 4. サイズ実測

| 対象 | バイト数 |
|---|---|
| `pulse-html-prototype.html`(完成品) | **65,978 B (64.4 KB)** |
| 同 gzip -9 | 14,861 B |
| うちインライン JSON ペイロード | 34,368 B |
| 入力 `detail-bundle.json`(原文) | 265,393 B |

ペイロード内訳: trend 14,043 / anchor 9,560 / breakdowns 4,240 / followups 2,732 / ban 840 B。

bundle 原文 265 KB のうち **viz spec が 210,414 B**、そのうち実データ
(`viz.data`)は **49,028 B** で、残り **161,386 B は Vega-Lite の足場**
(layer / mark / encoding / config)。つまり **spec の 77% は捨てられる**。
markup は全 28 インサイト合計で 8,335 B、facts は 16,980 B しかない。

**Vega-Lite を同梱した場合の比較**(20260804 に jsdelivr へ HEAD リクエストして
Content-Length を実測。ファイルはダウンロードしていない)

| ファイル | 実測 |
|---|---|
| `vega@5/build/vega.min.js` | 515,242 B |
| `vega-lite@5/build/vega-lite.min.js` | 252,198 B |
| `vega-embed@7/build/vega-embed.min.js` | 60,077 B |
| 合計(minified, 非圧縮) | **827,517 B (808 KB)** |

bundle の spec は `$schema: vega-lite/v5` なので v5 系で揃えた。
外部リソース禁止なので CDN 参照はできず、**この 808 KB を HTML にインライン**する
必要がある。加えて描画する 8 インサイト分の spec 88,527 B が乗るので、
**合計 ≈ 900 KB 弱、現行の約 14 倍**。

MCP Apps は HTML 文字列を MCP レスポンスに載せるため、gzip 前の生バイト数が
そのままトークン/転送コストになる。この 14 倍差は無視できない。

---

## 5. 実装上のハマりどころ

数値・データ構造まわり(ここが 8 割):

1. **数値が文字列で来る。欠測は文字列 `"null"`。** `rawValue: "4919.1820"`,
   `ci0: "null"`。`Number("null")` は `NaN` なので、`null` 判定を挟む正規化が必須。
   `formattedValue` 側は `null`(JSON の null)ではなく文字列 `"null"` のこともある。
2. **同一日付の行が複数ある。** anchor の Aug 3 は `segment: "2"` と `"3"` の 2 行に
   重複して出る。dedupe しないと点が二重描画される。
3. **anchor と currenttrend で x 軸期間が違う。** anchor は当月(Aug 1–31)、
   currenttrend は直近 80 日(May 16–Aug 3)。しかも `ci0`/`ci1` を持つ行は 3 行
   (実質 2 日分)しかない。**重ねる意味がないので別チャートにした**(Pulse 実 UI も
   別カード構成)。依頼文の「期間が違う場合は currenttrend 単独でよい」に該当。
4. **anchor には引ける線がない。** 実データ 2 点(Aug 1, Aug 3)が別 segment に
   属し、間の Aug 2 が欠測なので、segment ごとに見ると連続 2 点がどこにもない。
   spec の layer 名(`isolated-point-value-circle` / `current-value-circle`)が
   示す通り、孤立点と current value マーカーとして描くのが正解。
   線を無理に引くと Pulse と違う絵になる。
5. **`isProjection` は「予測」ではない。** currenttrend の 2 点は
   `trend: "projection"` だが実体はトレンド線の両端(May 16 の $1.5K → Aug 3 の
   $1.8K)。将来日付ではない。破線で結ぶだけでよい。
6. **軸ラベルは自作しない。** `customFormatterMaps` にキー(生値の文字列表現、
   小数 4 桁)→ 表示文字列のマップがある。キーは `v.toFixed(4)` で作れる。
7. `formattedValue` は `"$1.8K (-2.8%)"` の複合文字列。括弧部を分離して符号で
   着色しないと Pulse の見た目にならない。`"(-)"` (比較不能)という値もあるので
   `-` 始まりの長さ 1 は中立色に落とす必要がある。

セキュリティ・埋め込みまわり:

8. **markup の innerHTML 直投入は不可。** `<template>` に入れて inert パースし、
   タグ/属性の allowlist で作り直す。**`<script>` はアンラップするとテキストが
   残る** — 実際このバグを最初のビルドで踏み、ページ内自己テストが検出した
   (`window.__pwned = true;` が本文として表示された)。subtree ごと破棄が要る。
   最終版は自己テストが PASSED(`script` / `img` / `a` / イベントハンドラ属性が
   すべて除去され、allowlist の span だけ残る)。
9. **JSON を `<script type="application/json">` に埋める際は `<` を `\u003c` に
   エスケープ。** JSON の構造文字に `<` は含まれないので全置換して安全。
   `</script>` による早期終了を確実に防げる。

SVG 描画まわり:

10. **SVG に `text-overflow` はない。** 文字幅を推定して自前で省略記号にする
    (12.5px のシステムスタックで 1 文字 ≈ 6.6px と置いた)。`<title>` に全文を
    入れてホバーで読めるようにした。
11. **viewBox 固定 + `width:100%` は文字がボケる。** `clientWidth` を読んで
    再描画する方式にした(resize で rAF デバウンス)。
12. **x 軸 tick が衝突する。** anchor の Aug 1 と Aug 3 は 2 日差で、狭幅では
    ラベルが重なる。active tick を優先して間引く処理を入れた(390px 幅で確認)。
13. spec のマーカーサイズをそのまま使うと潰れる(前述)。

---

## 6. 検証手順と証拠

再現手順(ローカル):

```
python build-prototype.py                 # detail-bundle.json → pulse-html-prototype.html
python -m http.server 8791 --bind 127.0.0.1
# file:// でも動くが、ブラウザ自動化から開くため HTTP で配信した
```

Playwright で確認した項目:

- コンソールエラー 0(favicon の 404 のみ、ページ由来ではない)。
- `performance.getEntriesByType('resource')` が `[]` — **外部リクエスト 0**。
- SVG 8 個、path 13 本、trend チャート内の circle 75 個を描画。
- ホバー: 中央付近で `$579.02 (579.02) on Jun 22` のツールチップが
  `<span data-type="value">` 付きで出る(bundle の `tooltipMarkup` 由来)。
- タブ切替: Sub-Category を選ぶと markup と 8 本のバーが差し替わる。
- サニタイザ自己テスト: PASSED、`window.__pwned === false`、
  出力 HTML は `<span data-type="metric">Metric</span> link<span data-type="entity">Entity</span>`。
- 表示幅 1000px / 390px の両方でレイアウト破綻なし(ラベルのはみ出し・軸ラベル
  衝突は 390px で発見して修正済み)。

未検証:

- 実ホスト(claude.ai 等)の CSP 下での動作。インライン `<style>` / `<script>` を
  使っているので、ホストが `unsafe-inline` を許さない場合は nonce か外部化が要る。
  **この点は iframe を外しても残る制約**であり、MCP Apps 側の CSP を確認する必要がある。
- 他のメトリック定義(通貨以外、running total、custom comparison)での崩れ。
  今回の bundle は `is_running_total: false`, `is_custom_comparison: false` の
  1 ケースのみ。
- 日次以外の粒度(week / month grain)の時系列。
