---
name: agent-ready-repo
description: リポジトリを Claude Code に渡せる形に整える。AGENTS.md / CLAUDE.md の書きかた、パスごとに効く .claude/rules、頻用手順を固めた slash command、Stop フック、permissions の allow/ask/deny、サブエージェントを勝手に撒かせない取り決め。コーディングエージェントと一緒に開発するとき、指示が守られないとき、設定を整えるときに読む。CLAUDE.md, AGENTS.md, claude code settings, hooks, slash commands, subagent, permissions.
---

# リポジトリをエージェントに渡せる形にする

**書いていないことは守られない。書きすぎたものも守られない。**
効いたのは、短い `AGENTS.md` + パスごとに効く細則 + 機械の見張り、の 3 点セット。

```text
CLAUDE.md          → @AGENTS.md と書くだけ (1 行)
AGENTS.md          → 全体の取り決め。**短く**
.claude/rules/*.md → paths: で効く範囲を絞った細則
.claude/commands/  → 頻用手順 (/verify, /sync)
.claude/agents/    → 読むだけのサブエージェント
.claude/hooks/     → 応答の終わりの機械の見張り
.claude/settings.json → permissions と hooks
```

## `CLAUDE.md` は 1 行にする

```md
@AGENTS.md
```

エージェントごとに別の文書を置くと、片方だけ古くなる。

## `AGENTS.md` に書くこと

骨は `assets/AGENTS.template.md`。**節はこの 6 つで足りた。**

1. **このリポジトリは何か** (3 行。成果物の形と、中核の言語)
2. **変更したら回すもの** (コマンドをそのまま貼る)
3. **進め方** (ブランチ → PR → CI 緑 → main)
4. **守っていること** (禁止事項。なぜ禁止かを 1 行添える)
5. **レビューの回し方** (何を勝手にやってよくて、何を断ってからやるか)
6. **文書と仕様を実態から離さない** (同じ PR で直すものの一覧)

### 効いた書きかた

**禁止に理由を添える。** 理由の無い禁止は、次のセッションで「より良い方法」に
置き換えられる。

```md
- **HTML の文字列を組み立てない。** 文字は必ず `textContent` に入れる。
  `innerHTML` は使わない (.claude/rules/frontend.md)
```

**自分が踏んだ穴を、踏んだ事実ごと書く。**

```md
`npm run check` の出力を `grep` で絞りすぎない。Prettier の `[warn]` 行を
見落として、失敗を成功と読み違えたことがある。`tail` で見ること。
```

**回す順に、コピーできる形で並べる。** 説明より効く。

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix web run check
cargo xtask build
cd e2e && npx playwright test
./scripts/check-sync.sh
```

**重い層は「触ったときだけ」と明示する。** 書かないと毎回回すか、一度も
回さないかのどちらかになる。

## `.claude/rules/` — パスで効く細則

`AGENTS.md` を長くするより、**触ったファイルのときだけ出る**細則にする。

```md
---
paths:
  - "web/src/**"
---

# 画面のきまり
...
```

置いてよかったもの:

| ファイル | 中身 |
|---|---|
| `frontend.md` | 再描画の作法、`innerHTML` 禁止、保存の失敗を捨てない |
| `abi.md` | 3 か所が同時に動く境界。区画を足すときの手順 |
| `permissions.md` | 権限を触るなら仕様も動かす。**過去に見つかった穴の一覧** |
| `verification.md` | 検証の段を下げない |
| `e2e.md` | `file://` のまま回す理由。書きかたの約束 |

**「過去に見つかった穴」の節がいちばん効く。** 新しい操作を足すときに
「この形に当てはまらないか」を考えさせられる。

## `.claude/commands/` — 手順を固める

`/verify` と `/sync` の 2 つで足りた。

- `$ARGUMENTS` で重い層を切り替える (`/verify formal`、`/sync deep`)
- **落ちたときにどうするかを書く。**
  「落ちたものがあれば、何が落ちたかを**出力ごと**報告する。『たぶんこれが
  原因』で済ませず、実際に確かめてから直す」
- **直す向きを書く。** 「実態に合わせるのが既定。ただし実装が仕様から外れた
  場合は実装のほうを直す (仕様を実装に合わせると、仕様が番人でなくなる)」

## 重いレビューを勝手に始めさせない

これを書いておかないと、毎回サブエージェントが撒かれて費用が読めなくなる。

