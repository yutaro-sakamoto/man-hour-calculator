import assert from "node:assert/strict";
import { test } from "node:test";

import type { Snapshot } from "../api/types.ts";
import { HISTORY_LIMIT, deltaOf, previousSnapshot, recordSnapshot } from "./history.ts";

function snap(date: string, finishP80: number | null = 100, effortP80 = 10): Snapshot {
  return {
    date,
    effortP80,
    finishP50: finishP80,
    finishP80,
    progress: 0.5,
    spent: 5,
    remaining: 5,
    taskCount: 4,
    doneCount: 1,
    taskProgress: {},
  };
}

test("同じ日の控えは置き換え、日付の順に並べる", () => {
  let history = recordSnapshot([], snap("2026-10-09", 100));
  history = recordSnapshot(history, snap("2026-10-02", 90));
  history = recordSnapshot(history, snap("2026-10-09", 104));
  assert.deepEqual(
    history.map((item) => [item.date, item.finishP80]),
    [
      ["2026-10-02", 90],
      ["2026-10-09", 104],
    ],
  );
});

test("上限を超えたら古いものから落とす", () => {
  let history: Snapshot[] = [];
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    history = recordSnapshot(history, snap(day));
  }
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0]?.date, "2026-01-06");
});

test("比べる相手は、今日より前でいちばん新しいもの", () => {
  const history = [snap("2026-10-02"), snap("2026-10-09"), snap("2026-10-16")];
  assert.equal(previousSnapshot(history, "2026-10-16")?.date, "2026-10-09");
  assert.equal(previousSnapshot(history, "2026-10-17")?.date, "2026-10-16");
  assert.equal(previousSnapshot(history, "2026-10-16", 7)?.date, "2026-10-09");
  assert.equal(previousSnapshot(history, "2026-10-15", 7)?.date, "2026-10-02");
  assert.equal(previousSnapshot(history, "2026-10-02"), null);
});

test("差は完了日の日数と工数の増減", () => {
  const delta = deltaOf(snap("2026-10-09", 100, 80), snap("2026-10-16", 104, 86.5));
  assert.equal(delta.finishP80Days, 4);
  assert.equal(delta.effortP80, 6.5);
  assert.equal(deltaOf(snap("a", null), snap("b", 3)).finishP80Days, null);
});
