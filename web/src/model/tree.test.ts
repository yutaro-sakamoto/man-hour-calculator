import assert from "node:assert/strict";
import { test } from "node:test";

import { createTask } from "./project.ts";
import {
  buildRows,
  collectGroups,
  indentTask,
  insertAfterSubtree,
  moveSubtree,
  outdentTask,
  parseEstimate,
  removeSubtree,
  subtreeRange,
} from "./tree.ts";
import type { Task } from "../types.ts";

/** `名前` または `親>子` の形からタスク列を組み立てる。 */
function build(spec: readonly [string, string | null, string?][]): Task[] {
  const byName = new Map<string, string>();
  return spec.map(([name, parent, likely]) => {
    const task = createTask({
      name,
      parentId: parent === null ? null : (byName.get(parent) ?? null),
      min: likely ?? "1",
      likely: likely ?? "2",
      max: likely ?? "4",
    });
    byName.set(name, task.id);
    return task;
  });
}

const names = (tasks: readonly Task[]): string[] => tasks.map((task) => task.name);

/** 添字で取り出す。無ければその場で落として、どこが欠けたか分かるようにする。 */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  assert.ok(value, `添字 ${String(index)} の要素が無い`);
  return value;
}

/** 設計 > (要件, 基本) / 実装 > (API, 画面) / テスト */
const SAMPLE: [string, string | null, string?][] = [
  ["設計", null],
  ["要件", "設計", "2"],
  ["基本", "設計", "3"],
  ["実装", null],
  ["API", "実装", "4"],
  ["画面", "実装", "5"],
  ["テスト", null, "6"],
];

test("親は配下の葉の合計を持ち、葉には通し番号が振られる", () => {
  const rows = buildRows(build(SAMPLE));

  assert.equal(at(rows, 0).depth, 0);
  assert.equal(at(rows, 1).depth, 1);
  assert.equal(at(rows, 0).hasChildren, true);
  assert.equal(at(rows, 1).hasChildren, false);

  // 設計の集計は 要件(2) + 基本(3)。
  assert.deepEqual(at(rows, 0).rollup, { min: 5, likely: 5, max: 5 });
  // 葉だけが計算対象で、並び順どおりに番号が付く。
  assert.deepEqual(
    rows.filter((row) => row.leafIndex !== null).map((row) => row.task.name),
    ["要件", "基本", "API", "画面", "テスト"],
  );
  // 親が終わるのは配下の最後の葉が終わるとき。
  assert.equal(at(rows, 0).lastLeafIndex, 1);
  assert.equal(at(rows, 3).lastLeafIndex, 3);
});

test("親を無効にすると配下もまとめて計算から外れる", () => {
  const tasks = build(SAMPLE);
  at(tasks, 0).enabled = false;

  const rows = buildRows(tasks);
  assert.equal(at(rows, 0).active, false);
  assert.equal(at(rows, 1).active, false, "子も外れる");
  assert.equal(at(rows, 3).active, true, "別の枝は残る");
  assert.deepEqual(
    rows.filter((row) => row.leafIndex !== null).map((row) => row.task.name),
    ["API", "画面", "テスト"],
  );
});

test("部分木は連続した区間として取り出せる", () => {
  const tasks = build(SAMPLE);
  assert.deepEqual(subtreeRange(tasks, 0), [0, 3]);
  assert.deepEqual(subtreeRange(tasks, 3), [3, 6]);
  assert.deepEqual(subtreeRange(tasks, 6), [6, 7], "葉は自分だけ");
});

test("並べ替えは部分木ごと動く", () => {
  const tasks = build(SAMPLE);

  // 実装フェーズを上へ。設計フェーズの前に丸ごと移る。
  assert.deepEqual(names(moveSubtree(tasks, 3, -1)), [
    "実装",
    "API",
    "画面",
    "設計",
    "要件",
    "基本",
    "テスト",
  ]);

  // 設計フェーズを下へ。
  assert.deepEqual(names(moveSubtree(tasks, 0, 1)), [
    "実装",
    "API",
    "画面",
    "設計",
    "要件",
    "基本",
    "テスト",
  ]);
});

