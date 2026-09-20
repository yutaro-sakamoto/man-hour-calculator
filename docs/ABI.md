# JS ↔ WASM の ABI

`crates/core/src/abi.rs` と `web/app.js` は、この文書の表どおりのバッファをやり取りする。
どちらかを変えたら `VERSION` を上げること。起動時に `abi_version()` を照合しているので、
食い違ったまま動き出すことはない。

## 設計方針

**リクエストもレスポンスも、要素がすべて `f64` の平坦な配列**にしている。
タスク数やビン数のような整数も、エンジンの種別のようなフラグも `f64` に載せる。

そうする理由は 1 つで、JS 側を

```js
new Float64Array(memory.buffer, ptr, length)
```

の 1 行だけで読み書きできるようにするため。`DataView` で `u32` と `f64` を混ぜると、
オフセットの計算間違いとアラインメント違反がどうしても入り込む。
すべて 8 バイト幅に揃えておけば、その種のバグは構造的に発生しない。

`f64` は 2^53 までの整数を誤差なく表せるので、ここで扱う値にとって精度の問題はない。

## エクスポートされる関数

| 関数 | シグネチャ | 役割 |
|---|---|---|
| `alloc` | `(len_bytes: usize) -> *mut u8` | JS が書き込む領域を確保する。失敗時は null |
| `dealloc` | `(ptr: *mut u8, len_bytes: usize)` | `alloc` した領域を解放する |
| `compute` | `(ptr: *const f64, len: usize) -> *const f64` | 計算してレスポンス先頭を返す |
| `last_response_len` | `() -> usize` | 直前のレスポンスの長さ (`f64` の個数) |
| `abi_version` | `() -> u32` | この文書のバージョン |

`compute` が返すポインタは**次に `compute` を呼ぶまで**しか有効でない。
JS 側は必ず `.slice()` でコピーしてから使うこと。

また、`compute` の内部で線形メモリが伸びると既存の `ArrayBuffer` は切り離されるので、
**レスポンスを読む前に `memory.buffer` を取り直す**。

```js
const bytes = request.length * 8;
const ptr = wasm.alloc(bytes);
new Float64Array(wasm.memory.buffer, ptr, request.length).set(request);
const outPtr = wasm.compute(ptr, request.length);
const outLen = wasm.lastLen();
const response = new Float64Array(wasm.memory.buffer, outPtr, outLen).slice();
wasm.dealloc(ptr, bytes);
```

## リクエスト

長さは `12 + 3 * n_tasks`。

| 添字 | 名前 | 値 |
|---:|---|---|
| 0 | `magic` | `20250920` 固定 |
| 1 | `version` | `1` |
| 2 | `engine` | `0` = モンテカルロ、`1` = 数値畳み込み |
| 3 | `dist_kind` | `0` = PERT、`1` = 三角分布 (未知の値は PERT にフォールバック) |
| 4 | `lambda` | PERT の形状パラメータ。`0..=100` に丸められる。既定 `4` |
| 5 | `n_tasks` | `1..=500` |
| 6 | `iterations` | モンテカルロの試行回数。`1..=2_000_000` |
| 7 | `seed` | 乱数シード (非負整数) |
| 8 | `n_bins` | ヒストグラムのビン数。`4..=512` |
| 9 | `grid_points` | 畳み込みのグリッド分割数。`16..=16384` |
| 10 | `correlation` | タスク間相関。**現在は `0` のみ受け付ける** (M2 で実装) |
| 11 | — | 予約 (`0`) |
| 12 + 3i | `min[i]` | i 番目のタスクの最小値 |
| 13 + 3i | `likely[i]` | i 番目のタスクの最可能値 |
| 14 + 3i | `max[i]` | i 番目のタスクの最大値 |

制限値は `crates/core/src/abi.rs` の定数がすべて。
モンテカルロは `iterations * n_tasks <= 50_000_000` でも制限している
(ブラウザの UI スレッドを何十秒も止めないため)。

## レスポンス

成功時の長さは `13 + n_bins + (n_bins + 1) + 2 * n_percentiles + n_tasks`。

### ヘッダ (13 要素)

| 添字 | 名前 | 内容 |
|---:|---|---|
| 0 | `status` | `0` なら成功。それ以外はエラー (下表) |
| 1 | `version` | `1` |
| 2 | `n_bins` | 本体のビン数 |
| 3 | `n_percentiles` | 分位点の個数 (現在は 7) |
| 4 | `n_tasks` | 感度の個数 |
| 5 | `detail` | エラーの補足情報。`status = 4` なら不正だったタスクの添字 |
| 6 | `mean` | 総工数の平均 |
| 7 | `sd` | 総工数の標準偏差 |
| 8 | `lo` | ヒストグラムの下限 (P0.1 相当) |
| 9 | `hi` | ヒストグラムの上限 (P99.9 相当) |
| 10 | `total_min` | 各タスクの最小値の合計 |
| 11 | `total_likely` | 各タスクの最可能値の合計 |
| 12 | `total_max` | 各タスクの最大値の合計 |

### 本体 (この順に連結)

| 区画 | 長さ | 内容 |
|---|---:|---|
| `bin_probs` | `n_bins` | 各ビンの確率。非負。両端を切っているので総和は 1 よりわずかに小さい |
| `cdf` | `n_bins + 1` | ビン境界での累積確率。単調非減少 |
| `percentile_levels` | `n_percentiles` | `[0.10, 0.25, 0.50, 0.75, 0.80, 0.90, 0.95]` |
| `percentile_values` | `n_percentiles` | 上に対応する総工数 |
| `sensitivity` | `n_tasks` | 各タスクの分散が総分散に占める割合 (総和 1) |

ビンの境界は `lo` と `hi` から求まるので送っていない。
i 番目のビンは `[lo + i*step, lo + (i+1)*step)`、`step = (hi - lo) / n_bins`。

**不変条件**: `response.length` は必ずヘッダの宣言 (`n_bins`, `n_percentiles`, `n_tasks`)
と一致する。JS 側が範囲外を読まないための最重要の性質で、
`crates/core/src/abi.rs` のテストで毎回検査している。

### エラー

エラー時の応答は**ヘッダ 13 要素だけ**で、`n_bins` などはすべて `0`。
JS 側は `status` を見てから本体を読むので、範囲外アクセスは起こらない。

| `status` | 意味 |
|---:|---|
| 1 | バッファが短い、または magic / version が合わない |
| 2 | タスク数が 0 / 上限超え / バッファ長と矛盾 |
| 3 | 試行回数・ビン数・グリッド分割数が範囲外、または計算量が大きすぎる |
| 4 | `min <= likely <= max` を満たさないタスクがある (`detail` に添字) |
| 5 | エンジンの指定が不正 |
| 6 | 相関つきの計算は未実装 |
