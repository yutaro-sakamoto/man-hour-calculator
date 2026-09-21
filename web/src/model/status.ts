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
import { progressOverall } from "./progress.ts";
import type { ScheduleModel } from "./schedule.ts";
import type { ComputeResult } from "../wasm.ts";

/**
 * 計算結果から控えを作る。
 *
 * `basedOn` は空で送る。「いま送る内容から計算したもの」であることは
 * 呼び出しの形で決まっているので、保存時刻はサーバが刻む
 * (サーバ経由のときクライアントはサーバの時計を知らない)。
 */
export function buildStatus(
  document: ProjectDocument,
  result: ComputeResult,
  schedule: ScheduleModel | null,
  computedAt: string,
): ProjectStatus {
  const absolute = (day: number | null): number | null =>
    day === null || schedule === null ? null : schedule.startDay + day;

  // 進捗の定義は 1 か所 (`progress.ts`)。画面に出るものと、サーバが
  // 遅延を判定するのに使うものが食い違ってはいけない。
  const progress = progressOverall(result);

  return {
    computedAt,
    basedOn: "",
    effortP50: result.percentiles[P50_INDEX] ?? 0,
    effortP80: result.percentiles[P80_INDEX] ?? 0,
    finishP50: absolute(schedule?.overallMarks.p50 ?? null),
    finishP80: absolute(schedule?.overallMarks.p80 ?? null),
    spent: result.totalSpent,
    progress: progress.ratio,
    taskCount: document.tasks.length,
    doneCount: progress.doneCount,
  };
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
