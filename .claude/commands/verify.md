この変更で壊れていないかを、通しで確かめる。

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix web run check
cargo xtask build
cd e2e && npx playwright test
./scripts/check-sync.sh
```

`npm run check` の出力は `grep` で絞らず `tail` で見ること。
Prettier の `[warn]` を見落として、失敗を成功と読み違えたことがある。

$ARGUMENTS に `formal` が含まれるときは、形式手法の層も回す
（合わせて 3 分ほどかかる）。

```sh
cargo kani --workspace
MIRIFLAGS=-Zmiri-strict-provenance cargo +nightly miri test -p mhc-wasm
./spec/check.sh
```

落ちたものがあれば、**何が落ちたかを出力ごと**報告する。
「たぶんこれが原因」で済ませず、実際に確かめてから直す。
