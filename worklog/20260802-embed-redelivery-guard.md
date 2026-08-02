# 非描画ツール結果の再配送からマウント済み viz を守る

日付: 20260802
ブランチ: worktree-embed-redelivery-guard

## 背景

ChatGPT ホストでの実機検証([FINDINGS 項11](../verification/chatgpt-connector/FINDINGS.md))で、
分析ターン中に複数ビューのデータ取得(get-view-data)が走った際、表示中の App ウィジェットが
「Unable to load this Tableau view / The response was not in the expected format」
(PARSE_ERROR 画面)に置き換わる事象を観測した。

原因は App 側の想定不足。ホストは描画ツール(get-view / get-workbook)以外のツール結果も
同一ウィジェットへ再配送することがあり、`handleToolResult` は空でない unparseable な配送を
一律 PARSE_ERROR として扱い、ユーザーが操作中の viz をエラー画面で上書きしていた。
空配送(`content: []`)の no-op ガードは既にあったが、CSV 等の「中身はあるが描画ペイロード
ではない」配送には無防備だった。FINDINGS 項12 でも「堅牢化修正が別途進行中」として本修正を
参照している。

## 変更

- `src/web/apps/src/embed/handleToolResult.ts`
  - `isVizMounted()` を追加: コンテナ内に `tableau-viz` 要素が存在するかの DOM 判定
  - parse 失敗時、viz マウント済みなら `console.warn` + `recordEvent('PARSE_ERROR_IGNORED')`
    のみで無視し、viz を維持する。PARSE_ERROR 画面は未マウント時のみ表示
- `src/web/apps/src/embed/handleToolResult.test.ts` にテスト2件追加
  - 初回配送が unparseable(なにも描画されていない)→ 従来どおり PARSE_ERROR 画面
  - 正常描画後に unparseable 再配送 → viz 維持・エラー画面なし・再 embed なし・
    `PARSE_ERROR_IGNORED` のみ記録

## 設計判断

- **マウント判定は DOM(採用)vs module-level フラグ(不採用)**: embed 成功後に
  ランタイム AUTH_ERROR 等でエラー画面へ置換された状態を module フラグは追跡できず
  「マウント済み」と嘘をつく。DOM 判定なら、エラー画面表示中の parse 失敗は再び
  PARSE_ERROR を表示でき、実態と常に一致する
- **テレメトリのイベント名は `PARSE_ERROR_IGNORED` を新設**: 初回描画の失敗
  (ユーザー影響あり)と抑止済み再配送(影響なし)を集計で区別するため。record-event
  ツールの schema は SCREAMING_SNAKE_CASE の任意名を受けるためサーバー側変更は不要
- **再配送ペイロードの内容検査(get-view-data らしさの判定)は不採用**: ホストの
  再配送仕様が非公開で、来うるペイロードを列挙できない。「描画済みなら描画ペイロード
  以外は全部無視」が最小かつ安全
- **parse に成功した再配送まで無視する案は不採用**: 同一ウィジェットで別ビューを
  描画し直す正当な配送を殺すため、parse 成功時は従来どおり再 embed する

## 検証

- 単体テスト: `handleToolResult.test.ts` 21件通過(新規2件を含む)。
  `src/web/apps/src` 全体 19ファイル 221件通過。eslint エラーなし
- 実機検証: **未実施**。iframe 資産はイメージに焼き込まれるため、再デプロイ後に
  FINDINGS 項11 の経路(分析ターン中の複数ビューのデータ取得)で再現確認する

## フォローアップ

- 再デプロイ後の実機確認と FINDINGS への追記(項11 の「別修正として必要」の閉塞)
- `PARSE_ERROR_IGNORED` の発生頻度をテレメトリで観察し、ホストの再配送挙動の
  変化(頻度・ペイロード種別)を把握する
