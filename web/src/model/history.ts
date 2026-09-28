/**
 * 見通しの控えを日ごとに残す。
 *
 * 週報では「先週からどう変わったか」を必ず聞かれる。控えが無かったころは、
 * PM が毎週の数字を手で書き写して引き算していた。計算し直すたびに、
 * その日 (基準日) の見通しを 1 件残しておく。
 */

import type { ProjectStatus, Snapshot } from "../api/types.ts";

/** 残す件数の上限。毎日開いても 1 年ぶん弱。 */
export const HISTORY_LIMIT = 300;

/** いまの見通しから、その日の控えを作る。 */
export function snapshotOf(
  date: string,
  status: ProjectStatus,
  remaining: number,
  tasks: readonly { id: string; progress: number }[] = [],
  chances: { due: number | null; budget: number | null } = { due: null, budget: null },
): Snapshot {
  return {
    date,
    effortP80: status.effortP80,
    finishP50: status.finishP50,
    finishP80: status.finishP80,
    progress: status.progress,
    spent: status.spent,
    remaining,
    taskCount: status.taskCount,
    doneCount: status.doneCount,
    taskProgress: Object.fromEntries(tasks.map((task) => [task.id, task.progress])),
    dueProbability: chances.due,
    budgetProbability: chances.budget,
  };
}

/**
 * 控えを足す。**同じ日のものは置き換える** (その日の最後の見通しが残る)。
 *
 * 日付の順に並べ直す。基準日を過去に戻して入れ直した場合も、前後を
 * 取り違えないように。
 */
export function recordSnapshot(history: readonly Snapshot[], next: Snapshot): Snapshot[] {
  const kept = history.filter((item) => item.date !== next.date);
  kept.push(next);
  kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return kept.slice(-HISTORY_LIMIT);
}

/**
 * 比べる相手。`today` より前のうち、`minDays` 日以上前でいちばん新しいもの。
 *
 * 既定は 1 日前。毎日開く人には前日との差、週に 1 度の人には先週との差になる。
 * 見つからなければ `null`。
 */
export function previousSnapshot(
  history: readonly Snapshot[],
  today: string,
  minDays = 1,
): Snapshot | null {
  const limit = shiftIso(today, -minDays);
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item !== undefined && item.date <= limit) return item;
  }
  return null;
}

/** 前回との差。完了日は日数、工数は人日、進捗は 0〜1 の差。 */
export interface SnapshotDelta {
  finishP80Days: number | null;
  effortP80: number;
  progress: number;
  spent: number;
  taskCount: number;
}

export function deltaOf(previous: Snapshot, current: Snapshot): SnapshotDelta {
  return {
    finishP80Days:
      previous.finishP80 === null || current.finishP80 === null
        ? null
        : current.finishP80 - previous.finishP80,
    effortP80: current.effortP80 - previous.effortP80,
    progress: current.progress - previous.progress,
    spent: current.spent - previous.spent,
    taskCount: current.taskCount - previous.taskCount,
  };
}

function shiftIso(iso: string, days: number): string {
  const time = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(time)) return iso;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}
