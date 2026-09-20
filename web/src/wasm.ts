/** WASM の起動と、リクエスト／レスポンスの組み立て。 */

import {
  ABI_VERSION,
  MAGIC,
  PCT_LEVELS,
  REQ_EVENT_STRIDE,
  REQ_HEADER,
  REQ_TASK_STRIDE,
  STATUS_OK,
  responseOffsets,
} from "./abi.ts";
import { dayFromIso } from "./format.ts";
import type { CalendarSettings, ComputeSettings, Task } from "./types.ts";

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc: (bytes: number) => number;
  dealloc: (ptr: number, bytes: number) => void;
  compute: (ptr: number, length: number) => number;
  last_response_len: () => number;
  abi_version: () => number;
}

let exports: WasmExports | null = null;

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 埋め込まれた WASM を起動する。
 *
 * `fetch()` は使わない。`file://` で開いたページからの `fetch()` は CORS で
 * 弾かれるので、バイナリは base64 文字列として HTML に同梱してある。
 */
export async function boot(): Promise<void> {
  // compile と instantiate を分けているのは、BufferSource を渡す多重定義と
  // Module を渡す多重定義で戻り値の形が違い、型が曖昧になるのを避けるため。
  const module = await WebAssembly.compile(decodeBase64(WASM_BASE64));
  const instance = await WebAssembly.instantiate(module, {});
  const api = instance.exports as unknown as WasmExports;
  const version = api.abi_version();
  if (version !== ABI_VERSION) {
    throw new Error(`ABI version mismatch: wasm=${version} js=${ABI_VERSION}`);
  }
  exports = api;
}

export function isReady(): boolean {
  return exports !== null;
}

/** 計算に渡す 1 タスク。階層を解決したあとの葉だけが入る。 */
export interface LeafInput {
  min: number;
  likely: number;
  max: number;
  startDay: number | null;
  progress: number;
  endDay: number | null;
}

export function leafInputFromTask(task: Task): LeafInput {
  return {
    min: Number(task.min),
    likely: Number(task.likely),
    max: Number(task.max),
    startDay: dayFromIso(task.startDate),
    progress: Math.min(1, Math.max(0, task.progress / 100)),
    endDay: dayFromIso(task.endDate),
  };
}

const NOT_SET = Number.NaN;

export function buildRequest(
  leaves: readonly LeafInput[],
  calendar: CalendarSettings,
  settings: ComputeSettings,
  prefixBins: number,
): Float64Array {
  const startDay = dayFromIso(calendar.startDate) ?? 0;
  const today = dayFromIso(calendar.today) ?? startDay;
  const events = calendar.events
    .map((event) => ({
      start: dayFromIso(event.startDate),
      end: dayFromIso(event.endDate),
      hours: event.hours ?? -1,
    }))
    .filter(
      (e): e is { start: number; end: number; hours: number } => e.start !== null && e.end !== null,
    );
  const forced = calendar.forcedWorkdays.map(dayFromIso).filter((d): d is number => d !== null);

  const request = new Float64Array(
    REQ_HEADER + leaves.length * REQ_TASK_STRIDE + events.length * REQ_EVENT_STRIDE + forced.length,
  );
  request[0] = MAGIC;
  request[1] = ABI_VERSION;
  request[2] = settings.engine;
  request[3] = settings.dist;
  request[4] = settings.lambda;
  request[5] = leaves.length;
  request[6] = settings.iterations;
  request[7] = settings.seed;
  request[8] = settings.bins;
  request[9] = settings.gridPoints;
  request[10] = 0; // 相関 (未実装)
  request[11] = prefixBins;
  request[12] = events.length;
  request[13] = forced.length;
  request[14] = startDay;
  request[15] = calendar.horizonDays;
  request[16] = calendar.workdays.reduce((mask, on, index) => mask | (on ? 1 << index : 0), 0);
  request[17] = calendar.hoursPerDay;
  request[18] = calendar.hoursPerPersonDay;
  request[19] = calendar.teamSize;
  request[20] = calendar.useJapaneseHolidays ? 1 : 0;
  request[21] = today;

  let at = REQ_HEADER;
  for (const leaf of leaves) {
    request[at++] = leaf.min;
    request[at++] = leaf.likely;
    request[at++] = leaf.max;
    request[at++] = leaf.startDay ?? NOT_SET;
    request[at++] = leaf.progress;
    request[at++] = leaf.endDay ?? NOT_SET;
  }
  for (const event of events) {
    request[at++] = event.start;
    request[at++] = event.end;
    request[at++] = event.hours;
  }
  for (const day of forced) request[at++] = day;
  return request;
}

