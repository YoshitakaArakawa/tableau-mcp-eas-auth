# verification/

このフォークで追加した機能の**検証記録**を置くフォルダ。機能ごとにサブフォルダを切り、
「何を・どの環境で・どう確認し・何が事実として確定したか」を残す。検証に使った
ハーネス類はコミットしない(記録内に再現手順の要点だけ書く)。

自動テスト(`npm test`)がモックに依拠している場合、そのモックが本物と同じ挙動をする
という仮定は自動テストでは検証できない。ここに置く記録は、その仮定を実機で潰した証跡である。

## 記録一覧

- [eas-auth/](eas-auth/FINDINGS.md) — EAS 認証(AUTH=eas)で実測確定した Tableau Cloud の挙動
  (aud 形式・well-known 二重参照・loopback 制約・CIMD 等、ドキュメントに無い事実)
- [viz-state/](viz-state/ACCEPTANCE.md) — viz 状態スナップショット機能の手動受け入れ
  (実 viz に対する capture→push 経路の実機検証)
- [chatgpt-connector/](chatgpt-connector/FINDINGS.md) — ChatGPT カスタムコネクタからの接続
  (取得トークンに API スコープが載らず `initialize` が 403 になる件と、その解消条件)
- [site-switching/](site-switching/FINDINGS.md) — サイト切替実験の実測
  (Claude Code の step-up 不発と 401 サイレントリフレッシュ、Tableau Cloud での
  埋め込み認可サーバー拒否)
