---
paths:
  - "crates/core/src/**"
  - "crates/wasm/src/**"
  - "docs/VERIFICATION.md"
---

# 検証の段を下げない

[docs/VERIFICATION.md](../../docs/VERIFICATION.md) が、どの約束を**どの強さで**
確かめているかの対応表。下に行くほど強い。

| 段 | 手段 | 分かること |
|---|---|---|
| 1 | 単体テスト | 試した入力について正しい |
| 2 | 性質テスト (乱択) | 撃った標本の範囲で崩れていない |
| 3 | 差分テスト (相互オラクル) | 独立した 2 実装が食い違っていない |
| 4 | 型による構成 | その値が存在する時点で成り立つ |
| 5 | 有界モデル検査 (Kani) | 区間の**すべての入力**について成り立つ |

**既にある段を下げない。** 例えば `TaskEstimate` の不変条件は型と Kani で
守っている。ここを「テストで確かめているから」と緩めない。

## Kani のハーネスを足したら

`docs/VERIFICATION.md` の表にも 1 行足す。`./scripts/check-sync.sh` が
名前の載り忘れを見ている。

```sh
cargo kani --workspace      # 11 ハーネス、約 45 秒
```

浮動小数の**計算そのもの**は Kani の対象にしていない。比較と構成までは
証明しているが、PERT の逆関数やモンテカルロの収束は、SMT で解くより
性質テストと差分テストのほうが実際的。ここは広げなくてよい。

## 2 つのエンジンは互いのオラクル

モンテカルロと数値畳み込みは、同じ仕様の**独立した 2 実装**。片方だけを
直したくなったら、それはどちらかが間違っている合図。両方通ることを
確かめる (`convolve.rs` の `both_engines_agree_on_the_percentiles`)。

## `crates/wasm` は唯一 `unsafe` がある場所

生ポインタを Rust のスライスに読み替えるだけ。触ったら miri を回す。

```sh
MIRIFLAGS=-Zmiri-strict-provenance cargo +nightly miri test -p mhc-wasm
```
