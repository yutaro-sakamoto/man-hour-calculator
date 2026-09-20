import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatus, slackDays } from "./status.ts";
import { createTask, emptyDocument } from "./project.ts";
import { buildRows } from "./tree.ts";
import type { ProjectSummary } from "../api/types.ts";
import type { ScheduleModel } from "./schedule.ts";
import type { ComputeResult } from "../wasm.ts";

const NOW = "2026-09-20T10:00:00Z";

/** 必要なところだけ埋めた計算結果。 */
function result(over: Partial<ComputeResult> = {}): ComputeResult {
  const percentiles = new Float64Array(7);
  percentiles[2] = 10; // P50
  percentiles[4] = 14; // P80
  return {
    percentiles,
    totalSpent: 3,
    states: new Float64Array([0, 0]),
    ...over,
  } as ComputeResult;
}

const schedule = (p50: number | null, p80: number | null): ScheduleModel =>
  ({
    startDay: 20_000,
    overallMarks: { p10: null, p25: null, p50, p75: null, p80, p90: null },
  }) as ScheduleModel;

function documentWith(tasks: { likely: string; progress: number }[]) {
  const document = emptyDocument();
  document.tasks = tasks.map((task, index) =>
    createTask({
      name: `t${String(index)}`,
      min: task.likely,
      likely: task.likely,
      max: task.likely,
    }),
  );
  document.tasks.forEach((task, index) => {
    task.progress = tasks[index]?.progress ?? 0;
  });
  return document;
}

test("控えは計算結果をそのまま写す", () => {
  const document = documentWith([
    { likely: "1", progress: 0 },
    { likely: "1", progress: 0 },
  ]);
  const status = buildStatus(document, buildRows(document.tasks), result(), schedule(5, 9), NOW);

  assert.equal(status.effortP50, 10);
  assert.equal(status.effortP80, 14);
  assert.equal(status.spent, 3);
  assert.equal(status.taskCount, 2);
  // 完了日は暦の先頭からの相対値ではなく、1970-01-01 からの日数で持つ。
  assert.equal(status.finishP50, 20_005);
  assert.equal(status.finishP80, 20_009);
});

test("期間内に終わらない場合は完了日を持たない", () => {
  const document = documentWith([{ likely: "1", progress: 0 }]);
  const status = buildStatus(
    document,
    buildRows(document.tasks),
    result({ states: new Float64Array([0]) }),
    schedule(null, null),
    NOW,
  );
  assert.equal(status.finishP50, null);
  assert.equal(status.finishP80, null);
});

test("進捗は予定の大きさで重みを付ける", () => {
  // 件数で数えると、小さなタスクをたくさん終えただけで進んだように見える。
  const document = documentWith([
    { likely: "1", progress: 1 },
    { likely: "9", progress: 0 },
  ]);
  const status = buildStatus(
    document,
    buildRows(document.tasks),
    result({ states: new Float64Array([2, 0]) }),
    schedule(5, 9),
    NOW,
  );
  assert.equal(status.progress, 0.1);
  assert.equal(status.doneCount, 1);
});

test("何も無ければ進捗は 0 で、0 除算にならない", () => {
  const document = documentWith([{ likely: "0", progress: 0.5 }]);
  const status = buildStatus(
    document,
    buildRows(document.tasks),
    result({ states: new Float64Array([0]) }),
    schedule(null, null),
    NOW,
  );
  assert.equal(status.progress, 0);
});

test("基準は空で送る (保存時刻はサーバが刻む)", () => {
  const document = documentWith([{ likely: "1", progress: 0 }]);
  const status = buildStatus(
    document,
    buildRows(document.tasks),
    result({ states: new Float64Array([0]) }),
    schedule(5, 9),
    NOW,
  );
  assert.equal(status.basedOn, "");
  assert.equal(status.computedAt, NOW);
});

/** 一覧の 1 行のうち、余裕の計算に要るところだけ。 */
const summary = (dueDate: string | null, finishP80: number | null): ProjectSummary =>
  ({
    dueDate,
    status: finishP80 === null ? null : ({ finishP80 } as ProjectSummary["status"]),
  }) as ProjectSummary;

test("余裕は期限と P80 完了日の差", () => {
  // 2026-10-01 は 1970-01-01 から 20727 日。
  assert.equal(slackDays(summary("2026-10-01", 20_720)), 7);
  assert.equal(slackDays(summary("2026-10-01", 20_730)), -3);
});

test("期限か見込みが無ければ余裕は出さない", () => {
  assert.equal(slackDays(summary(null, 20_720)), null);
  assert.equal(slackDays(summary("2026-10-01", null)), null);
  assert.equal(slackDays(summary("2026/10/01", 20_720)), null, "読めない日付");
});
