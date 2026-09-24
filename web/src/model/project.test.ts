import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeDocument } from "./project.ts";
import { buildRows, subtreeRange } from "./tree.ts";

const task = (id: string, parentId: string | null = null) => ({
  id,
  name: id,
  parentId,
  min: "1",
  likely: "2",
  max: "3",
});

/**
 * 一覧も集計も CSV も、タスクの配列が**深さ優先の並び** (部分木が連続する)
 * であることを前提にしている (`subtreeRange`)。画面の操作はこの並びを
 * 保つが、読み込んだファイルは保っているとは限らない。
 *
 * ファジング (`fuzz.test.ts`) で見つかった: 並びの崩れたファイルを開くと、
 * 親の集計が子を取りこぼし、CSV に書き出すと親子が組み替わった。
 */
test("読み込むと、タスクは深さ優先の並びに整えられる", () => {
  // D の親 B は、ルートの C より前に居る。
  const document = normalizeDocument({
    tasks: [task("A"), task("B", "A"), task("C"), task("D", "B")],
  });
  assert.deepEqual(
    document.tasks.map((t) => t.id),
    ["A", "B", "D", "C"],
  );
  // A の部分木は A, B, D。集計にも D が入る。
  const rows = buildRows(document.tasks);
  assert.deepEqual(subtreeRange(document.tasks, 0), [0, 3]);
  assert.equal(rows[0]?.rollup.likely, 2);
});

test("兄弟の順番は、ファイルに書かれた順を保つ", () => {
  const document = normalizeDocument({
    tasks: [task("P"), task("x", "P"), task("Q"), task("y", "P"), task("z", "Q")],
  });
  assert.deepEqual(
    document.tasks.map((t) => t.id),
    ["P", "x", "y", "Q", "z"],
  );
});

test("親子が循環していたら、輪を切ってトップレベルに置く", () => {
  const document = normalizeDocument({
    tasks: [task("A", "B"), task("B", "A"), task("C")],
  });
  assert.equal(document.tasks.length, 3);
  const byId = new Map(document.tasks.map((t) => [t.id, t]));
  for (const start of document.tasks) {
    // どこから親をたどっても、いずれトップレベルに着く。
    const seen = new Set<string>();
    let at: string | null = start.id;
    while (at !== null) {
      assert.ok(!seen.has(at), `循環が残っている: ${start.id}`);
      seen.add(at);
      at = byId.get(at)?.parentId ?? null;
    }
  }
});

test("同じ id のタスクが 2 つあっても、どちらも捨てない", () => {
  const document = normalizeDocument({ tasks: [task("A"), task("A"), task("B", "A")] });
  assert.equal(document.tasks.length, 3);
});
