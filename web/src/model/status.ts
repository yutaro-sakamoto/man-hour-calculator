/**
 * 一覧に出す見通しの控えを組み立てる。
 *
 * 一覧のたびに全プロジェクトの中身を計算し直すのは、サーバでも重い。
 * そこで**計算はクライアントが保存時に 1 回だけ行い**、その結果を
 * 保存に添えて送る。遅延の判定はサーバ (`crates/api/src/health.rs`) が
 * この控えから行うので、判定そのものは 1 か所にしかない。
 */

import { P50_INDEX, P80_INDEX } from "../abi.ts";
import { dayFromIso } from "../format.ts";
import type { ProjectDocument, ProjectStatus, ProjectSummary } from "../api/types.ts";
import type { ScheduleModel } from "./schedule.ts";
import type { TreeRow } from "./tree.ts";
import type { ComputeResult } from "../wasm.ts";

/** 完了を表す状態コード (`crates/core` の `TaskState`)。 */
const STATE_DONE = 2;

/**
 * 計算結果から控えを作る。
 *
 * `basedOn` は空で送る。「いま送る内容から計算したもの」であることは
 * 呼び出しの形で決まっているので、保存時刻はサーバが刻む
 * (サーバ経由のときクライアントはサーバの時計を知らない)。
 */
export function buildStatus(
  document: ProjectDocument,
  rows: readonly TreeRow[],
  result: ComputeResult,
  schedule: ScheduleModel | null,
  computedAt: string,
): ProjectStatus {
  const absolute = (day: number | null): number | null =>
    day === null || schedule === null ? null : schedule.startDay + day;

  // 進捗は「予定の大きさで重みを付けた平均」。件数で数えると、
  // 小さなタスクをたくさん終えただけで進んだように見えてしまう。
  let weight = 0;
  let weighted = 0;
  let done = 0;
  for (const row of rows) {
    if (row.leafIndex === null) continue;
    const size = Number(row.task.likely) || 0;
    weight += size;
    weighted += size * clamp01(row.task.progress);
    if (result.states[row.leafIndex] === STATE_DONE) done += 1;
  }

  return {
    computedAt,
    basedOn: "",
    effortP50: result.percentiles[P50_INDEX] ?? 0,
    effortP80: result.percentiles[P80_INDEX] ?? 0,
    finishP50: absolute(schedule?.overallMarks.p50 ?? null),
    finishP80: absolute(schedule?.overallMarks.p80 ?? null),
    spent: result.totalSpent,
    progress: weight > 0 ? weighted / weight : 0,
    taskCount: document.tasks.length,
    doneCount: done,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 期限までの余裕 (日)。負なら足りない。
 *
 * 見るのは P80。5 割で間に合うだけでは「余裕がある」とは言えない。
 */
export function slackDays(project: ProjectSummary): number | null {
  const due = dayFromIso(project.dueDate);
  const finish = project.status?.finishP80 ?? null;
  if (due === null || finish === null) return null;
  return due - finish;
}
