# JS ↔ WASM の ABI (version 4)

`crates/core/src/abi.rs` と `web/src/wasm.ts` / `web/src/abi.ts` は、この文書の表どおりの
バッファをやり取りする。どちらかを変えたら `VERSION` を上げること。起動時に
`abi_version()` を照合しているので、食い違ったまま動き出すことはない。

## 設計方針

**リクエストもレスポンスも、要素がすべて `f64` の平坦な配列**にしている。
タスク数やビン数のような整数も、エンジンの種別のようなフラグも、日付も `f64` に載せる。

そうする理由は 1 つで、JS 側を

```js
new Float64Array(memory.buffer, ptr, length)
```

の 1 行だけで読み書きできるようにするため。`DataView` で `u32` と `f64` を混ぜると、
オフセットの計算間違いとアラインメント違反がどうしても入り込む。
すべて 8 バイト幅に揃えておけば、その種のバグは構造的に発生しない。

`f64` は 2^53 までの整数を誤差なく表せるので、ここで扱う値にとって精度の問題はない。

**日付**は「1970-01-01 からの日数」、**時刻**は「0 時からの分」で表し、
**未入力は `NaN`** で示す。タイムゾーンは登場しない (扱うのは暦日と時刻だけ)。

## エクスポートされる関数

| 関数 | シグネチャ | 役割 |
|---|---|---|
| `alloc` | `(len_bytes: usize) -> *mut u8` | JS が書き込む領域を確保する。失敗時は null |
| `dealloc` | `(ptr: *mut u8, len_bytes: usize)` | `alloc` した領域を解放する |
| `compute` | `(ptr: *const f64, len: usize) -> *const f64` | 計算してレスポンス先頭を返す |
| `last_response_len` | `() -> usize` | 直前のレスポンスの長さ (`f64` の個数) |
| `abi_version` | `() -> u32` | この文書のバージョン (= 4) |

`compute` が返すポインタは**次に `compute` を呼ぶまで**しか有効でない。
JS 側は必ずコピーしてから使う。また `compute` の内部で線形メモリが伸びると
既存の `ArrayBuffer` は切り離されるので、**レスポンスを読む前に `memory.buffer` を
取り直す**。

```js
const bytes = request.length * 8;
const ptr = wasm.alloc(bytes);
new Float64Array(wasm.memory.buffer, ptr, request.length).set(request);
const outPtr = wasm.compute(ptr, request.length);
const outLen = wasm.last_response_len();
const response = new Float64Array(wasm.memory.buffer, outPtr, outLen).slice();
wasm.dealloc(ptr, bytes);
```

## リクエスト

長さは
`32 + 7 * n_tasks + 15 * n_members + 6 * n_events + 2 * n_event_members
+ 2 * n_event_exceptions + n_forced_workdays`。

### ヘッダ (32 要素)

| 添字 | 名前 | 値 |
|---:|---|---|
| 0 | `magic` | `20250920` 固定 |
| 1 | `version` | `4` |
| 2 | `engine` | `0` = モンテカルロ、`1` = 数値畳み込み |
| 3 | `dist_kind` | `0` = PERT、`1` = 三角分布 (未知の値は PERT にフォールバック) |
| 4 | `lambda` | PERT の形状パラメータ。`0..=100` に丸められる。既定 `4` |
| 5 | `n_tasks` | `1..=500`。**葉タスクだけ**を並び順に渡す |
| 6 | `iterations` | モンテカルロの試行回数。`1..=2_000_000` |
| 7 | `seed` | 乱数シード (非負整数) |
| 8 | `n_bins` | ヒストグラムのビン数。`4..=512` |
| 9 | `grid_points` | 畳み込みのグリッド分割数。`16..=16384` |
| 10 | `correlation` | タスク間相関。**現在は `0` のみ受け付ける** |
| 11 | `prefix_bins` | 累積和 CDF のグリッド分割数。`0..=1024`。`0` なら返さない |
| 12 | `n_events` | 予定の件数。`0..=1000` |
| 13 | `n_forced_workdays` | 休日出勤日の件数。`0..=2000` |
| 14 | `calendar_start_day` | カレンダーの開始日 (日数) |
| 15 | `horizon_days` | 何日ぶん計算するか。`0..=1830` |
| 16 | `n_members` | 人員の数。`1..=30`。`n_members * horizon_days <= 40000` |
| 17 | `hours_per_person_day` | 1 人日あたりの時間 (`> 0`) |
| 18 | `n_event_members` | 予定と人員の割当件数。`0..=10000` |
| 19 | `use_japanese_holidays` | `0` / `1` |
| 20 | `today_day` | 進捗を測る基準日 (日数) |
| 21 | `n_event_exceptions` | 予定の除外日の件数。`0..=10000` |
| 22..31 | — | 予約 (`0`) |

