/** WASM の起動と、リクエスト／レスポンスの組み立て。 */

import {
  ABI_VERSION,
  MAGIC,
  PCT_LEVELS,
  REQ_EVENT_EXCEPTION_STRIDE,
  REQ_EVENT_MEMBER_STRIDE,
  REQ_EVENT_STRIDE,
  REQ_HEADER,
  REQ_MEMBER_STRIDE,
  REQ_TASK_STRIDE,
  STATUS_OK,
  responseOffsets,
} from "./abi.ts";
import { dayFromIso, minutesFromTime } from "./format.ts";
import { memberIndexOf, participantsOf, type ResolvedMembers } from "./model/members.ts";
import type { CalendarSettings, ComputeSettings, Task } from "./types.ts";

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc: (bytes: number) => number;
  dealloc: (ptr: number, bytes: number) => void;
  /** 計算 (f64 の平坦なバッファ)。 */
  compute: (ptr: number, length: number) => number;
  last_response_len: () => number;
  abi_version: () => number;
  /** API 層 (UTF-8 の JSON)。 */
  api_call: (ptr: number, length: number) => number;
  import_state: (ptr: number, length: number) => number;
  export_state: () => number;
  last_text_len: () => number;
  api_version: () => number;
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** WASM に文字列を渡し、返ってきた文字列を読む。 */
function callWithText(
  run: (api: WasmExports, ptr: number, length: number) => number,
  text: string,
): string {
  const api = exports;
  if (!api) throw new Error("wasm is not ready");

  const bytes = encoder.encode(text);
  const ptr = bytes.length === 0 ? 0 : api.alloc(bytes.length);
  if (bytes.length > 0 && ptr === 0) throw new Error("wasm alloc failed");
  try {
    if (bytes.length > 0) {
      new Uint8Array(api.memory.buffer, ptr, bytes.length).set(bytes);
    }
    const outPtr = run(api, ptr, bytes.length);
    const outLen = api.last_text_len();
    // 呼び出しのなかでメモリが伸びている可能性があるので、読む直前に取り直す。
    return decoder.decode(new Uint8Array(api.memory.buffer, outPtr, outLen).slice());
  } finally {
    if (bytes.length > 0) api.dealloc(ptr, bytes.length);
  }
}

/** API を 1 回呼ぶ。入力も出力も JSON 文字列。 */
export function apiCall(request: string): string {
  return callWithText((api, ptr, length) => api.api_call(ptr, length), request);
}

/** 保存しておいたワークスペースを読み込む。 */
export function importState(state: string): string {
  return callWithText((api, ptr, length) => api.import_state(ptr, length), state);
}

/** いまのワークスペースを JSON で取り出す。 */
export function exportState(): string {
  const api = exports;
  if (!api) throw new Error("wasm is not ready");
  const ptr = api.export_state();
  return decoder.decode(new Uint8Array(api.memory.buffer, ptr, api.last_text_len()).slice());
}

/** 計算に渡す 1 タスク。階層を解決したあとの葉だけが入る。 */
export interface LeafInput {
  min: number;
  likely: number;
  max: number;
  startDay: number | null;
  progress: number;
  endDay: number | null;
  /** 担当する人員の添字。 */
  assignee: number;
}

export function leafInputFromTask(task: Task, members: ResolvedMembers): LeafInput {
  return {
    min: Number(task.min),
    likely: Number(task.likely),
    max: Number(task.max),
    startDay: dayFromIso(task.startDate),
    progress: Math.min(1, Math.max(0, task.progress / 100)),
    endDay: dayFromIso(task.endDate),
    assignee: memberIndexOf(members, task),
  };
}

const NOT_SET = Number.NaN;

/** 予定 1 件を数値の並びに直したもの。 */
interface EncodedEvent {
  startDay: number;
  endDay: number;
  startMinute: number;
  endMinute: number;
  repeatWeeks: number;
  untilDay: number;
  members: number[];
  /** 休みにした回の初日 (1970-01-01 からの日数)。 */
  skipped: number[];
}

function encodeEvents(calendar: CalendarSettings, members: ResolvedMembers): EncodedEvent[] {
  const encoded: EncodedEvent[] = [];
  for (const event of calendar.events) {
    const startDay = dayFromIso(event.startDate);
    const endDay = dayFromIso(event.endDate);
    if (startDay === null || endDay === null) continue;
    const startMinute = minutesFromTime(event.startTime);
    const endMinute = minutesFromTime(event.endTime);
    // 時刻が片方しか読めないものは終日として扱う。
    //
    // **終了が開始以下でも、そのまま送る。** かつては `NaN` に倒していたが、
    // `NaN` は「終日」の印なので、10:00〜10:00 や 22:00〜02:00 の予定が
    // その日の稼働を丸ごと潰していた。長さの無い時間帯は、受け取った側が
    // 「何も消費しない」として正しく扱う。
    const timed = startMinute !== null && endMinute !== null;
    encoded.push({
      startDay,
      endDay: Math.max(startDay, endDay),
      startMinute: timed ? startMinute : NOT_SET,
      endMinute: timed ? endMinute : NOT_SET,
      repeatWeeks: Math.max(0, Math.round(event.repeatWeeks)),
      untilDay: dayFromIso(event.until) ?? NOT_SET,
      members: participantsOf(members, event.memberIds),
      skipped: event.excludedDates
        .map((iso) => dayFromIso(iso))
        .filter((day): day is number => day !== null),
    });
  }
  return encoded;
}

