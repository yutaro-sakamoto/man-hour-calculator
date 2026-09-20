import assert from "node:assert/strict";
import { test } from "node:test";

import { dayFromIso } from "../format.ts";
import { occurrencesOn, occursOn, shortTime } from "./events.ts";
import type { CalendarEventItem } from "../types.ts";

const day = (iso: string): number => {
  const value = dayFromIso(iso);
  assert.notEqual(value, null, iso);
  return value ?? 0;
};

function event(over: Partial<CalendarEventItem> = {}): CalendarEventItem {
  return {
    id: "e1",
    name: "定例",
    startDate: "2026-09-07", // 月曜
    endDate: "2026-09-07",
    startTime: "10:00",
    endTime: "11:00",
    repeatWeeks: 0,
    until: null,
    memberIds: [],
    ...over,
  };
}

test("繰り返さない予定は、その期間だけに出る", () => {
  const single = event({ startDate: "2026-09-07", endDate: "2026-09-09" });
  assert.equal(occursOn(single, day("2026-09-06")), false, "前日");
  assert.equal(occursOn(single, day("2026-09-07")), true);
  assert.equal(occursOn(single, day("2026-09-08")), true, "途中");
  assert.equal(occursOn(single, day("2026-09-09")), true);
  assert.equal(occursOn(single, day("2026-09-10")), false, "翌日");
});

test("毎週の予定は同じ曜日に出つづける", () => {
  const weekly = event({ repeatWeeks: 1 });
  for (const iso of ["2026-09-07", "2026-09-14", "2026-09-21", "2026-10-05"]) {
    assert.equal(occursOn(weekly, day(iso)), true, iso);
  }
  assert.equal(occursOn(weekly, day("2026-09-08")), false, "翌日には出ない");
});

test("隔週の予定は 1 週おきに出る", () => {
  const biweekly = event({ repeatWeeks: 2 });
  assert.equal(occursOn(biweekly, day("2026-09-07")), true);
  assert.equal(occursOn(biweekly, day("2026-09-14")), false, "次の週は飛ばす");
  assert.equal(occursOn(biweekly, day("2026-09-21")), true);
});

test("繰り返しは終了日で止まる", () => {
  const weekly = event({ repeatWeeks: 1, until: "2026-09-15" });
  assert.equal(occursOn(weekly, day("2026-09-14")), true);
  assert.equal(occursOn(weekly, day("2026-09-21")), false, "終了日を過ぎた回は出ない");
});

test("期間をまたぐ予定は、繰り返しても各回の全日に出る", () => {
  // 月曜から水曜までの合宿が隔週である、という形。
  const camp = event({ startDate: "2026-09-07", endDate: "2026-09-09", repeatWeeks: 2 });
  for (const iso of ["2026-09-07", "2026-09-08", "2026-09-09"]) {
    assert.equal(occursOn(camp, day(iso)), true, iso);
  }
  assert.equal(occursOn(camp, day("2026-09-10")), false);
  assert.equal(occursOn(camp, day("2026-09-21")), true, "2 週後の初日");
  assert.equal(occursOn(camp, day("2026-09-23")), true, "2 週後の最終日");
  assert.equal(occursOn(camp, day("2026-09-14")), false, "間の週には出ない");
});

test("読めない日付の予定はどこにも出ない", () => {
  assert.equal(occursOn(event({ startDate: "2026/09/07" }), day("2026-09-07")), false);
});

test("升に並べる順は、終日が先で、次に開始の早い順", () => {
  const events: CalendarEventItem[] = [
    event({ id: "b", name: "午後の打ち合わせ", startTime: "14:00", endTime: "15:00" }),
    event({ id: "a", name: "全休", startTime: null, endTime: null }),
    event({ id: "c", name: "朝会", startTime: "09:30", endTime: "09:45" }),
  ];
  assert.deepEqual(
    occurrencesOn(events, day("2026-09-07")).map((o) => o.event.id),
    ["a", "c", "b"],
  );
});

test("初日と最終日が分かる", () => {
  const camp = event({ startDate: "2026-09-07", endDate: "2026-09-09" });
  const on = (iso: string) => occurrencesOn([camp], day(iso))[0];
  assert.deepEqual(
    { starts: on("2026-09-07")?.starts, ends: on("2026-09-07")?.ends },
    { starts: true, ends: false },
  );
  assert.deepEqual(
    { starts: on("2026-09-08")?.starts, ends: on("2026-09-08")?.ends },
    { starts: false, ends: false },
  );
  assert.deepEqual(
    { starts: on("2026-09-09")?.starts, ends: on("2026-09-09")?.ends },
    { starts: false, ends: true },
  );
});

test("繰り返す予定でも、各回の初日は初日として扱う", () => {
  const camp = event({ startDate: "2026-09-07", endDate: "2026-09-08", repeatWeeks: 1 });
  assert.equal(occurrencesOn([camp], day("2026-09-14"))[0]?.starts, true);
  assert.equal(occurrencesOn([camp], day("2026-09-15"))[0]?.ends, true);
});

test("升に出す時刻は先頭の 0 を落とす", () => {
  assert.equal(shortTime(event({ startTime: "09:30" })), "9:30");
  assert.equal(shortTime(event({ startTime: "14:00" })), "14:00");
  assert.equal(shortTime(event({ startTime: null })), "");
});