### 本体 (この順に連結)

| 区画 | 要素数 | 内容 |
|---|---:|---|
| タスク | `7 * n_tasks` | `min, likely, max, start_day, progress, end_day, assignee` |
| 人員 | `15 * n_members` | 稼働開始 × 7、稼働終了 × 7、休憩分数 |
| 予定 | `6 * n_events` | `start_day, end_day, start_minute, end_minute, repeat_weeks, until_day` |
| 予定の参加者 | `2 * n_event_members` | `event_index, member_index` |
| 予定の除外日 | `2 * n_event_exceptions` | `event_index, day` |
| 休日出勤 | `n_forced_workdays` | `day` |

- `start_day` / `end_day` / `until_day` は未入力なら `NaN`。
- `progress` は `0.0..=1.0`。`assignee` は人員の添字 (範囲外なら 0 に倒す)。
- 人員の稼働時間は曜日ごとの `[開始, 終了)` を分で表す。添字 0 が日曜。
  開始と終了が同じ曜日は非稼働。**休憩分数は稼働日から一律で差し引く**。
- 予定の `start_minute` / `end_minute` が `NaN` なら終日 (稼働時間をまるごと潰す)。
- `repeat_weeks` は繰り返しの週数。`0` = 繰り返さない、`1` = 毎週、`2` = 隔週。
  `until_day` まで続く。
- 予定の除外日は、休みにする回の**初日**を指す。複数日にまたがる回はまるごと消える。
  並び順は問わない (受け取った側で整列して重複を落とす)。範囲外の `event_index` は捨てる。
- 予定は複数の人員に割り当てられる。同じ `event_index` が複数行に現れてよい。

制限値は `crates/core/src/abi.rs` の定数がすべて。ほかに
`iterations * n_tasks <= 50_000_000` と `n_tasks * (prefix_bins + 1) <= 200_000`
でも制限している (ブラウザの UI スレッドを止めないため)。

### 1 日の工数の決まり方

```text
稼働分数 = その曜日の稼働時間帯の長さ
           − 休憩分数
           − 予定が稼働時間帯を覆う分数 (重なりは 1 回だけ数える)
工数     = 稼働分数 ÷ 60 ÷ hours_per_person_day
週末・祝日 → 0 (ただし休日出勤に指定されていれば通常どおり)
```

稼働時間帯の外にある予定は 1 分も削らない。

## レスポンス

成功時の長さは
`24 + n_bins + (n_bins + 1) + 2 * n_percentiles + 7 * n_tasks
 + n_tasks * prefix_width + n_members + 3 * n_members * n_days`。
`prefix_width` は `prefix_bins + 1` (`prefix_bins = 0` なら 0)。

### ヘッダ (24 要素)

| 添字 | 名前 | 内容 |
|---:|---|---|
| 0 | `status` | `0` なら成功。それ以外はエラー (下表) |
| 1 | `version` | `4` |
| 2 | `n_bins` | 本体のビン数 |
| 3 | `n_percentiles` | 分位点の個数 (現在は 7) |
| 4 | `n_tasks` | タスク数 |
| 5 | `detail` | エラーの補足情報。`status = 4` なら不正だったタスクの添字 |
| 6 | `mean` | 総工数の平均 |
| 7 | `sd` | 総工数の標準偏差 |
| 8 | `lo` | ヒストグラムの下限 (P0.1 相当) |
| 9 | `hi` | ヒストグラムの上限 (P99.9 相当) |
| 10 | `total_min` | 実績反映後の最小値の合計 |
| 11 | `total_likely` | 実績反映後の最可能値の合計 |
| 12 | `total_max` | 実績反映後の最大値の合計 |
| 13 | `prefix_bins` | 累積和 CDF のグリッド分割数 (`0` なら区画なし) |
| 14 | `n_days` | カレンダーの日数 |
| 15 | `calendar_start_day` | カレンダーの開始日 |
| 16 | `total_spent` | 消化済み工数の合計 |
| 17 | `n_members` | 人員の数 |
| 18 | `total_capacity` | 全員・全期間で投入できる工数 |
| 19..23 | — | 予約 |

