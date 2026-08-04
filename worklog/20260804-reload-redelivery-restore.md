# ページリロード後のウィジェット復元 (structuredContent フォールバック)

日付: 20260804
ブランチ: claude/reload-redelivery-restore(claude/tableau-vds-embedding-id の続き)

## 背景

ChatGPT ホストでチャットページをリロードすると、描画済みだった viz ウィジェットが
PARSE_ERROR の切断画面(「The response was not in the expected format.」)に落ちる
事象が報告された。

既存の再配送ガード(worklog/20260802-embed-redelivery-guard.md)は「**描画済みの** viz を
unparseable な再配送から守る」ものであり、リロード後は iframe が白紙から再マウントされる
=未描画のため、設計どおりガードの対象外だった。再発ではなく未カバー経路の顕在化。

## 診断 — ホストがリロード時に何を配るかの実測

iframe のコンソールはホスト外から読めず、product テレメトリも外部エンドポイント無しでは
no-op のため、観測手段を先に実装した:

1. `record-event` ツールの受信内容をサーバーの info ログに出す(`mcpAppEvent` ロガー)
2. PARSE_ERROR の報告に、生の配送物の先頭 700 文字を添える

この計測ビルドで再現した結果、ChatGPT がリロード時に再配送してくる実物は:

```json
{"content":[{"type":"text","text":"{}"}],"structuredContent":{}}
```

**元のツール結果の content ブロックは保存されておらず、保存された structuredContent
(当時は未設定=空)から content が合成されている。** JSON.parse は成功し、`url` 必須の
スキーマ検証で落ちる——観測されたエラーと完全に一致する。

## 変更内容

- `renderInteractiveViz` / `renderPulseMetric`: ツール結果に `structuredContent`(ペイロードの
  ミラー)を追加。content[0] の生 JSON は従来どおり(バイト単位で不変)
- `handleToolResult` / `handlePulseToolResult`: content 経由の parse に失敗したら
  `structuredContent` を同じスキーマで parse するフォールバックを追加。両方失敗した場合は
  従来どおり content 側のエラーで PARSE_ERROR
- `record-event`: 受信イベントを info ログに出す(恒久化。アプリ内障害の唯一の
  サーバー側可視化手段のため)
- PARSE_ERROR / PARSE_ERROR_IGNORED の報告に配送物の先頭サンプルを添付
  (render 配送物は URL + identity のみで秘匿値を含まない)

## 設計判断

- **widget state API は使わない**: ext-apps に永続化 API が無いことを確認
  (`onteardown` はアプリ自前の保存手段を前提とする)。ホストが実際に永続化している
  チャネル(structuredContent)に載せるのが最小で確実
- **content[0] は不変のまま**: iframe の既存 parse 経路・過去バージョンとの互換を維持。
  structuredContent は MCP 仕様上も「content に直列化等価物を持つ」ことが推奨されており、
  本実装はその形(content[0] = JSON.stringify(result))に一致する
- **旧チャットは直らない**: 修正前に描画されたチャットの保存済み structuredContent は
  空のままなので、リロードで従来どおり PARSE_ERROR になる。これは受け入れる
  (新規描画から先が直る)

## 検証

- 単体テスト: リロード形状(合成 content + structuredContent あり/空)の回帰を viz / Pulse
  両方に追加。計 57 件通過、build 成功
- 実機(ChatGPT ホスト): 修正ビルドで新規チャットに Superstore Overview を描画 →
  ページリロード → **viz が復元されることを確認**(エラー UI なし、サーバーログにも
  PARSE_ERROR なし)。修正前ビルドでは同手順で PARSE_ERROR を再現済み
- 実測した配送物はサーバーログ(mcpAppEvent)に記録が残る

## フォローアップ

- Pulse 側のリロード復元は同型の修正を入れたが実機未検証(viz 側と同一経路)
- claude.ai ホストは iframe 描画自体が CSP でブロックされており、この経路の実機確認は不可
- 旧チャットの救済(structuredContent が空の配送に対する「再表示を依頼してください」の
  案内表示など)は未実装。頻度を見て判断
