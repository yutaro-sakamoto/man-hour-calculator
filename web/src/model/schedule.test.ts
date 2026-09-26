import assert from "node:assert/strict";
import { test } from "node:test";

import { DAY_FLAG } from "../abi.ts";
import { dayFromIso } from "../format.ts";
import type { ComputeResult } from "../wasm.ts";
import { createTask } from "./project.ts";
import { actualSpanOf, buildScheduleModel, isNonWorkingDay, prefixCdfAt } from "./schedule.ts";
import { buildRows } from "./tree.ts";

const START = dayFromIso("2026-09-01") ?? 0;

function leaves(dates: { start?: string; end?: string }[]) {
  const tasks = dates.map((date) =>
    createTask({ startDate: date.start ?? null, endDate: date.end ?? null }),
  );
  return buildRows(tasks).filter((row) => row.leafIndex !== null);
}

test("実績の期間は、いちばん早い着手からいちばん遅い完了まで", () => {
  const span = actualSpanOf(
    leaves([
      { start: "2026-09-03", end: "2026-09-05" },
      { start: "2026-09-02", end: "2026-09-10" },
    ]),
    START,
  );
  assert.deepEqual(span, { start: 1, end: 9 });
});

test("1 件でも終わっていなければ、まとまりの完了日は無い", () => {
  // 終わった葉の完了日を出すと、まだ続いている親が「終わった」ように描かれる。
  const span = actualSpanOf(
    leaves([{ start: "2026-09-02", end: "2026-09-04" }, { start: "2026-09-05" }]),
    START,
  );
  assert.deepEqual(span, { start: 1, end: null });
});

test("着手していなければ何も無い", () => {
  assert.deepEqual(actualSpanOf(leaves([{}, {}]), START), { start: null, end: null });
  assert.deepEqual(actualSpanOf([], START), { start: null, end: null });
});

test("期間の初日より前の着手は負の日数になる", () => {
  // 切り捨てて 0 にすると、図の左端から始まったのか、そこで着手したのか
  // 見分けられない。切るのは描く側の仕事。
  assert.equal(actualSpanOf(leaves([{ start: "2026-08-30" }]), START).start, -2);
});

test("日付として読めない値は無視する", () => {
  assert.deepEqual(actualSpanOf(leaves([{ start: "2026-02-31", end: "x" }]), START), {
    start: null,
    end: null,
  });
});

/**
 * 1 人・2 タスク・4 日の小さな計算結果。
 *
 * 担当者の工数の目盛りは 0・2・4 人日 (`memberGridHi = 4`、幅 3)。1 日 1 人日
 * 積み上がる。タスク 0 は累積 2 人日で必ず終わり、タスク 1 (0 との合計) は
 * 累積 4 人日で必ず終わる。
 */
function tinyResult(dayFlags: number[] = [0, 0, 0, 0]): ComputeResult {
  return {
    nTasks: 2,
    nMembers: 1,
    nDays: 4,
    prefixWidth: 3,
    memberGridHi: new Float64Array([4]),
    assignees: new Float64Array([0, 0]),
    prefix: new Float64Array([0, 1, 1, 0, 0, 1]),
    cumulative: new Float64Array([1, 2, 3, 4]),
    dayFlags: new Float64Array(dayFlags),
    calendarStartDay: START,
    effective: new Float64Array([2, 2, 2, 2, 2, 2]),
    spent: new Float64Array([2, 0]),
    states: new Float64Array([2, 0]),
  } as unknown as ComputeResult;
}

/** 親 1 つの下に葉 2 つ。 */
function tinyRows() {
  const parent = createTask({ name: "parent" });
  const a = createTask({
    name: "a",
    parentId: parent.id,
    startDate: "2026-09-02",
    endDate: "2026-09-03",
  });
  const b = createTask({ name: "", parentId: parent.id });
  return buildRows([parent, a, b]);
}

test("累積の CDF は目盛りのあいだを線形に補う", () => {
  const result = tinyResult();
  assert.equal(prefixCdfAt(result, 0, 1), 0.5);
  assert.equal(prefixCdfAt(result, 0, -1), 0);
  assert.equal(prefixCdfAt(result, 1, 3), 0.5);
  assert.equal(prefixCdfAt(result, 1, 99), 1);
});

test("行ごとに完了確率・進捗・実績がそろう", () => {
  const model = buildScheduleModel(tinyResult(), tinyRows(), START + 1, "untitled", ["Alice"]);
  assert.equal(model.rows.length, 3);
  const [parent, a, b] = model.rows;
  assert.ok(parent && a && b);

  // 同じ人の後ろのタスクが終われば前も終わっているので、親は最後の葉と同じ。
  assert.deepEqual([...parent.probabilities], [...b.probabilities]);
  assert.deepEqual([...a.probabilities], [0.5, 1, 1, 1]);
  assert.equal(a.marks.p50, 0);
  assert.equal(b.marks.p50, 2);
  assert.equal(b.label, "untitled");
  assert.ok(a.done);
  assert.ok(!b.done);

  // 進捗は工数で重み付ける。a は 2 人日を終え、b は 2 人日残っている。
  assert.equal(parent.progress.ratio, 0.5);
  assert.equal(a.progress.ratio, 1);
  assert.equal(b.progress.ratio, 0);

  // 実績は a だけ。b に完了日が無いので、親はまだ終わっていない。
  assert.deepEqual(a.actual, { start: 1, end: 2 });
  assert.deepEqual(parent.actual, { start: 1, end: null });
  assert.deepEqual(model.overallActual, { start: 1, end: null });
  assert.equal(model.overallProgress.ratio, 0.5);

  assert.equal(model.todayIndex, 1);
  assert.equal(model.overallMarks.p80, 3);
  assert.equal(model.members[0]?.taskCount, 2);
});

test("基準日が期間の外なら、今日の印は無い", () => {
  const model = buildScheduleModel(tinyResult(), tinyRows(), START - 10, "untitled", ["Alice"]);
  assert.equal(model.todayIndex, null);
});

test("休日出勤は非稼働日にしない", () => {
  assert.ok(isNonWorkingDay(DAY_FLAG.weekend));
  assert.ok(isNonWorkingDay(DAY_FLAG.holiday));
  assert.ok(!isNonWorkingDay(DAY_FLAG.holiday | DAY_FLAG.forcedWorkday));
  assert.ok(!isNonWorkingDay(DAY_FLAG.event));

  const model = buildScheduleModel(
    tinyResult([DAY_FLAG.weekend, 0, DAY_FLAG.holiday, 0]),
    tinyRows(),
    START,
    "untitled",
    ["Alice"],
  );
  assert.ok(isNonWorkingDay(model.dayFlags[0] ?? 0));
  assert.ok(!isNonWorkingDay(model.dayFlags[1] ?? 0));
});