### 本体 (この順に連結)

| 区画 | 要素数 | 内容 |
|---|---:|---|
| `bin_probs` | `n_bins` | 各ビンの確率。非負 |
| `cdf` | `n_bins + 1` | ビン境界での累積確率。単調非減少 |
| `percentile_levels` | `n_percentiles` | `[0.10, 0.25, 0.50, 0.75, 0.80, 0.90, 0.95]` |
| `percentile_values` | `n_percentiles` | 上に対応する総工数 |
| `sensitivity` | `n_tasks` | 各タスクの分散が総分散に占める割合 (総和 1) |
| `effective` | `3 * n_tasks` | 実績を反映した `min, likely, max` |
| `spent` | `n_tasks` | 消化済み工数 (担当者のカレンダーで測ったもの) |
| `state` | `n_tasks` | `0` 未着手 / `1` 進行中 / `2` 完了 |
| `assignee` | `n_tasks` | 実際に使われた担当者の添字 |
| `prefix_cdf` | `n_tasks * prefix_width` | 担当者内での累積工数の CDF |
| `member_grid_hi` | `n_members` | 担当者ごとの累積和グリッドの上限 |
| `member_capacity` | `n_members * n_days` | その日に投入できる工数 (人員ごと) |
| `member_cumulative` | `n_members * n_days` | 開始日からの累積 (人員ごと) |
| `member_flags` | `n_members * n_days` | ビット: 1 週末 / 2 祝日 / 4 予定あり / 8 休日出勤 |

人員ごとの配列は `member * n_days + day` の順に並ぶ。

ビンの境界は `lo` と `hi` から求まるので送っていない。
i 番目のビンは `[lo + i*step, lo + (i+1)*step)`、`step = (hi - lo) / n_bins`。

`prefix_cdf` の行 i の第 k 要素は
`P(タスク i までの累積工数 <= k * member_grid_hi[assignee[i]] / prefix_bins)`。
ここでの「そこまで」は**同じ担当者のタスクの中で**数える。別の人のタスクは
並行して進むので、一列に足してはいけない。これを `member_cumulative` と
突き合わせると、**タスク i が d 日までに終わっている確率**が出る。

複数人にまたがるまとまり (親タスクや全体) が終わっている確率は、
関わる人ごとの確率の**積**になる。タスクは独立としているので、
別々の人が持つ担当ぶんの合計も独立で、積が厳密な答えになる。

**不変条件**: `response.length` は必ずヘッダの宣言と一致する。
JS 側が範囲外を読まないための最重要の性質で、Rust 側のテストで毎回検査している
(`response_offsets` が両者の計算を 1 か所に集めている)。

### エラー

エラー時の応答は**ヘッダ 24 要素だけ**で、`n_bins` などはすべて `0`。
JS 側は `status` を見てから本体を読むので、範囲外アクセスは起こらない。

| `status` | 意味 |
|---:|---|
| 1 | バッファが短い、または magic / version が合わない |
| 2 | タスク数が 0 / 上限超え / バッファ長と矛盾 |
| 3 | 試行回数・ビン数・グリッド分割数が範囲外、または計算量が大きすぎる |
| 4 | `min <= likely <= max` を満たさないタスクがある (`detail` に添字) |
| 5 | エンジンの指定が不正 |
| 6 | 相関つきの計算は未実装 |
| 7 | カレンダーの設定が不正 (稼働時間が負、期間が長すぎる など) |
| 8 | 人員の指定が不正 (0 人、上限超え、人員 × 日数が大きすぎる) |