export function buildRequest(
  leaves: readonly LeafInput[],
  calendar: CalendarSettings,
  members: ResolvedMembers,
  settings: ComputeSettings,
  prefixBins: number,
): Float64Array {
  const startDay = dayFromIso(calendar.startDate) ?? 0;
  const today = dayFromIso(calendar.today) ?? startDay;
  const events = encodeEvents(calendar, members);
  const links = events.flatMap((event, index) =>
    event.members.map((member) => [index, member] as const),
  );
  // 日付が読めない予定は encodeEvents で落ちているので、添字は
  // `calendar.events` ではなく**絞り込んだあとの一覧**で数える。
  const skips = events.flatMap((event, index) => event.skipped.map((day) => [index, day] as const));
  const forced = calendar.forcedWorkdays
    .map((day) => dayFromIso(day))
    .filter((day): day is number => day !== null);

  const request = new Float64Array(
    REQ_HEADER +
      leaves.length * REQ_TASK_STRIDE +
      members.all.length * REQ_MEMBER_STRIDE +
      events.length * REQ_EVENT_STRIDE +
      links.length * REQ_EVENT_MEMBER_STRIDE +
      skips.length * REQ_EVENT_EXCEPTION_STRIDE +
      forced.length,
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
  request[16] = members.all.length;
  request[17] = calendar.hoursPerPersonDay;
  request[18] = links.length;
  request[19] = calendar.useJapaneseHolidays ? 1 : 0;
  request[20] = today;
  request[21] = skips.length;

  let at = REQ_HEADER;
  for (const leaf of leaves) {
    request[at++] = leaf.min;
    request[at++] = leaf.likely;
    request[at++] = leaf.max;
    request[at++] = leaf.startDay ?? NOT_SET;
    request[at++] = leaf.progress;
    request[at++] = leaf.endDay ?? NOT_SET;
    request[at++] = leaf.assignee;
  }
  for (const member of members.all) {
    for (const window of member.workdays) request[at++] = minutesFromTime(window.start) ?? 0;
    for (const window of member.workdays) request[at++] = minutesFromTime(window.end) ?? 0;
    request[at++] = Math.max(0, Math.round(member.breakMinutes));
  }
  for (const event of events) {
    request[at++] = event.startDay;
    request[at++] = event.endDay;
    request[at++] = event.startMinute;
    request[at++] = event.endMinute;
    request[at++] = event.repeatWeeks;
    request[at++] = event.untilDay;
  }
  for (const [event, member] of links) {
    request[at++] = event;
    request[at++] = member;
  }
  for (const [event, day] of skips) {
    request[at++] = event;
    request[at++] = day;
  }
  for (const day of forced) request[at++] = day;
  return request;
}

/** 復号したレスポンス。 */
export interface ComputeResult {
  nBins: number;
  nTasks: number;
  nMembers: number;
  nDays: number;
  mean: number;
  sd: number;
  lo: number;
  hi: number;
  totalMin: number;
  totalLikely: number;
  totalMax: number;
  totalSpent: number;
  totalCapacity: number;
  probs: Float64Array;
  cdf: Float64Array;
  percentiles: Float64Array;
  sensitivity: Float64Array;
  effective: Float64Array;
  spent: Float64Array;
  states: Float64Array;
  assignees: Float64Array;
  prefixWidth: number;
  prefix: Float64Array;
  /** 人員ごとの累積和グリッド上限。 */
  memberGridHi: Float64Array;
  calendarStartDay: number;
  /** 人員ごと・日ごとの工数 (長さ `nMembers * nDays`)。 */
  capacity: Float64Array;
  cumulative: Float64Array;
  dayFlags: Float64Array;
}

/** 人員 `member` の 1 日ぶんの配列を切り出す。 */
export function memberSlice(
  result: ComputeResult,
  source: Float64Array,
  member: number,
): Float64Array {
  const from = member * result.nDays;
  return source.subarray(from, from + result.nDays);
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
  const nDays = raw[14] ?? 0;
  const nMembers = raw[17] ?? 0;
  const at = responseOffsets(nBins, nPct, nTasks, prefixWidth, nMembers, nDays);
  const take = (index: number, length: number): Float64Array =>
    raw.subarray(at[index] ?? 0, (at[index] ?? 0) + length);

  return {
    nBins,
    nTasks,
    nMembers,
    nDays,
    mean: raw[6] ?? 0,
    sd: raw[7] ?? 0,
    lo: raw[8] ?? 0,
    hi: raw[9] ?? 0,
    totalMin: raw[10] ?? 0,
    totalLikely: raw[11] ?? 0,
    totalMax: raw[12] ?? 0,
    totalSpent: raw[16] ?? 0,
    totalCapacity: raw[18] ?? 0,
    probs: take(0, nBins),
    cdf: take(1, nBins + 1),
    percentiles: take(3, nPct),
    sensitivity: take(4, nTasks),
    effective: take(5, nTasks * 3),
    spent: take(6, nTasks),
    states: take(7, nTasks),
    assignees: take(8, nTasks),
    prefixWidth,
    prefix: take(9, nTasks * prefixWidth),
    memberGridHi: take(10, nMembers),
    calendarStartDay: raw[15] ?? 0,
    capacity: take(11, nMembers * nDays),
    cumulative: take(12, nMembers * nDays),
    dayFlags: take(13, nMembers * nDays),
  };
}

/** 分位点の値を水準の添字で引く。 */
export function percentileAt(result: ComputeResult, index: number): number {
  return result.percentiles[index] ?? Number.NaN;
}

export { PCT_LEVELS };
