import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addDays,
  dayFromIso,
  formatDayShort,
  formatMonthShort,
  isoFromDay,
  monthBounds,
  weekdayOfDay,
} from "./format.ts";

test("日付と日数を往復できる", () => {
  assert.equal(dayFromIso("1970-01-01"), 0);
  assert.equal(isoFromDay(0), "1970-01-01");
  assert.equal(dayFromIso("2026-09-20"), 20716);
  assert.equal(isoFromDay(20716), "2026-09-20");

  for (let day = -3000; day < 30000; day += 37) {
    assert.equal(dayFromIso(isoFromDay(day)), day, `day = ${String(day)}`);
  }
});

test("曜日は 0 が日曜", () => {
  assert.equal(weekdayOfDay(dayFromIso("2026-09-20") ?? 0), 0, "2026-09-20 は日曜");
  assert.equal(weekdayOfDay(dayFromIso("2026-09-21") ?? 0), 1, "月曜");
  assert.equal(weekdayOfDay(0), 4, "1970-01-01 は木曜");
});

test("うるう年をまたいでも正しい", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2025-02-28", 1), "2025-03-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("不正な日付は null になる", () => {
  for (const bad of ["", "2026-13-01", "2026-02-31", "2026/09/20", "20260920", "abc"]) {
    assert.equal(dayFromIso(bad), null, bad);
  }
  assert.equal(dayFromIso(null), null);
  assert.equal(dayFromIso(undefined), null);
});

test("月の範囲", () => {
  assert.deepEqual(monthBounds(2026, 2), { first: dayFromIso("2026-02-01"), length: 28 });
  assert.deepEqual(monthBounds(2024, 2), { first: dayFromIso("2024-02-01"), length: 29 });
  assert.deepEqual(monthBounds(2026, 12), { first: dayFromIso("2026-12-01"), length: 31 });
});

test("日付の表記", () => {
  const day = dayFromIso("2026-11-05") ?? 0;
  assert.equal(formatDayShort(day, "ja"), "11/5(木)");
  assert.equal(formatDayShort(day, "en"), "Nov 5 (Thu)");
  // 年をまたぐところだけ年を添える。
  assert.equal(formatMonthShort(2026, 11, "ja"), "11月");
  assert.equal(formatMonthShort(2027, 1, "ja"), "2027年1月");
  assert.equal(formatMonthShort(2026, 11, "en"), "Nov");
  assert.equal(formatMonthShort(2027, 1, "en"), "Jan 2027");
});
