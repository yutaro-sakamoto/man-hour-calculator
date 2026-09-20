/**
 * 工数の分布を「完了日の確率」に変換する。
 *
 * WASM は各タスクについて「そこまでの累積工数」の CDF を返し、
 * カレンダーは各日までに投入できる工数の累積を返す。この 2 つを
 * 突き合わせれば
 *
 * ```text
 * P(タスク i が d 日までに終わっている) = P(累積工数_i <= 累積稼働量(d))
 * ```
 *
 * が得られる。並び順＝着手順という前提だけで、追加のシミュレーションは要らない。
 */

import { DAY_FLAG } from "../abi.ts";
import type { TreeRow } from "./tree.ts";
import type { ComputeResult } from "../wasm.ts";

/** 累積和 CDF を工数の実数値で引く (グリッド間は線形補間)。 */
export function prefixCdfAt(result: ComputeResult, leafIndex: number, effort: number): number {
  const width = result.prefixWidth;
  if (width < 2) return 0;
  const step = result.prefixGridHi / (width - 1);
  if (!(step > 0)) return effort >= 0 ? 1 : 0;

  const base = leafIndex * width;
  const position = effort / step;
  if (position <= 0) return result.prefix[base] ?? 0;
  if (position >= width - 1) return result.prefix[base + width - 1] ?? 1;

  const index = Math.floor(position);
  const frac = position - index;
  const low = result.prefix[base + index] ?? 0;
  const high = result.prefix[base + index + 1] ?? low;
  return low + frac * (high - low);
}

/** 確率が `target` 以上になる最初の日の添字。最後まで届かなければ `null`。 */
export function firstDayAtLeast(probabilities: Float64Array, target: number): number | null {
  for (let day = 0; day < probabilities.length; day++) {
    if ((probabilities[day] ?? 0) >= target) return day;
  }
  return null;
}

export interface ScheduleMarks {
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p80: number | null;
  p90: number | null;
}

export interface ScheduleRow {
  id: string;
  label: string;
  depth: number;
  isParent: boolean;
  done: boolean;
  /** 日ごとの完了確率。 */
  probabilities: Float64Array;
  marks: ScheduleMarks;
}

export interface ScheduleModel {
  startDay: number;
  days: number;
  dayFlags: Float64Array;
  /** 基準日の添字。カレンダーの範囲外なら `null`。 */
  todayIndex: number | null;
  rows: ScheduleRow[];
  /** 全タスクが完了している確率。 */
  overall: Float64Array;
  overallMarks: ScheduleMarks;
  /**
   * グラフに描く日数。
   *
   * 計算する期間 (既定 1 年) をそのまま横軸にすると、実際に動きがあるのは
   * 左端の数割だけで帯がほとんど読めなくなる。ほぼ確実に完了する日まで
   * 少し余裕を足した範囲だけを描く。
   */
  displayDays: number;
}

function marksOf(probabilities: Float64Array): ScheduleMarks {
  return {
    p10: firstDayAtLeast(probabilities, 0.1),
    p25: firstDayAtLeast(probabilities, 0.25),
    p50: firstDayAtLeast(probabilities, 0.5),
    p75: firstDayAtLeast(probabilities, 0.75),
    p80: firstDayAtLeast(probabilities, 0.8),
    p90: firstDayAtLeast(probabilities, 0.9),
  };
}

/** ある累積和 CDF の行から、日ごとの完了確率を作る。 */
function probabilitiesFor(
  result: ComputeResult,
  leafIndex: number,
  cumulative: Float64Array,
): Float64Array {
  const out = new Float64Array(cumulative.length);
  for (let day = 0; day < cumulative.length; day++) {
    out[day] = prefixCdfAt(result, leafIndex, cumulative[day] ?? 0);
  }
  return out;
}

/** 一覧に出す行と計算結果から、スケジュール表示用のモデルを組み立てる。 */
export function buildScheduleModel(
  result: ComputeResult,
  rows: readonly TreeRow[],
  todayDay: number,
  untitled: string,
): ScheduleModel {
  const cumulative = result.cumulative;
  const scheduleRows: ScheduleRow[] = [];

  for (const row of rows) {
    // 親は配下の最後の葉が終わったときに終わる。
    const leafIndex = row.lastLeafIndex;
    if (leafIndex === null) continue;
    const probabilities = probabilitiesFor(result, leafIndex, cumulative);
    scheduleRows.push({
      id: row.task.id,
      label: row.task.name.trim() === "" ? untitled : row.task.name,
      depth: row.depth,
      isParent: row.hasChildren,
      done: !row.hasChildren && result.states[row.leafIndex ?? -1] === 2,
      probabilities,
      marks: marksOf(probabilities),
    });
  }

  const lastLeaf = result.nTasks - 1;
  const overall =
    lastLeaf >= 0 && result.prefixWidth > 0
      ? probabilitiesFor(result, lastLeaf, cumulative)
      : new Float64Array(cumulative.length);

  const todayIndex =
    todayDay >= result.calendarStartDay && todayDay < result.calendarStartDay + cumulative.length
      ? todayDay - result.calendarStartDay
      : null;

  const almostDone = firstDayAtLeast(overall, 0.995);
  const displayDays =
    almostDone === null
      ? cumulative.length
      : Math.max(30, Math.min(cumulative.length, Math.ceil((almostDone + 1) * 1.15)));

  return {
    startDay: result.calendarStartDay,
    days: cumulative.length,
    dayFlags: result.dayFlags,
    todayIndex,
    rows: scheduleRows,
    overall,
    overallMarks: marksOf(overall),
    displayDays,
  };
}

/** その日が稼働日でないか (週末・祝日、かつ休日出勤でもない)。 */
export function isNonWorkingDay(flags: number): boolean {
  const off = (flags & DAY_FLAG.weekend) !== 0 || (flags & DAY_FLAG.holiday) !== 0;
  return off && (flags & DAY_FLAG.forcedWorkday) === 0;
}
