# Pulse ウィジェット AUTH_ERROR の原因種別を計測に追加

日付: 20260804
ブランチ: claude/pulse-auth-error-cause(main(f2a30b80)から分岐)

## 背景

ChatGPT ホストでの実機検証(20260804)で、同一チャットに viz と Pulse の両ウィジェットが
ある状態でページをリロードすると、**Pulse 側だけ** AUTH_ERROR
(「Authentication was unsuccessful.」)になる事象を確認した。Pulse 単独チャットでは
リロード後の復元に成功しており、viz+Pulse 同時再マウント時のみ発生する。

仮説(未確認): embed セッション Cookie が viz と Pulse の再マウント順序次第で競合している
のではないか。本 PR はこの仮説を検証するためのものではなく、**原因を確定させるための
計測を先に入れる**もの。挙動は変えない。

サーバー側には `record-event` ツール経由で `mcpAppEvent: AUTH_ERROR` のログ行が残る
(`worklog/20260804-reload-redelivery-restore.md` で恒久化済み)が、AUTH_ERROR に至る
経路が複数あるにもかかわらず、どの経路かを示す情報が載っていなかった。

### AUTH_ERROR に至る 3 経路(修正前はすべて無区別)

Pulse 側(`src/web/apps/src/pulse/`):

1. embed トークンの取得(minting)失敗 — `handlePulseToolResult.ts` の
   `callGetEmbedTokenTool(app, 'pulse')` が throw
2. `<tableau-pulse>` の `pulseerror` イベントで `_httpStatus` が 401/403 —
   `embedTableauPulse.ts` の `onAuthError` 呼び出し
3. `pulseurlchanged` の `_context === 'session-expired'` — 同ファイルの別リスナー

viz 側(`src/web/apps/src/embed/`)にも同型の 2 経路があり、同じく無区別だった:

1. embed トークンの取得失敗 — `handleToolResult.ts` の `callGetEmbedTokenTool(app)`
2. `<tableau-viz>` の `vizloaderror` イベント — `embedTableauViz.ts` の `onError` 呼び出し
   (viz 側にはランタイムエラー用の別コールバックが元々無く、`vizloaderror` は常に
   AUTH_ERROR 扱いになっていた)

## 変更内容

**挙動は変えていない。cause 文字列を telemetry の message として流すだけ。**

- `src/web/apps/src/pulse/embedTableauPulse.ts`
  - `onAuthError` のシグネチャを `() => void` から `(cause: string) => void` に変更
  - `pulseerror` 経由: `` `pulseerror status=${status}` ``
  - `pulseurlchanged` (session-expired) 経由: `'session-expired navigation'`
- `src/web/apps/src/pulse/handlePulseToolResult.ts`
  - minting 失敗: `showError('AUTH_ERROR', e, app)` を
    `` `mint failed: ${e.message}` `` に変更(3 経路がそれぞれ異なる prefix を持つよう統一)
  - `onAuthError` で受け取った cause をそのまま `showError('AUTH_ERROR', cause, app)` に渡す
- `src/web/apps/src/embed/embedTableauViz.ts`
  - `onError` のシグネチャを `() => void` から `(cause: string) => void` に変更
  - `vizloaderror` イベントの `detail` からベストエフォートで文字列化する
    `describeVizLoadError` を追加。`detail.message` があればそれを使い、無ければ
    `detail` 全体を JSON 化(200 文字まで)。**`detail` の形は未検証
    (コード内コメントに既存の注記あり)なので、確定した構造として扱わずベストエフォートに
    留めた**
- `src/web/apps/src/embed/handleToolResult.ts`
  - Pulse 側と同じ prefix 規約(`mint failed: ...` / `onError` の cause をそのまま転送)
- `src/web/apps/src/shared/showError.ts` / `recordEventClient.ts` は変更なし
  (cause は `showError(scenario, cause, app)` → `recordEvent(app, scenario, cause)` →
  `record-event` ツールの `message` 引数まで既にそのまま流れる経路だった)

## 設計判断

- **viz 側も同時に直した**: 依頼は Pulse 起点だが、viz 側の `onError` も同型の
  無区別コールバックだったため、片方だけ直すと今回の viz+Pulse 同時再マウント調査で
  viz 側のログが引き続き読めない。両方同じ prefix 規約に揃えた
- **prefix 文字列は自由記述**: `record-event` の `message` は自由記述フィールド
  (`src/tools/web/recordEvent/recordEvent.ts` 参照、1024 文字で truncate)であり、
  構造化 enum にはしていない。原因種別が 3〜4 通りしかなく、今回は原因の切り分けが
  目的であって集計ダッシュボードの列にする予定がないため、可読な自由文字列で十分と判断
- **vizloaderror の detail 形は仮定しない**: 同イベントは「assumed DOM event」であり
  実測未確認(`embedTableauViz.ts` の既存コメント)。`detail.message` を決め打ちで
  読みにいくのではなく、無ければ JSON 化してベストエフォートで拾う実装にした

## 検証

- `npx vitest run src/web/apps/src`: 311 件全通過(新規・更新ケースを含む)
  - `embedTableauPulse.test.ts`: `pulseerror status=401` / `session-expired navigation`
    がそれぞれ `onAuthError` に渡ることを確認
  - `handlePulseToolResult.test.ts`: minting 失敗時の `mint failed: not available`、
    ランタイム auth エラー時の cause がそれぞれ `recordEvent` まで届くことを確認
  - `embedTableauViz.test.ts` / `handleToolResult.test.ts`: `vizloaderror` の
    `detail.message` あり/なし/`detail` なしの 3 パターンで cause の組み立てを確認
- `npm run lint`: エラーなし
- 実機(ChatGPT ホスト)での再現・原因確定は未実施(Follow-ups)

## Follow-ups

- 本 PR はデプロイしない。デプロイ後、ChatGPT ホストで viz+Pulse 同時チャットの
  リロードを再現し、サーバーログの `mcpAppEvent: AUTH_ERROR` に載る cause
  (`pulseerror status=...` / `session-expired navigation` / `mint failed: ...`)
  から実際の経路を特定する
- 経路が判明した場合、embed セッション Cookie 競合仮説の裏取り、および恒久修正の要否を
  判断する
- viz 側 `vizloaderror` の `detail` 実形状が実機で分かれば、
  `describeVizLoadError` を仮定ベースから実測ベースの型に直す
