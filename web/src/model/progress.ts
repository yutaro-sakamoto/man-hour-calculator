/**
 * 進捗を 1 つの定義にまとめる。
 *
 * ```text
 * 進捗 = 消化工数 / (消化工数 + 残りの最可能値)
 * ```
 *
 * 件数ではなく**工数で重み付ける**。0.5 人日のタスクを終えても 20 人日の
 * まとまりはほとんど動かない、という当たり前の振る舞いを守るため。
 *
 * 数字はすべてエンジンが返したものから引く。`crates/core/src/actuals.rs` が
 * `estimate = remaining + spent` で作っているので、
 * `effective[3i+1] - spent[i]` は近似ではなく厳密に「残りの最可能値」になる。
 *
 * **申告された `Task.progress` (0〜100) には触らない。** エンジンが既に
 * 人日へ直しているので、その結果だけを読む。単位を取り違えようがない。
 */

import type { TreeRow } from "./tree.ts";
import type { TaskState } from "../types.ts";
import type { ComputeResult } from "../wasm.ts";

/** 完了を表す状態コード (`crates/core` の `TaskState`)。 */
const STATE_DONE = 2;

export interface Progress {
  /** 消化した工数 (人日)。 */
  spent: number;
  /** 残りの最可能値 (人日)。 */
  remaining: number;
  /** 消化 + 残り。 */
  total: number;
  /** 0〜1。分母が 0 のときは「全部完了なら 1、そうでなければ 0」。 */
  ratio: number;
  doneCount: number;
  leafCount: number;
}

const EMPTY: Progress = {
  spent: 0,
  remaining: 0,
  total: 0,
  ratio: 0,
  doneCount: 0,
  leafCount: 0,
};

/** 葉の添字をいくつか受け取って、そのぶんの進捗を出す。 */
export function progressOfLeaves(result: ComputeResult, leafIndices: Iterable<number>): Progress {
  let spent = 0;
  let total = 0;
  let doneCount = 0;
  let leafCount = 0;

  for (const leaf of leafIndices) {
    if (leaf < 0 || leaf >= result.nTasks) continue;
    leafCount += 1;
    const leafSpent = finite(result.spent[leaf]);
    const leafTotal = finite(result.effective[leaf * 3 + 1]);
    spent += leafSpent;
    total += Math.max(leafTotal, leafSpent);
    if (result.states[leaf] === STATE_DONE) doneCount += 1;
  }

  if (leafCount === 0) return EMPTY;
  const remaining = Math.max(0, total - spent);
  return {
    spent,
    remaining,
    total,
    // 工数 0 のタスクだけでも「終わったかどうか」は言える。分母が無いときは
    // 件数に落とす。0 除算を 0% と書くと、完了済みが未着手に見えてしまう。
    ratio: total > 0 ? Math.min(1, spent / total) : doneCount === leafCount ? 1 : 0,
    doneCount,
    leafCount,
  };
}

/**
 * まとまり (親タスク) の状態。配下の葉から決める。
 *
 * 親は自分では着手も完了もしないので、エンジンは状態を返さない。そのまま
 * 「未着手」と出すと、配下が 7 割終わっていても未着手に見える。
 */
export function stateOfProgress(progress: Progress): TaskState {
  if (progress.leafCount > 0 && progress.doneCount === progress.leafCount) return "done";
  if (progress.spent > 0 || progress.doneCount > 0) return "inProgress";
  return "notStarted";
}

/** プロジェクト全体。 */
export function progressOverall(result: ComputeResult): Progress {
  return progressOfLeaves(result, range(result.nTasks));
}

/**
 * `rows[at]` とその配下。
 *
 * 葉なら自身だけ。親なら、続く行のうち自分より深いものすべて
 * (`rows` は文書の並びなので、深さが戻るまでが部分木)。
 */
export function progressOfSubtree(
  result: ComputeResult,
  rows: readonly TreeRow[],
  at: number,
): Progress {
  const head = rows[at];
  if (head === undefined) return EMPTY;
  return progressOfLeaves(result, subtreeLeaves(rows, at, head.depth));
}

/** id で行を探してから部分木を集める。表と行 id でしか結べない場面のため。 */
export function progressOfTask(
  result: ComputeResult,
  rows: readonly TreeRow[],
  taskId: string,
): Progress {
  const at = rows.findIndex((row) => row.task.id === taskId);
  return at === -1 ? EMPTY : progressOfSubtree(result, rows, at);
}

function* subtreeLeaves(rows: readonly TreeRow[], at: number, depth: number): Generator<number> {
  for (let i = at; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) break;
    if (i > at && row.depth <= depth) break;
    if (row.leafIndex !== null) yield row.leafIndex;
  }
}

function* range(count: number): Generator<number> {
  for (let i = 0; i < count; i++) yield i;
}

function finite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}
