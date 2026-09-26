/**
 * 工数の分布を「完了日の確率」に変換する。
 *
 * WASM は各タスクについて「同じ担当者の中でそこまでの累積工数」の CDF を返し、
 * 人員ごとのカレンダーは各日までに投入できる工数の累積を返す。この 2 つを
 * 突き合わせれば
 *
 * ```text
 * P(タスク i が d 日までに終わっている)
 *     = P(担当者内の累積工数_i <= その担当者の累積稼働量(d))
 * ```
 *
 * が得られる。
 *
 * 複数人にまたがるまとまり (親タスクや全体) が終わっているのは、
 * **関わる全員がそれぞれの担当ぶんを終えている**ときなので、
 * 人ごとの確率の積になる。タスクは互いに独立としているため、
 * 別々の人が持つ担当ぶんの合計も独立で、積が厳密な答えになる。
 */

import { DAY_FLAG } from "../abi.ts";
import { dayFromIso } from "../format.ts";
import type { ComputeResult } from "../wasm.ts";
import { progressOfSubtree, progressOverall, type Progress } from "./progress.ts";
import type { TreeRow } from "./tree.ts";

/** 累積和 CDF を工数の実数値で引く (グリッド間は線形補間)。 */
export function prefixCdfAt(result: ComputeResult, task: number, effort: number): number {
  const width = result.prefixWidth;
  if (width < 2) return 0;
  const member = result.assignees[task] ?? 0;
  const gridHi = result.memberGridHi[member] ?? 0;
  const step = gridHi / (width - 1);
  if (!(step > 0)) return effort >= 0 ? 1 : 0;

  const base = task * width;
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

/**
 * 実績の期間。値は期間の初日からの日数 (初日より前なら負になる)。
 *
 * `end` は**配下がすべて完了日を持つときだけ**埋まる。1 件でも終わって
 * いなければ、まとまりとしてはまだ続いているので `null`。
 */
export interface ActualSpan {
  start: number | null;
  end: number | null;
}

export interface ScheduleRow {
  id: string;
  label: string;
  depth: number;
  isParent: boolean;
  done: boolean;
  /** この行に関わる人員の添字。 */
  members: number[];
  probabilities: Float64Array;
  marks: ScheduleMarks;
  /** 部分木の進捗。表・グラフ・詳細で同じ数字を出すため、ここで 1 度だけ引く。 */
  progress: Progress;
  actual: ActualSpan;
}

export interface MemberSummary {
  index: number;
  label: string;
  /** 担当ぶんをすべて終えている確率。 */
  probabilities: Float64Array;
  marks: ScheduleMarks;
  /** 担当タスクの件数。 */
  taskCount: number;
  /** 担当ぶんの工数 (最大側)。 */
  gridHi: number;
}

export interface ScheduleModel {
  startDay: number;
  days: number;
  /** グラフに描く日数。ほぼ確実に完了する日まで自動で詰める。 */
  displayDays: number;
  /** 全員が非稼働の日を示すフラグ。 */
  dayFlags: Uint8Array;
  todayIndex: number | null;
  rows: ScheduleRow[];
  members: MemberSummary[];
  overall: Float64Array;
  overallMarks: ScheduleMarks;
  overallProgress: Progress;
  overallActual: ActualSpan;
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

/** タスク 1 件について、日ごとの完了確率を作る。 */
function probabilitiesForTask(result: ComputeResult, task: number): Float64Array {
  const member = result.assignees[task] ?? 0;
  const base = member * result.nDays;
  const out = new Float64Array(result.nDays);
  for (let day = 0; day < result.nDays; day++) {
    out[day] = prefixCdfAt(result, task, result.cumulative[base + day] ?? 0);
  }
  return out;
}

/** 複数のタスクがすべて終わっている確率 (人ごとの独立性から積になる)。 */
function combine(parts: readonly Float64Array[], days: number): Float64Array {
  const out = new Float64Array(days).fill(1);
  for (const part of parts) {
    for (let day = 0; day < days; day++) {
      out[day] = (out[day] ?? 1) * (part[day] ?? 0);
    }
  }
  return out;
}

/**
 * 部分木のなかで、人員ごとに「いちばん後ろのタスク」を集める。
 *
 * 同じ人の中では後ろのタスクが終われば前のタスクも終わっているので、
 * 人ごとに最後の 1 件だけ見ればよい。
 */
function lastTaskPerMember(
  rows: readonly TreeRow[],
  from: number,
  result: ComputeResult,
): Map<number, number> {
  const base = rows[from];
  const last = new Map<number, number>();
  if (!base) return last;
  for (let i = from; i < rows.length; i++) {
    const row = rows[i];
    if (!row) break;
    if (i > from && row.depth <= base.depth) break;
    if (row.leafIndex === null) continue;
    const member = result.assignees[row.leafIndex] ?? 0;
    const previous = last.get(member);
    if (previous === undefined || row.leafIndex > previous) {
      last.set(member, row.leafIndex);
    }
  }
  return last;
}

/**
 * 葉の並びから実績の期間を出す。
 *
 * 計算に入っていない葉 (`leafIndex === null`) は数えない。外した行の日付で
 * 帯が伸び縮みすると、画面の数字と食い違う。
 */
export function actualSpanOf(leaves: readonly TreeRow[], startDay: number): ActualSpan {
  let start: number | null = null;
  let end: number | null = null;
  let allEnded = leaves.length > 0;
  for (const row of leaves) {
    const began = dayFromIso(row.task.startDate);
    const ended = dayFromIso(row.task.endDate);
    if (began !== null) start = start === null ? began : Math.min(start, began);
    if (ended === null) allEnded = false;
    else end = end === null ? ended : Math.max(end, ended);
  }
  return {
    start: start === null ? null : start - startDay,
    end: allEnded && end !== null ? end - startDay : null,
  };
}

/** `rows[from]` とその配下のうち、計算に入っている葉。 */
function subtreeLeafRows(rows: readonly TreeRow[], from: number): TreeRow[] {
  const base = rows[from];
  if (!base) return [];
  const out: TreeRow[] = [];
  for (let i = from; i < rows.length; i++) {
    const row = rows[i];
    if (!row) break;
    if (i > from && row.depth <= base.depth) break;
    if (row.leafIndex !== null) out.push(row);
  }
  return out;
}

/** 一覧に出す行と計算結果から、スケジュール表示用のモデルを組み立てる。 */
export function buildScheduleModel(
  result: ComputeResult,
  rows: readonly TreeRow[],
  todayDay: number,
  untitled: string,
  memberLabels: readonly string[],
): ScheduleModel {
  const days = result.nDays;
  const taskProbabilities = new Map<number, Float64Array>();
  const probabilitiesOf = (task: number): Float64Array => {
    let cached = taskProbabilities.get(task);
    if (!cached) {
      cached = probabilitiesForTask(result, task);
      taskProbabilities.set(task, cached);
    }
    return cached;
  };

  const scheduleRows: ScheduleRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const last = lastTaskPerMember(rows, i, result);
    if (last.size === 0) continue;
    const parts = [...last.values()].map(probabilitiesOf);
    const probabilities =
      parts.length === 1 ? (parts[0] ?? new Float64Array(days)) : combine(parts, days);
    scheduleRows.push({
      id: row.task.id,
      label: row.task.name.trim() === "" ? untitled : row.task.name,
      depth: row.depth,
      isParent: row.hasChildren,
      done: row.leafIndex !== null && result.states[row.leafIndex] === 2,
      members: [...last.keys()].sort((a, b) => a - b),
      probabilities,
      marks: marksOf(probabilities),
      progress: progressOfSubtree(result, rows, i),
      actual: actualSpanOf(subtreeLeafRows(rows, i), result.calendarStartDay),
    });
  }

  // 人員ごとのまとめ。その人の最後のタスクが終われば担当ぶんは終わり。
  const members: MemberSummary[] = [];
  for (let member = 0; member < result.nMembers; member++) {
    let lastTask: number | null = null;
    let count = 0;
    for (let task = 0; task < result.nTasks; task++) {
      if ((result.assignees[task] ?? 0) !== member) continue;
      count += 1;
      lastTask = task;
    }
    const probabilities =
      lastTask === null ? new Float64Array(days).fill(1) : probabilitiesOf(lastTask);
    members.push({
      index: member,
      label: memberLabels[member] ?? `#${String(member + 1)}`,
      probabilities,
      marks: marksOf(probabilities),
      taskCount: count,
      gridHi: result.memberGridHi[member] ?? 0,
    });
  }

  // 全体は「全員が担当ぶんを終えている」確率。
  const overall = combine(
    members.filter((member) => member.taskCount > 0).map((member) => member.probabilities),
    days,
  );

  // 全員が非稼働の日だけを「休み」として塗る。
  const dayFlags = new Uint8Array(days);
  for (let day = 0; day < days; day++) {
    let allOff = result.nMembers > 0;
    let anyFlags = 0;
    for (let member = 0; member < result.nMembers; member++) {
      const flags = result.dayFlags[member * days + day] ?? 0;
      anyFlags |= flags;
      if (!isNonWorkingDay(flags)) allOff = false;
    }
    dayFlags[day] = allOff ? anyFlags | DAY_FLAG.weekend : anyFlags & ~DAY_FLAG.weekend;
  }

  const almostDone = firstDayAtLeast(overall, 0.995);
  const displayDays =
    almostDone === null ? days : Math.max(30, Math.min(days, Math.ceil((almostDone + 1) * 1.15)));

  const todayIndex =
    todayDay >= result.calendarStartDay && todayDay < result.calendarStartDay + days
      ? todayDay - result.calendarStartDay
      : null;

  return {
    startDay: result.calendarStartDay,
    days,
    displayDays,
    dayFlags,
    todayIndex,
    rows: scheduleRows,
    members,
    overall,
    overallMarks: marksOf(overall),
    overallProgress: progressOverall(result),
    overallActual: actualSpanOf(
      rows.filter((row) => row.leafIndex !== null),
      result.calendarStartDay,
    ),
  };
}

/** その日が稼働日でないか (週末・祝日、かつ休日出勤でもない)。 */
export function isNonWorkingDay(flags: number): boolean {
  const off = (flags & DAY_FLAG.weekend) !== 0 || (flags & DAY_FLAG.holiday) !== 0;
  return off && (flags & DAY_FLAG.forcedWorkday) === 0;
}