/** 復号したレスポンス。 */
export interface ComputeResult {
  nBins: number;
  nTasks: number;
  mean: number;
  sd: number;
  lo: number;
  hi: number;
  totalMin: number;
  totalLikely: number;
  totalMax: number;
  totalSpent: number;
  baseCapacity: number;
  totalCapacity: number;
  probs: Float64Array;
  cdf: Float64Array;
  percentiles: Float64Array;
  sensitivity: Float64Array;
  effective: Float64Array;
  spent: Float64Array;
  states: Float64Array;
  prefixWidth: number;
  prefixGridHi: number;
  prefix: Float64Array;
  calendarStartDay: number;
  capacity: Float64Array;
  cumulative: Float64Array;
  dayFlags: Float64Array;
}

export class ComputeError extends Error {
  constructor(
    readonly status: number,
    readonly detail: number,
  ) {
    super(`compute failed with status ${status}`);
    this.name = "ComputeError";
  }
}

/** リクエストを WASM に渡し、レスポンスを読んで返す。 */
export function compute(request: Float64Array): ComputeResult {
  const api = exports;
  if (!api) throw new Error("wasm is not ready");

  const bytes = request.length * 8;
  const ptr = api.alloc(bytes);
  if (ptr === 0) throw new Error("wasm alloc failed");

  let raw: Float64Array;
  try {
    new Float64Array(api.memory.buffer, ptr, request.length).set(request);
    const outPtr = api.compute(ptr, request.length);
    const outLen = api.last_response_len();
    // compute の内部でメモリが伸びると古い buffer は切り離されるので、
    // 必ずここで取り直してから読む。
    raw = new Float64Array(api.memory.buffer, outPtr, outLen).slice();
  } finally {
    api.dealloc(ptr, bytes);
  }

  const status = raw[0] ?? -1;
  if (status !== STATUS_OK) throw new ComputeError(status, raw[5] ?? 0);

  const nBins = raw[2] ?? 0;
  const nPct = raw[3] ?? 0;
  const nTasks = raw[4] ?? 0;
  const prefixBins = raw[13] ?? 0;
  const prefixWidth = prefixBins > 0 ? prefixBins + 1 : 0;
  const nDays = raw[15] ?? 0;
  const at = responseOffsets(nBins, nPct, nTasks, prefixWidth, nDays);
  const take = (index: number, length: number): Float64Array =>
    raw.subarray(at[index] ?? 0, (at[index] ?? 0) + length);

  return {
    nBins,
    nTasks,
    mean: raw[6] ?? 0,
    sd: raw[7] ?? 0,
    lo: raw[8] ?? 0,
    hi: raw[9] ?? 0,
    totalMin: raw[10] ?? 0,
    totalLikely: raw[11] ?? 0,
    totalMax: raw[12] ?? 0,
    totalSpent: raw[17] ?? 0,
    baseCapacity: raw[18] ?? 0,
    totalCapacity: raw[19] ?? 0,
    probs: take(0, nBins),
    cdf: take(1, nBins + 1),
    percentiles: take(3, nPct),
    sensitivity: take(4, nTasks),
    effective: take(5, nTasks * 3),
    spent: take(6, nTasks),
    states: take(7, nTasks),
    prefixWidth,
    prefixGridHi: raw[14] ?? 0,
    prefix: take(8, nTasks * prefixWidth),
    calendarStartDay: raw[16] ?? 0,
    capacity: take(9, nDays),
    cumulative: take(10, nDays),
    dayFlags: take(11, nDays),
  };
}

/** 分位点の値を水準の添字で引く。 */
export function percentileAt(result: ComputeResult, index: number): number {
  return result.percentiles[index] ?? Number.NaN;
}

export { PCT_LEVELS };