```md
| | いつ | 誰が |
|---|---|---|
| `./scripts/check-sync.sh` | 応答の終わりに自動 + CI | 機械。モデルを使わない |
| `cargo test` などの一式 | 変更のたび | 機械 |
| ミューテーションテスト | 毎日 03:00 + 手動 | CI |
| **`/code-review`、サブエージェント、`Workflow`** | **求められたときだけ** | 要相談 |

**こちらから勝手に始めない。** レビューしたほうがよいと思ったら、
何をどれくらいの規模で回すかを 1 行で伝えて、返事を待つ。
利用者が「レビューして」と言ったとき、使ってよいか迷うなら、それは
使ってよいということ。
```

最後の 2 行が要る。無いと、頼まれているのに毎回確認してくる。

## `settings.json`

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(cargo test:*)", "Bash(npm --prefix web run:*)", "..."],
    "ask":   ["Bash(gh pr merge:*)", "Bash(gh release create:*)", "Bash(git push:*)"],
    "deny":  ["Bash(git push --force:*)", "Read(./.env)", "Read(./.env.*)"]
  }
}
```

- **`allow` は「検査のコマンド」。** 毎回聞かれると検証を省くようになる
- **`ask` は「外に出るもの」。** merge / release / push
- **`deny` は「取り返しのつかないもの」と「秘密」。** force push と `.env`

## 「設定そのものを直してよい」と書く

これを書き忘れると、**気づいたことがあっても設定に反映されない**。
`AGENTS.md` に 1 節置く。

```md
### 設定そのものも直してよい

この文書・`.claude/` の中身・`dev-skills/` は、必要なら同じ変更のなかで
書き換えてよい。むしろ、そうしないと昇格の段 2 と 4 が回らない。

- 同じ注意を 2 度されたなら、それはここか `.claude/rules/` に書くべきこと
- 「この手順は毎回やる」と思ったなら `.claude/commands/` に置く
- 設定を変えたら、変えた理由を日誌に 1 行残す
```

昇格の段そのものは [dev-journal](../dev-journal/)。

## フックは黙っているのが基本

Stop フックで機械の検査を回す。**ずれが無ければ何も言わない**。
止めずに `additionalContext` だけ出す。詳しくは
[docs-spec-drift](../docs-spec-drift/)。

フックは 1 つの `Stop` に並べて足せる (ずれの検査と、未昇格の知見の数)。
**どれも黙っているのが既定**でないと、数が増えた時点で全部読み飛ばされる。

## 貯めた設定が腐らないようにする

取り決めは増える。増えること自体は良い。困るのは**壊れても何も起きない**こと。

| 壊れかた | 起きること |
|---|---|
| フックの指し先が消えた / 実行権が無い | 黙って何もしない |
| `rules` の `paths:` に当たるファイルが 1 つも無い | 触っても出てこない |
| `agent` の `name` がファイル名とずれた | 呼べない |
| `permissions` が名指しするスクリプトの名前が変わった | 許可が外れ、毎回聞かれる → **検証を省くようになる** |
| `command` が名指しするスクリプトが消えた | 実行して初めて分かる |

どれも「読めば分かる食い違い」なので、`check-sync.sh` に入れる
([docs-spec-drift](../docs-spec-drift/))。**設定を足したら回す。**

```sh
# フックの指し先と実行権
while read -r command; do
  script="${command/\$\{CLAUDE_PROJECT_DIR\}\//}"
  [ -f "$script" ] || bad "フックが指す $script がありません"
  [ -x "$script" ] || bad "$script に実行権がありません"
done < <(grep -oP '"command":\s*"\K[^"]+' .claude/settings.json)

# 当たるファイルの無い rules
shopt -s globstar nullglob
matches=($pattern)
[ ${#matches[@]} -eq 0 ] && bad "paths: \"$pattern\" に当たるものがありません"
```

## Dev Container で「手元」を固定する

口伝だったものを全部 `.devcontainer/` に入れて、**CI でその箱を組んで
同じ筋書きを回す** ([ci-quality-gates](../ci-quality-gates/))。
エージェントが「入っていない道具」で詰まることが減る。

`postCreateCommand` で依存取得とブラウザの導入まで済ませ、最後に
**次に打つコマンドを表示する**。

## 関連

- ずれの見張り → [docs-spec-drift](../docs-spec-drift/)
- 知見の貯めかた → [dev-journal](../dev-journal/)
