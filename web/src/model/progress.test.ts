import assert from "node:assert/strict";
import { test } from "node:test";

import {
  progressOfLeaves,
  progressOfSubtree,
  progressOfTask,
  progressOverall,
} from "./progress.ts";
import { createTask } from "./project.ts";
import { buildRows } from "./tree.ts";
import type { Task } from "../types.ts";
import type { ComputeResult } from "../wasm.ts";

/** 葉ごとの「総工数・消化・状態」だけを持つ計算結果。 */
function result(leaves: { total: number; spent: number; state?: number }[]): ComputeResult {
  const effective = new Float64Array(leaves.length * 3);
  leaves.forEach((leaf, index) => {
    effective[index * 3] = leaf.total;
    effective[index * 3 + 1] = leaf.total;
    effective[index * 3 + 2] = leaf.total * 2;
  });
  return {
    nTasks: leaves.length,
    effective,
    spent: new Float64Array(leaves.map((leaf) => leaf.spent)),
    states: new Float64Array(leaves.map((leaf) => leaf.state ?? 0)),
  } as ComputeResult;
}

test("進捗は消化工数 / (消化 + 残り)", () => {
  const progress = progressOfLeaves(result([{ total: 8, spent: 2 }]), [0]);
  assert.equal(progress.spent, 2);
  assert.equal(progress.remaining, 6);
  assert.equal(progress.total, 8);
  assert.equal(progress.ratio, 0.25);
});

test("件数ではなく工数で重み付ける", () => {
  // 0.5 人日を終えても、20 人日のまとまりはほとんど動かない。
  const progress = progressOverall(
    result([
      { total: 0.5, spent: 0.5, state: 2 },
      { total: 20, spent: 0 },
    ]),
  );
  assert.ok(progress.ratio < 0.03, `件数なら 50% になる: ${String(progress.ratio)}`);
  assert.equal(progress.doneCount, 1);
  assert.equal(progress.leafCount, 2);
});

test("申告した進捗率 50% が 100% と出ない", () => {
  // 以前は 0〜100 の `Task.progress` を 0〜1 として扱っていたので、
  // 1% 以上がすべて完了扱いになっていた。ここはエンジンが人日に直した
  // 結果だけを読むので、単位を取り違えようがない。
  const half = progressOverall(result([{ total: 10, spent: 5 }]));
  assert.equal(half.ratio, 0.5);
  const barely = progressOverall(result([{ total: 10, spent: 0.1 }]));
  assert.equal(barely.ratio, 0.01);
});

test("工数 0 のタスクは、終わっていれば 100%", () => {
  assert.equal(progressOverall(result([{ total: 0, spent: 0, state: 2 }])).ratio, 1);
  assert.equal(progressOverall(result([{ total: 0, spent: 0 }])).ratio, 0);
});

test("葉が 1 つも無ければ 0", () => {
  const progress = progressOfLeaves(result([{ total: 5, spent: 1 }]), []);
  assert.equal(progress.ratio, 0);
  assert.equal(progress.leafCount, 0);
});

test("範囲の外の添字は数えない", () => {
  const progress = progressOfLeaves(result([{ total: 5, spent: 1 }]), [0, 7, -1]);
  assert.equal(progress.leafCount, 1);
  assert.equal(progress.total, 5);
});

/** 親 1 つと葉 2 つ、その外にもう 1 つ葉。 */
function tree(): Task[] {
  const parent = createTask({ name: "group" });
  const a = createTask({ name: "a", parentId: parent.id });
  const b = createTask({ name: "b", parentId: parent.id });
  const outside = createTask({ name: "outside" });
  return [parent, a, b, outside];
}

test("親の進捗は配下の葉の単純な和", () => {
  const tasks = tree();
  const rows = buildRows(tasks);
  const computed = result([
    { total: 4, spent: 4, state: 2 },
    { total: 4, spent: 0 },
    { total: 100, spent: 100, state: 2 },
  ]);

  const group = progressOfSubtree(computed, rows, 0);
  assert.equal(group.leafCount, 2, "外の葉は入らない");
  assert.equal(group.total, 8);
  assert.equal(group.ratio, 0.5);
  assert.equal(group.doneCount, 1);

  // 全体では外の葉も入る。
  assert.equal(progressOverall(computed).leafCount, 3);
});

test("葉を指すと、その葉ぶんだけ", () => {
  const tasks = tree();
  const rows = buildRows(tasks);
  const computed = result([
    { total: 4, spent: 1 },
    { total: 4, spent: 3 },
    { total: 1, spent: 0 },
  ]);
  assert.equal(progressOfSubtree(computed, rows, 1).ratio, 0.25);
  assert.equal(progressOfSubtree(computed, rows, 2).ratio, 0.75);
});

test("id からも引ける", () => {
  const tasks = tree();
  const rows = buildRows(tasks);
  const computed = result([
    { total: 4, spent: 2 },
    { total: 4, spent: 2 },
    { total: 1, spent: 0 },
  ]);
  const parent = tasks[0];
  assert.ok(parent);
  assert.equal(progressOfTask(computed, rows, parent.id).ratio, 0.5);
  assert.equal(progressOfTask(computed, rows, "missing").leafCount, 0);
});
