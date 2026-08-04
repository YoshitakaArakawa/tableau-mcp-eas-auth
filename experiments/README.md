# experiments/

ビルドに組み込まれない探索的プロトタイプの置き場。

`verification/` が「実機で確定した事実の記録」であるのに対し、ここは
**動く成果物そのもの**を残す。将来の実装トラックの出発点として、コード・
生成スクリプト・所見(FINDINGS.md)を 1 ディレクトリで自己完結させる。

| ディレクトリ | 内容 |
|---|---|
| [pulse-html-reproduction/](pulse-html-reproduction/) | Pulse メトリックを iframe なし・単一 HTML で再現するプロトタイプ(CSP でネスト iframe が使えないホスト向けの代替トラック) |

規約:

- 実サイト名・LUID・ホスト名・トークンを含むファイルはコミットしない
  (入力データはディレクトリ内 .gitignore で除外し、FINDINGS.md に再生成手順を書く)
- 本流(`src/`)へ昇格したら、このディレクトリの実装は削除し FINDINGS.md だけ残す
