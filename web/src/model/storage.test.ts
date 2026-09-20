import assert from "node:assert/strict";
import { test } from "node:test";

import { at } from "../testing.ts";
import { emptyProject, normalizeProject, sampleProject } from "./project.ts";
import { csvToTasks, projectToCsv } from "./storage.ts";
import { buildRows } from "./tree.ts";

test("CSV に書き出して読み直すと階層と値が戻る", () => {
  const project = sampleProject("ja");
  const csv = projectToCsv(buildRows(project.tasks));
  const restored = csvToTasks(csv);

  assert.equal(restored.length, project.tasks.length);
  const before = buildRows(project.tasks);
  const after = buildRows(restored);
  assert.deepEqual(
    after.map((row) => [row.task.name, row.depth, row.hasChildren]),
    before.map((row) => [row.task.name, row.depth, row.hasChildren]),
  );
  assert.deepEqual(
    after.filter((row) => !row.hasChildren).map((row) => row.rollup),
    before.filter((row) => !row.hasChildren).map((row) => row.rollup),
  );
});

test("カンマや引用符を含む名前も壊れない", () => {
  const project = emptyProject("test");
  const tricky = '設計, 調査 "第1回"';
  project.tasks = csvToTasks(
    `level,name,group,priority,enabled,min,likely,max,startDate,progress,endDate\n` +
      `0,"${tricky.replace(/"/g, '""')}",設計,high,1,1,2,3,,0,\n`,
  );
  assert.equal(at(project.tasks, 0).name, tricky);

  const round = csvToTasks(projectToCsv(buildRows(project.tasks)));
  assert.equal(at(round, 0).name, tricky);
});

test("ヘッダが無い CSV も既定の並びとして読む", () => {
  const tasks = csvToTasks("0,調査,,normal,1,1,2,4,,0,\n1,下調べ,,low,1,1,2,3,,0,");
  assert.equal(tasks.length, 2);
  assert.equal(at(tasks, 1).parentId, at(tasks, 0).id);
  assert.equal(at(tasks, 1).priority, "low");
});

test("空行や末尾の改行を読み飛ばす", () => {
  const tasks = csvToTasks("level,name,min,likely,max\n0,A,1,2,3\n\n0,B,2,3,4\n\n");
  assert.deepEqual(
    tasks.map((task) => task.name),
    ["A", "B"],
  );
});

test("スキーマが違うファイルは受け付けない", () => {
  assert.equal(normalizeProject({ schema: "something-else" }), null);
  assert.equal(normalizeProject(null), null);
  assert.equal(normalizeProject("文字列"), null);
  assert.equal(normalizeProject([]), null);
});

test("壊れた項目は既定値に落として読み込む", () => {
  const project = normalizeProject({
    schema: "man-hour-calculator",
    name: 123,
    tasks: [
      { id: "a", name: "親", parentId: "存在しない" },
      { id: "b", name: "子", parentId: "a", min: "x", likely: 5, max: null, progress: 500 },
    ],
    calendar: {
      hoursPerPersonDay: 0,
      horizonDays: 99999,
      members: [{ id: "m1", name: "佐藤", workdays: "壊れている", breakMinutes: -5 }],
      events: [
        { id: "e1", startDate: "2026-09-21", startTime: "99:99", memberIds: ["m1", "nope"] },
      ],
    },
    settings: { engine: 42, bins: -1 },
  });

  assert.ok(project);
  assert.equal(project.name, "project", "名前が文字列でなければ既定値");
  // 見つからない親はトップレベルに戻す。
  assert.equal(at(project.tasks, 0).parentId, null);
  assert.equal(at(project.tasks, 1).parentId, "a");
  assert.equal(at(project.tasks, 1).min, "0", "数値として読めない値は 0");
  assert.equal(at(project.tasks, 1).likely, "5", "数値はそのまま文字列にする");
  assert.equal(at(project.tasks, 1).progress, 100, "進捗は 0〜100 に収める");
  assert.ok(project.calendar.hoursPerPersonDay > 0, "0 除算になる値は避ける");
  assert.ok(project.calendar.horizonDays <= 1830);

  // 人員の稼働予定が壊れていても既定の形に戻す。
  const member = at(project.calendar.members, 0);
  assert.equal(member.workdays.length, 7);
  assert.equal(member.breakMinutes, 0, "負の休憩は 0 に");
  // 読めない時刻は終日扱い、知らない参加者は落とす。
  const event = at(project.calendar.events, 0);
  assert.equal(event.startTime, null);
  assert.deepEqual(event.memberIds, ["m1"]);
  assert.equal(project.settings.engine, 0, "未知のエンジンは既定に倒す");
  assert.ok(project.settings.bins >= 4);
});

test("サンプルは一貫している", () => {
  for (const language of ["ja", "en"] as const) {
    const project = sampleProject(language);
    const rows = buildRows(project.tasks);
    assert.ok(
      rows.some((row) => row.hasChildren),
      "親子関係を含む",
    );
    assert.ok(
      rows.every((row) => row.valid),
      "すべて妥当な見積もり",
    );
    assert.ok(new Set(project.tasks.map((task) => task.id)).size === project.tasks.length);
  }
});
