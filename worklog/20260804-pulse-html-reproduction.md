# Pulse メトリックの iframe なし HTML 再現(実験トラック)

日付: 20260804
関連文書: [experiments/pulse-html-reproduction/FINDINGS.md](../experiments/pulse-html-reproduction/FINDINGS.md)、
[worklog/20260803-pulse-embed-app.md](20260803-pulse-embed-app.md)(iframe 版の設計判断)

## 背景

`render-pulse-metric` は `<tableau-pulse>`(Embedding API)を iframe で描画する。
この経路はホストの CSP がネスト iframe を許可しない環境(claude.ai が該当。
anthropics/claude-ai-mcp Issue #40)では動かない。iframe 版の worklog は
「自前 HTML 案は却下ではなく別トラックに分離」と記録しており、本 PR はその
別トラックの最初の成果物である。

iframe 案を採った当時の前提は「Pulse の価値の大半(インサイト文・時系列の
見せ方)は Tableau 側の生成物で、REST では再現できない」だった。今回
insight bundle (detail) を実測したところ、この前提は崩れた:

- 全 28 インサイトに Vega-Lite v5 スペックが付属し、**描画データがインライン**
  (時系列 82 点、期待レンジ帯付き 33 点、次元別ブレークダウン)
- インサイト文は HTML markup として、フォーマット済み値・期間ラベル・
  sentiment・色定義まで bundle 内にある

つまり自前 HTML は「別物を作る」のではなく「同じ素材を別レンダラーで描く」
問題に変わった。

## 変更内容

- `experiments/README.md`(新規): 実験トラック置き場の規約
- `experiments/pulse-html-reproduction/`(新規):
  - `pulse-html-prototype.html` — 単一ファイル 64.4 KB、外部リクエスト 0、
    手書き SVG 8 枚で detail ビューを再現(BAN / 時系列 / 期待レンジ帯 /
    ブレークダウン 5 次元 / フォローアップ / インサイト文)
  - `build-prototype.py` — insight bundle JSON からの生成スクリプト
  - `FINDINGS.md` — 再現できた要素 / できなかった要素 / サイズ実測 /
    ハマりどころ 13 件の記録
  - `.gitignore` — 入力 bundle(サイト固有 ID を含みうる)を除外

`src/` には触れていない。ビルド・テスト・既存ツールへの影響はない。

## 設計判断

### 手書き SVG(Vega-Lite 非同梱)

bundle のスペックは Vega-Lite v5 だが、外部リソース禁止の制約下で
vega + vega-lite + vega-embed をインラインすると実測 808 KB
(jsdelivr の Content-Length を HEAD で実測)。スペック分を足すと
**合計約 900 KB で、手書き SVG 版(64 KB)の約 14 倍**になる。
MCP Apps は HTML を MCP レスポンスに載せるため生バイト数がそのまま
転送・トークンコストになり、この差は許容できない。

実測では Pulse の viz は「時系列」「帯付き時系列」「横棒(正/負)」の
3 型しかなく、28 インサイト全部がこの 3 型に収まった。汎用レンダラーを
捨てても描画コードは 3 種で済む。

### experiments/ という置き場

`verification/` は「事実の記録」でありハーネスは git-ignored が規約。
本トラックは**動くプロトタイプ自体が次の作業のベース**なので、記録と
成果物を分離せず 1 ディレクトリで自己完結させる新しい置き場を作った。
本流へ昇格したら実装は削除し FINDINGS.md だけ残す。

## 検証

- Playwright でローカル HTTP 配信して確認: コンソールエラー 0、
  `performance.getEntriesByType('resource')` が空(外部リクエスト 0)、
  SVG 8 個・path 13 本・circle 75 個を描画、ツールチップ・タブ切替動作、
  1000px / 390px の両幅でレイアウト破綻なし
- markup サニタイザの自己テストを HTML 内に同梱し PASSED
  (初回ビルドで `<script>` アンラップ時に中身がテキストとして残る実バグを
  自己テストが検出 → subtree ごと破棄に修正)
- コミット物に UUID・ホスト名・絶対パスが無いことを grep で確認
- 詳細は [FINDINGS.md](../experiments/pulse-html-reproduction/FINDINGS.md)

## Follow-ups

- **ホスト CSP の実値確認**。インライン `<style>`/`<script>` を使うため、
  ホストが `unsafe-inline` を許さない場合は iframe を外しても動かない。
  MCP Apps ホストの CSP を確認してから本実装の設計を決める
- サーバー側ツール化の設計: bundle 取得 → データ抽出 → HTML 生成を
  サーバーで行い、`render-pulse-metric` の layout 追加(`html`)にするか
  別ツールにするかの判断
- 他ケースでの崩れ確認: running total、custom comparison、週次/月次粒度、
  通貨以外のフォーマット
- followup 全 21 件の埋め込み可否(+10 KB 程度)と score によるランキング表示
