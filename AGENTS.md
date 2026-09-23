# このリポジトリで作業するとき

3 点見積もりから工数の分布と完了日を出す道具。**成果物は 1 枚の HTML** で、
計算コアは Rust を WebAssembly にしたもの。同じロジックがサーバ版でも動く。

詳しい背景は [README_JP.md](README_JP.md)。検証の対応表は
[docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 変更したら回すもの

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix web run check          # 整形 / lint / 型 / 単体テスト
cargo xtask build                   # → dist/app.html, dist/index.html
cd e2e && npx playwright test       # file:// で開いて通しで確かめる
./scripts/check-sync.sh             # 文書・仕様・コードのずれ
```

形式手法の層は重いので、**その層を触ったときだけ**回す。

```sh
cargo kani --workspace                                    # 約 45 秒
MIRIFLAGS=-Zmiri-strict-provenance cargo +nightly miri test -p mhc-wasm
./spec/check.sh                                           # TLC
```

`npm run check` の出力を `grep` で絞りすぎない。Prettier の `[warn]` 行を
見落として、失敗を成功と読み違えたことがある。`tail` で見ること。

## 進め方

作業ブランチ → PR → CI 緑 → main。`main` に直接 push しない。

```sh
git switch -c feat/<何をするか>
gh pr create --title … --body …
gh run watch <id> --exit-status
gh pr merge <n> --merge --delete-branch
```

不具合を直すときは、**直す前の実装では落ちる回帰テストを添える**。
添えたら、ガードを外して実際に赤くなることを確かめる。落ちないテストは
回帰テストではない。

## 守っていること

- **1 枚の HTML で、外部へ 1 件も通信しない。** E2E が見張っている。
  外部のアイコン・フォント・画像を足さない。`fetch()` を増やさない
- **HTML の文字列を組み立てない。** 文字は必ず `textContent` に入れる。
  `innerHTML` は使わない ([.claude/rules/frontend.md](.claude/rules/frontend.md))
- **保存先は全部、同じ約束を守る。** 検査は
  [crates/api/src/store/conformance.rs](crates/api/src/store/conformance.rs) に
  1 組だけ置き、実装ごとに当てる。`Store` を実装するものを増やすときは、
  **書く前にこれを通す**
- **権限の判定は `crates/api` の 1 か所だけ。** ローカル (WASM) でもサーバでも
  同じコードが動く。画面側の出し分けは見た目の話でしかない
- **Rust の依存クレートはゼロ**（`crates/core` と `crates/api`）。
  サーバだけが外のクレートを使う
- `#![forbid(unsafe_code)]`。`unsafe` は `crates/wasm` の FFI 層だけ
- **複雑度の上限とカバレッジの基準は上げ下げで逃げない。** 複雑度に
  引っかかったら関数を割る。カバレッジが割ったらテストを足す
  (`./scripts/complexity.sh` / `./scripts/coverage.sh`)

## レビューの回し方

**軽いものは黙って回す。重いものは断ってから。**

| | いつ | 誰が |
|---|---|---|
| `./scripts/check-sync.sh` | 応答の終わりに自動 + CI | 機械。モデルを使わない |
| 未昇格の知見の数 | 応答の終わりに自動 (溜まったときだけ) | 機械。モデルを使わない |
| `cargo test` などの一式 | 変更のたび | 機械 |
| ミューテーションテスト | 毎日 03:00 (JST) + 手動 | CI |
| **`/code-review`、サブエージェントを撒くレビュー、`ultracode`、`Workflow`** | **利用者が求めたとき、または許しを得たときだけ** | 要相談 |

最後の行は守ること。**こちらから勝手に始めない。** レビューしたほうがよいと
思ったら、何をどれくらいの規模で回すかを 1 行で伝えて、返事を待つ。
利用者が「レビューして」と言ったとき、`/code-review` を使ってよいか迷うなら、
それは使ってよいということ。

## 文書と仕様を実態から離さない

この 3 つは、コードを変えたら**同じ PR のなかで**直す。

- [docs/VERIFICATION.md](docs/VERIFICATION.md) — どの約束を、どの強さで、
  どこで確かめているかの対応表。Kani のハーネスを足したらここにも書く
- [spec/Permissions.tla](spec/Permissions.tla) — 権限の設計。実装に番人を
  足したら、仕様の同じ場所にも足す。**書き写し忘れると TLC がそこを突く**
- [docs/ABI.md](docs/ABI.md) — JS ↔ WASM の取り決め。Rust と TypeScript と
  この文書で、同じ版を名乗っていること

機械で見つかるぶんは `./scripts/check-sync.sh` が見ている。見つからない
ぶん（説明が古い、例が動かない、表が実態と違う）は人の目が要る。

## 学んだことを持ち越す

踏んだ穴・読み違い・設計の判断は [docs/JOURNAL.md](docs/JOURNAL.md) に書く。
`/learn` で雛形が出る。ふつうのバグは書かない — **回帰テストを添えれば、
テストのほうが記録になる。**

**書くだけでは効かない。昇格させる。**

| 段 | 形 | いつ上げるか |
|---|---|---|
| 1 | 日誌に 1 件 | 踏んだその日 |
| 2 | `.claude/rules/` / `.claude/commands/` / `.claude/agents/` / この文書 | **2 回目に踏んだら** |
| 3 | **機械の検査** (テスト / `scripts/check-sync.sh`) | 3 回目、または重いとき |
| 4 | [dev-skills/](dev-skills/) | **別のプロジェクトでも役に立つとき** |

段 3 に上がったものだけが本当に守られる。迷ったら「この決めごとを破った
コードは `grep` で見つかるか」を考える。見つかるなら `scripts/check-sync.sh`
に足して、**わざと破って赤くなることを確かめる**。

### 昇格は雛形から始める

段 2 と段 4 の行き先は、それぞれ frontmatter の形が違う。思い出さなくていい。

```sh
./scripts/journal.sh promote rules <名前>      # .claude/rules/<名前>.md
./scripts/journal.sh promote command <名前>    # .claude/commands/<名前>.md
./scripts/journal.sh promote agent <名前>      # .claude/agents/<名前>.md
./scripts/journal.sh promote skill <名前>      # dev-skills/<名前>/SKILL.md
```

書きかたは [.claude/rules/claude-config.md](.claude/rules/claude-config.md)
(取り決めそのもの) と [.claude/rules/skills.md](.claude/rules/skills.md)
(次に持っていくもの)。

### 設定そのものも直してよい

この文書・`.claude/` の中身・`dev-skills/` は、**必要なら同じ変更のなかで
書き換えてよい**。むしろ、そうしないと段 2 と 4 が回らない。

- 同じ注意を 2 度されたなら、それは `.claude/rules/` に書くべきこと。
  `AGENTS.md` は短く保ち、**範囲を絞れるものは rules へ**
- 「この手順は毎回やる」と思ったなら `.claude/commands/` に置く
- 読むだけの仕事を切り出したくなったら `.claude/agents/`
- ただし `dev-skills/` は**次のプロジェクトへ持っていく置き場**。
  このリポジトリ固有の名前や事情は書かない
- 設定を変えたら、**変えた理由を日誌に 1 行**残す

### 貯めたものが腐らないようにする

取り決めは増えるが、**指し先の消えたフック・当たるファイルの無い rules・
名前のずれた agent は、壊れていても何も起きない。** `./scripts/check-sync.sh`
がそこを見ている。設定を足したら回す。

応答の終わりのフックは、未昇格が溜まったときと、**同じ分類ばかり溜まって
いるとき**だけ声を出す。同じところで繰り返し転んでいる合図なので、
そこは取り決めか機械の検査にまとめる頃合い。

## 書き方

- コメントも文書も**日本語**。英語で書くのは README.md と、
  利用者に配るサンプルデータだけ
- コメントには「何をしているか」ではなく**「なぜそうなっているか」**を書く。
  とくに、素直に書くと壊れる理由
- 1 行 100 文字まで。`cargo fmt` と Prettier に従う
