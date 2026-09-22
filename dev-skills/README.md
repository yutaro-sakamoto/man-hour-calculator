# dev-skills — 趣味の Web アプリ開発で貯めた型

[man-hour-calculator](https://github.com/yutaro-sakamoto/man-hour-calculator)
を 1 人で作ったときに効いたやり方を、**次の開発でそのまま呼び出せる形**に
落としたもの。Claude Code の Skill として読ませる。

このフォルダは **このリポジトリの `.claude/` とは無関係**。ここにあるのは
「次のリポジトリに持っていく道具」で、今のリポジトリの設定は変えない。

## 何があるか

| スキル | いつ呼ぶか |
|---|---|
| [personal-app-playbook](personal-app-playbook/) | **入口。** 新しく個人開発を始めるとき。ここから他へ散る |
| [single-file-web-app](single-file-web-app/) | 「ダウンロードして開くだけで動く」1 枚 HTML を作るとき |
| [one-core-three-targets](one-core-three-targets/) | ローカル版・サーバ版・クラウド版を 1 つのコードで賄うとき |
| [verification-ladder](verification-ladder/) | テストをどこまでやるか決めるとき。形式手法の入れどころ |
| [ci-quality-gates](ci-quality-gates/) | CI を組むとき。何をどの順で並べるか |
| [release-supply-chain](release-supply-chain/) | 配布物を出すとき。クロスプラットフォーム・SBOM・SLSA |
| [docs-spec-drift](docs-spec-drift/) | 文書・仕様・コードのずれを機械で見張るとき |
| [agent-ready-repo](agent-ready-repo/) | リポジトリを Claude Code に渡せる形に整えるとき |
| [secure-defaults](secure-defaults/) | 認証・XSS・依存・CORS まわりを決めるとき |
| [observable-server](observable-server/) | サーバの死活監視・ログ・停止のしかたを決めるとき |
| [ux-and-feedback](ux-and-feedback/) | 画面の作り、初回体験、フィードバック導線 |
| [dev-journal](dev-journal/) | **知見を貯める仕組みそのもの。** 踏んだ穴を次に持ち越す |

## 使い方

Claude Code に読ませるには、`~/.claude/skills/` か、対象リポジトリの
`.claude/skills/` に置く。中身をコピーするより、**1 か所に置いて貼る**ほうが
直したときに全部に効く。

```sh
# 個人の全リポジトリで使う
ln -s "$PWD/dev-skills"/* ~/.claude/skills/

# 1 つのリポジトリでだけ使う
mkdir -p ../other-project/.claude/skills
ln -s "$PWD/dev-skills/single-file-web-app" ../other-project/.claude/skills/
```

`assets/` の中身は**テンプレート**。そのままでは動かない箇所を `<<< >>>` で
囲ってある。シェルスクリプトだけは `@@NAME@@` — `<<<` が bash の here-string に
なってしまうため。

## 書きかたの約束

- 日本語で書く。コメントも同じ
- **「何をするか」より「なぜそうなっているか」**。とくに、素直にやると壊れる理由
- 実際に踏んだ穴は、踏んだ事実ごと書く。「〜に注意」ではなく
  「〜で 2 時間溶かした」と書いたほうが次に効く
- 手順を書いたら、**その手順が守られているかを機械で見る方法**もセットで書く。
  見張りの無い決めごとは 3 週間で死ぬ
