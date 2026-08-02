# viz スナップショットから query-datasource へのデータ取得導線

日付: 20260802
ブランチ: worktree-viz-state-query-guidance

## 背景

「MCP Apps 内でユーザーがダッシュボードを操作しながらエージェントと会話する」ユースケースを
3つのループに分解した。

1. 状態の同期(操作 → エージェントが知る) — viz 状態スナップショットで達成済み。
   ChatGPT ホストで full E2E が通ることを実機確認済み
   (verification/chatgpt-connector/FINDINGS.md 項8)
2. データの取得(エージェントが「見えているデータ」を取り直す) — **本 PR の対象**
3. 逆方向の操作(エージェント → viz) — スコープ外(ホストにモデル→ウィジェットの
   チャネルがなく、アドホック分析は別経路に流す方針)

ループ2の欠落: スナップショットの `data` は予算内サンプル(200行・30KB 予算)であり、
サーバー側ツール(get-view-data / query-datasource)はダッシュボードアクションや
マーク選択を知らない。「今見ているデータ」がサンプルを超えた瞬間に取得手段がなかった。

## 変更

- `pushVizState.ts`: preamble に誘導を追加 — `data` はサンプルであること、フルデータは
  `datasources` のデータソースを `query-datasource` で引き、`filters` / `parameters` /
  `selection` をクエリフィルターに翻訳すること
- `captureVizState.ts`: サンプル対象シートの `getDataSourcesAsync()` を読み、
  `datasources: [{name, id}]`(先頭が primary、最大3件)を payload に追加。
  DATASOURCE_QUERY_CAVEAT(シート内計算フィールド・LOD・表計算はデータソースに
  存在しない可能性)を同時に付与
- `vizStateBridge.ts`: ブリッジ単位の datasource キャッシュ(シート名キー)。
  ドキュメントが getDataSourcesAsync の性能影響を警告しているため、成功結果は
  ページ寿命内で再利用。失敗は非キャッシュで次回リトライ
- `payload.ts`: `DatasourceRef` 型、MAX_DATASOURCES=3、削減ラダーの identity-only rung
  でも datasources を保持(データが入らなかったときこそ参照が要るため)
- `embeddingApiTypes.ts`: `TableauDataSource` と `getDataSourcesAsync` を追加
  (phase-0 実測ではなくドキュメント由来である旨を型コメントに明記)

## 設計判断

- **サーバー側状態レジストリ(set-viz-state ツール)は不採用**: MCP サーバーを
  ステートレスに保つ方針(近年の MCP スペックの方向性)と衝突する
- **スナップショットのデータ部をフル化する案(全ページ読み)は不採用**: ホストの
  context 上限は非公開実装値(Claude ホストで約16kトークン・表示時評価・超過で
  ウィジェット恒久死)で、ChatGPT 側は未計測。上限に寄りかかる設計は失敗モードが
  最悪なため、状態は小さく安定に保ち、データは query-datasource 経路へ寄せる
- **preamble に "token" という語を含めない**: リークテストが pushed text 全体を
  /token/i で検査するため(埋め込みクレデンシャル漏洩の証拠として扱う)
- `DataSource.id` が published datasource の LUID と一致するかは**ドキュメントに
  記載がなく未確認**。誘導文には「id が解決しなければ name で list-datasources から
  引き直す」というフォールバックを明記した

## 検証

- 単体テスト: vizState 8ファイル 109/109 通過。datasource 捕捉・キャッシュ・
  失敗時リトライ・上限・ラダー保持・preamble 文言の各テストを追加。
  全体スイートの失敗1件(FeatureGate のパス解決)は main でも失敗する既存問題
- 実機検証: (デプロイ後に追記)

## フォローアップ

- `DataSource.id` の実体(LUID か否か)の実測確定 → verification に記録
- ループ3(エージェント → viz 操作)はホストのチャネル対応待ちで別調査
