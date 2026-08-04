# 20260804 — リポジトリ名変更(tableau-mcp-eas-auth → tableau-mcp-apps-lab)

## 背景

このリポジトリは当初 `AUTH=eas`(EAS 認証モード)の検証を目的に作られたが、実際の作業は
MCP Apps 機能の強化(viz 状態スナップショット、Pulse メトリック埋め込み、embed token の
サーバー署名・スコープ調整)が中心になっている。EAS は「per-user 埋め込みを成立させる手段」に
位置づけが下がったため、リポジトリ名と自己紹介を実態に合わせた。

## 変更

- GitHub リポジトリ名: `tableau-mcp-eas-auth` → `tableau-mcp-apps-lab`(GitHub 上で rename 済み)
- リポジトリ description を MCP Apps 強化フォークとして書き換え
- README のタイトルと冒頭を書き換え。フォークの追加機能3点(EAS 認証モード / Viz 状態
  スナップショット / Pulse メトリック埋め込み)を列挙する構成にし、EAS の説明は新設の
  「EAS 認証モード」節へ移動(本文は変更なし)

## 設計判断

- 名前は `tableau-mcp-apps-lab` を採用。`-lab` で実験的フォークであることを名前で伝える。
  `tableau-mcp-apps` は公式プロダクトに見えるリスクがあるため不採用。
  `tableau-mcp-embed` は Pulse・ツール強化を含む実態より狭いため不採用
- デプロイ先アプリの名前は変更しない。アプリ名を変えると公開 URL が変わり、Tableau サイトに
  登録済みの EAS issuer URL と MCP クライアント側の接続設定が両方壊れるため。
  リポジトリ名とアプリ名の不一致は無害

## 影響の確認

- リポジトリ内ファイルに旧リポ名 `tableau-mcp-eas-auth` への参照は存在しない
  (gitignore 済みファイルを含め ripgrep で全走査、ヒット 0 件)
- GitHub の rename は旧 URL から新 URL へ自動リダイレクトされる(同名の新リポジトリを
  作らない限り有効)。Star / Issue / PR / Release は保持される
- このリポジトリは GitHub 上の fork 関係を持たない独立リポジトリのため、fork ネットワークへの
  影響はない
- ローカルの `origin` remote は `gh repo rename` が自動更新済み

## フォローアップ

- なし
