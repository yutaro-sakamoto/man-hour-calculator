/** WASM とやり取りするバッファのレイアウト。`crates/core/src/abi.rs` と対応する。 */

export const MAGIC = 20250920;
export const ABI_VERSION = 2;
export const REQ_HEADER = 32;
export const RESP_HEADER = 24;
export const REQ_TASK_STRIDE = 6;
export const REQ_EVENT_STRIDE = 3;

export const ENGINE = { monteCarlo: 0, convolution: 1 } as const;
export const DIST = { pert: 0, triangular: 1 } as const;

/** 日ごとのフラグ (ビット)。 */
export const DAY_FLAG = {
  weekend: 1,
  holiday: 2,
  event: 4,
  forcedWorkday: 8,
} as const;

/** `status` の値。0 以外はすべてエラー。 */
export const STATUS_OK = 0;

/** 分位点の水準。Rust 側の `PCT_LEVELS` と同じ並び。 */
export const PCT_LEVELS = [0.1, 0.25, 0.5, 0.75, 0.8, 0.9, 0.95] as const;
/** `PCT_LEVELS` のうち P80 の位置。 */
export const P80_INDEX = 4;
export const P50_INDEX = 2;
export const P10_INDEX = 0;
export const P25_INDEX = 1;
export const P75_INDEX = 3;
export const P90_INDEX = 5;

/** レスポンス本体の各区画の開始位置。Rust の `response_offsets` と同じ計算。 */
export function responseOffsets(
  nBins: number,
  nPct: number,
  nTasks: number,
  prefixWidth: number,
  nDays: number,
): number[] {
  const lengths = [
    nBins, // ビンごとの確率
    nBins + 1, // 累積確率
    nPct, // 分位点の水準
    nPct, // 分位点の値
    nTasks, // 感度
    nTasks * 3, // 実績反映後の見積もり
    nTasks, // 消化済み工数
    nTasks, // 状態
    nTasks * prefixWidth, // 累積和の CDF
    nDays, // 日ごとの工数
    nDays, // 累積工数
    nDays, // 日ごとのフラグ
    0, // 末尾
  ];
  const offsets: number[] = [];
  let at = RESP_HEADER;
  for (const length of lengths) {
    offsets.push(at);
    at += length;
  }
  return offsets;
}