test("末尾の項目も上に動かせる", () => {
  // 兄弟列の末尾にいる場合、移動先の探索で取りこぼしやすい。
  const tasks = build(SAMPLE);
  assert.deepEqual(names(moveSubtree(tasks, 6, -1)), [
    "設計",
    "要件",
    "基本",
    "テスト",
    "実装",
    "API",
    "画面",
  ]);
});

test("端では動かない", () => {
  const tasks = build(SAMPLE);
  assert.deepEqual(names(moveSubtree(tasks, 0, -1)), names(tasks), "先頭を上へ");
  assert.deepEqual(names(moveSubtree(tasks, 6, 1)), names(tasks), "末尾を下へ");
});

test("兄弟のあいだだけで動き、階層はまたがない", () => {
  const tasks = build(SAMPLE);
  // 「基本」を下へ動かしても、設計の子のまま (実装の子にはならない)。
  const moved = moveSubtree(tasks, 2, 1);
  assert.deepEqual(names(moved), names(tasks), "下に兄弟がいないので動かない");

  const up = moveSubtree(tasks, 2, -1);
  assert.deepEqual(names(up), ["設計", "基本", "要件", "実装", "API", "画面", "テスト"]);
  assert.equal(at(buildRows(up), 1).depth, 1, "深さは変わらない");
});

test("階層の上げ下げ", () => {
  const tasks = build(SAMPLE);

  // 「テスト」を下げると「実装」の子になり、配下の末尾に並ぶ。
  const indented = indentTask(tasks, 6);
  const rows = buildRows(indented);
  assert.equal(at(rows, 6).depth, 1);
  assert.equal(at(rows, 3).lastLeafIndex, 4, "実装の完了は テスト の完了になる");

  // 上げると元の階層に戻る。
  const back = outdentTask(indented, 6);
  assert.equal(at(buildRows(back), 6).depth, 0);
  assert.deepEqual(names(back), names(tasks));
});

test("階層を上げると親の部分木の直後に置かれる", () => {
  const tasks = build([
    ["A", null],
    ["A1", "A"],
    ["A2", "A"],
    ["B", null],
  ]);
  // A1 を上げると A の部分木 (A, A2) の後ろ、B の前に来る。
  assert.deepEqual(names(outdentTask(tasks, 1)), ["A", "A2", "A1", "B"]);
});

test("先頭の子は階層を下げられない", () => {
  const tasks = build(SAMPLE);
  assert.deepEqual(names(indentTask(tasks, 0)), names(tasks), "上に兄弟がいない");
});

test("削除と挿入は部分木の単位で行われる", () => {
  const tasks = build(SAMPLE);
  assert.deepEqual(names(removeSubtree(tasks, 0)), ["実装", "API", "画面", "テスト"]);

  const added = insertAfterSubtree(tasks, 0, createTask({ name: "新規" }));
  assert.deepEqual(names(added), ["設計", "要件", "基本", "新規", "実装", "API", "画面", "テスト"]);
});

test("見積もりの妥当性", () => {
  const ok = createTask({ min: "1", likely: "2", max: "3" });
  assert.deepEqual(parseEstimate(ok), { min: 1, likely: 2, max: 3 });

  for (const bad of [
    { min: "3", likely: "2", max: "1" },
    { min: "-1", likely: "2", max: "3" },
    { min: "", likely: "2", max: "3" },
    { min: "abc", likely: "2", max: "3" },
    { min: "1", likely: "5", max: "3" },
  ]) {
    assert.equal(parseEstimate(createTask(bad)), null, JSON.stringify(bad));
  }
});

test("循環した親子関係でも止まらない", () => {
  const tasks = build([
    ["A", null],
    ["B", "A"],
  ]);
  at(tasks, 0).parentId = at(tasks, 1).id; // A と B が互いを親にする

  const rows = buildRows(tasks);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => Number.isFinite(row.depth)));
});

test("グループ名は重複なく並べ替えて集める", () => {
  const tasks = build(SAMPLE);
  for (const [index, group] of [
    [0, "設計"],
    [1, "設計"],
    [3, "実装"],
    [4, "  "],
  ] as const) {
    at(tasks, index).group = group;
  }
  assert.deepEqual(collectGroups(tasks), ["実装", "設計"]);
});
