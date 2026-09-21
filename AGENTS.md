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
- **権限の判定は `crates/api` の 1 か所だけ。** ローカル (WASM) でもサーバでも
  同じコードが動く。画面側の出し分けは見た目の話でしかない
- **Rust の依存クレートはゼロ**（`crates/core` と `crates/api`）。
  サーバだけが外のクレートを使う
- `#![forbid(unsafe_code)]`。`unsafe` は `crates/wasm` の FFI 層だけ

## レビューの回し方

**軽いものは黙って回す。重いものは断ってから。**

| | いつ | 誰が |
|---|---|---|
| `./scripts/check-sync.sh` | 応答の終わりに自動 + CI | 機械。モデルを使わない |
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

## 書き方

- コメントも文書も**日本語**。英語で書くのは README.md と、
  利用者に配るサンプルデータだけ
- コメントには「何をしているか」ではなく**「なぜそうなっているか」**を書く。
  とくに、素直に書くと壊れる理由
- 1 行 100 文字まで。`cargo fmt` と Prettier に従う
