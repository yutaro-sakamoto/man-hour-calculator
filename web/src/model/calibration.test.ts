import assert from "node:assert/strict";
import { test } from "node:test";

import { applyCalibration, calibrationOf } from "./calibration.ts";
import { createTask } from "./project.ts";

const done = (spent: string) =>
  createTask({ min: "2", likely: "4", max: "6", endDate: "2026-10-09", progress: 100, spent });

test("終わったタスクが 3 件そろえば、見積もりの何倍かかったかを出す", () => {
  // 期待値 4 人日に対して 5 人日 (= 40h) ずつ。
  const result = calibrationOf([done("5"), done("40h"), done("5"), createTask()], 8);
  assert.ok(result);
  assert.equal(result.count, 3);
  assert.ok(Math.abs(result.factor - 1.25) < 1e-9);
});

test("実績の無いもの・足りないときは出さない", () => {
  assert.equal(calibrationOf([done("5"), done("")], 8), null);
});

test("倍率は終わっていないタスクにだけ掛ける", () => {
  const open = createTask({ min: "1", likely: "2", max: "4" });
  const [a, b] = applyCalibration([done("5"), open], 1.5);
  assert.equal(a?.likely, "4");
  assert.deepEqual([b?.min, b?.likely, b?.max], ["1.5", "3", "6"]);
  assert.equal(open.likely, "2", "元の見積もりは書いたとおり");
});
