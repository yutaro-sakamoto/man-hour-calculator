import assert from "node:assert/strict";
import { test } from "node:test";

import { setLang } from "../i18n.ts";
import { at } from "../testing.ts";
import {
  memberIndexOf,
  memberLabel,
  participantsOf,
  resolveMembers,
  UNASSIGNED_ID,
  weeklyMinutes,
} from "./members.ts";
import { createMember, createTask } from "./project.ts";
import type { Member, Task } from "../types.ts";

function people(count: number): Member[] {
  return Array.from({ length: count }, (_, index) => createMember(`p${String(index)}`));
}

test("担当者が全員そろっていれば仮の人員は足さない", () => {
  const alice = createMember("佐藤");
  const bob = createMember("鈴木");
  const tasks: Task[] = [createTask({ assigneeId: alice.id }), createTask({ assigneeId: bob.id })];

  const resolved = resolveMembers([alice, bob], tasks);
  assert.equal(resolved.all.length, 2);
  assert.equal(resolved.unassignedIndex, null);
  assert.equal(memberIndexOf(resolved, at(tasks, 0)), 0);
  assert.equal(memberIndexOf(resolved, at(tasks, 1)), 1);
});

test("担当者のいないタスクがあれば仮の人員を 1 人だけ足す", () => {
  const alice = createMember("佐藤");
  const tasks: Task[] = [
    createTask({ assigneeId: alice.id }),
    createTask({ assigneeId: null }),
    createTask({ assigneeId: null }),
  ];

  const resolved = resolveMembers([alice], tasks);
  assert.equal(resolved.all.length, 2, "未割当ぶんは 1 人にまとめる");
  assert.equal(resolved.unassignedIndex, 1);
  assert.equal(at(resolved.all, 1).id, UNASSIGNED_ID);
  assert.equal(memberIndexOf(resolved, at(tasks, 1)), 1);
  assert.equal(memberIndexOf(resolved, at(tasks, 2)), 1);
});

test("人員が 1 人もいなくても計算できる形にする", () => {
  const resolved = resolveMembers([], [createTask()]);
  assert.equal(resolved.all.length, 1);
  assert.equal(resolved.unassignedIndex, 0);
  assert.equal(memberIndexOf(resolved, createTask()), 0);
});

test("消えた人員を指しているタスクは未割当に落ちる", () => {
  const alice = createMember("佐藤");
  const orphan = createTask({ assigneeId: "存在しない" });
  const resolved = resolveMembers([alice], [orphan]);
  assert.equal(resolved.unassignedIndex, 1, "仮の人員が足される");
  assert.equal(memberIndexOf(resolved, orphan), 1);
});

test("予定の参加者が空なら全員が対象", () => {
  const resolved = resolveMembers(people(3), [createTask({ assigneeId: null })]);
  // 未割当ぶんを含めて 4 人。
  assert.deepEqual(participantsOf(resolved, []), [0, 1, 2, 3]);
});

test("予定の参加者は指定した人だけになる", () => {
  const members = people(3);
  const resolved = resolveMembers(members, [createTask({ assigneeId: at(members, 0).id })]);
  assert.deepEqual(participantsOf(resolved, [at(members, 2).id, at(members, 0).id]), [2, 0]);
  // 知らない id は落とす。
  assert.deepEqual(participantsOf(resolved, ["なにか"]), []);
});

test("週の稼働分数は休憩を引いた値", () => {
  // 既定は月〜金 9:00〜18:00 から休憩 60 分。
  assert.equal(weeklyMinutes(createMember("既定")), 5 * 8 * 60);

  const halfDay = createMember("時短", {
    workdays: createMember("x").workdays.map((window, index) =>
      index >= 1 && index <= 5 ? { start: "09:00", end: "13:00" } : window,
    ),
    breakMinutes: 0,
  });
  assert.equal(weeklyMinutes(halfDay), 5 * 4 * 60);

  const away = createMember("休職中", {
    workdays: createMember("x").workdays.map(() => ({ start: "00:00", end: "00:00" })),
  });
  assert.equal(weeklyMinutes(away), 0);
});

test("休憩が稼働時間より長くても負にならない", () => {
  const member = createMember("短時間", {
    workdays: createMember("x").workdays.map((_, index) =>
      index === 1 ? { start: "09:00", end: "09:30" } : { start: "00:00", end: "00:00" },
    ),
    breakMinutes: 90,
  });
  assert.equal(weeklyMinutes(member), 0);
});

test("名前が空なら通し番号で呼ぶ", () => {
  // 文言は言語によって変わるので、ここだけ明示的に日本語に固定する。
  setLang("ja");
  assert.equal(memberLabel(createMember("佐藤"), 0), "佐藤");
  assert.equal(memberLabel(createMember("  "), 2), "人員 3");
  setLang("en");
  assert.equal(memberLabel(createMember("  "), 2), "Person 3");
});
