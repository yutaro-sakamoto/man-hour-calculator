/**
 * 終わったタスクの実績から、見積もりの偏りを読む。
 *
 * シミュレーションでは、どの週も総工数の P80 を実績が上回り、期限の確率が
 * 100% と 0% の間を行き来した。タスクは互いに独立として足すので、個々の
 * 見積もりに**共通の偏り** (楽観) があると、和の分布は狭いまま外れる。
 * 終わったタスクが見積もりの何倍かかったかは、残りのタスクの見積もりを
 * 疑う一番の手がかりになる (実際の世界では平均 1.25 倍だった)。
 */

import { parseEffort } from "../format.ts";
import type { Task } from "../types.ts";
import { parseEstimate } from "./tree.ts";

/** 倍率を出すのに要る件数。少ないと 1 件の外れに引きずられる。 */
export const CALIBRATION_MIN_TASKS = 3;
/** 掛ける倍率の範囲。外れ値で見積もりを壊さない。 */
const FACTOR_RANGE = [0.5, 3] as const;

export interface Calibration {
  /** 使ったタスクの数。 */
  count: number;
  /** 実績 ÷ 見積もりの期待値 (幾何平均)。 */
  factor: number;
}

/** 終わっていて、実績工数が入っているタスクから倍率を出す。足りなければ `null`。 */
export function calibrationOf(tasks: readonly Task[], hoursPerDay: number): Calibration | null {
  const logs: number[] = [];
  for (const task of tasks) {
    if (task.endDate === null && task.progress < 100) continue;
    const spent = parseEffort(task.spent, hoursPerDay);
    const estimate = parseEstimate(task);
    if (spent === null || !(spent > 0) || estimate === null) continue;
    const mean = (estimate.min + 4 * estimate.likely + estimate.max) / 6;
    if (mean > 0) logs.push(Math.log(spent / mean));
  }
  if (logs.length < CALIBRATION_MIN_TASKS) return null;
  const factor = Math.exp(logs.reduce((sum, value) => sum + value, 0) / logs.length);
  return {
    count: logs.length,
    factor: Math.min(FACTOR_RANGE[1], Math.max(FACTOR_RANGE[0], factor)),
  };
}

/**
 * まだ終わっていないタスクの見積もりに倍率を掛けたものを返す。
 *
 * 終わったものは実績で置き換わるので触らない。元の配列は変えない
 * (画面に出す見積もりは、書いたとおりのまま)。
 */
export function applyCalibration(tasks: readonly Task[], factor: number): Task[] {
  const scale = (text: string): string => {
    const value = Number(text);
    return text.trim() === "" || !Number.isFinite(value) ? text : String(value * factor);
  };
  return tasks.map((task) =>
    task.endDate !== null || task.progress >= 100
      ? task
      : { ...task, min: scale(task.min), likely: scale(task.likely), max: scale(task.max) },
  );
}
