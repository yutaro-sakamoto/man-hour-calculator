---
paths:
  - "crates/core/src/abi.rs"
  - "web/src/wasm.ts"
  - "web/src/abi.ts"
  - "docs/ABI.md"
---

# ABI は 3 か所が同時に動く

JS と Rust は `f64` の平たいバッファでやり取りする。**3 か所が揃っていないと
黙って壊れる。**

| | |
|---|---|
| `crates/core/src/abi.rs` | 受け取る側。`VERSION` と区画の並び |
| `web/src/wasm.ts` / `web/src/abi.ts` | 送る側。`ABI_VERSION` と同じ並び |
| [docs/ABI.md](../../docs/ABI.md) | 取り決めそのもの |

版が食い違うと起動時の照合で弾かれる。`./scripts/check-sync.sh` が
3 つの番号を突き合わせている。

## 区画を足すとき

**ヘッダの予約枠に件数を置き、可変長の区画を末尾側に並べる。** 既存の
ストライドを変えない (変えると、古い側が読めなくなる)。`docs/ABI.md` の
長さの式と表も直す。

いちばん重い不変条件は「**宣言した長さと実際の長さが一致する**」こと。
ここが崩れると、JS が確保されていない領域を読む。Kani の
`the_declared_length_always_matches_the_sections` が、受け付けうる寸法の
すべての組について証明している。

## 未入力は `NaN`

`NaN` には意味がある（予定の時刻なら「終日」）。「読めなかった」を `NaN` に
倒すと、**別の意味に化ける**。終了時刻が開始以下の予定がその日の稼働を
丸ごと潰していたのは、これが理由だった。
