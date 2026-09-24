// 性能: いちばん大きいプロジェクトでも待たせすぎず、使い続けても重くならない。
//
// - 上限いっぱい (タスク 500 件・人員 30 人) のファイルを読み込み、計算が
//   終わるまでの時間に予算を置く。WASM の側の上限 (`abi.rs` の MAX_TASKS /
//   MAX_MEMBERS) と同じ大きさ
// - 同じ画面で編集と再計算を何十回も繰り返し (ソーク)、1 回あたりの時間が
//   伸びていかないこと、ヒープが増え続けないこと。取り逃がした参照や
//   描き直しのたびに増える購読は、1 回では見えず、繰り返すと出る
//
// 予算は CI の遅い機械でも通るよう緩めに取る。見たいのは「桁が変わる」退行。
const { test, expect } = require("@playwright/test");
const { open } = require("./support");

const TASKS = 500;
const MEMBERS = 30;

/** 上限いっぱいのプロジェクト。親 50 件の下に子を 9 件ずつ。 */
function largestProject() {
  const members = Array.from({ length: MEMBERS }, (_, i) => ({
    id: `m${i}`,
    name: `Member ${i}`,
    workdays: [
      { start: "00:00", end: "00:00" },
      ...Array.from({ length: 5 }, () => ({ start: "09:00", end: "18:00" })),
      { start: "00:00", end: "00:00" },
    ],
    breakMinutes: 60,
  }));
  const tasks = [];
  for (let i = 0; tasks.length < TASKS; i++) {
    const parent = `p${i}`;
    tasks.push({ id: parent, name: `Phase ${i}`, parentId: null });
    for (let j = 0; j < 9 && tasks.length < TASKS; j++) {
      tasks.push({
        id: `${parent}-${j}`,
        name: `Task ${i}.${j}`,
        parentId: parent,
        // min ≤ likely ≤ max を必ず満たす形で揺らす。
        min: String(1 + (j % 3)),
        likely: String(2 + (j % 3) + (j % 4)),
        max: String(5 + (j % 3) + (j % 4) + (j % 5)),
        assigneeId: `m${(i * 9 + j) % MEMBERS}`,
      });
    }
  }
  return {
    schema: "man-hour-calculator",
    name: "largest",
    document: {
      tasks,
      calendar: { members, horizonDays: 730, hoursPerPersonDay: 8 },
      settings: {},
    },
  };
}

/** 計算が一巡するのを待ち、画面が報告した所要時間 (ms) を返す。 */
async function waitForRun(page, previous) {
  await expect(page.locator("#status")).not.toHaveAttribute(
    "data-run",
    previous ?? "",
    { timeout: 60_000 },
  );
  await expect(page.locator("#status")).toContainText(/\(\d+ ms\)/);
  const text = (await page.locator("#status").textContent()) ?? "";
  return Number(/\((\d+) ms\)/.exec(text)?.[1]);
}

test("上限いっぱいのプロジェクトでも、読み込んで計算し終わるまで 30 秒以内", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { errors } = await open(page);
  const before = await page.locator("#status").getAttribute("data-run");
  const started = Date.now();
  await page.setInputFiles('input[type="file"][accept*="json"]', {
    name: "largest.mhc.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(largestProject())),
  });
  await expect(page.locator("#status")).toContainText(
    /読み込みました|エラー|上限/,
    {
      timeout: 60_000,
    },
  );
  // 読み込みは 1 件足すだけなので、そのプロジェクトに切り替える。
  await page.selectOption(".project-picker", { label: "largest" });
  await page.click('.tabs button[data-tab="tasks"]');
  await expect(page.locator(".task-table tbody tr")).toHaveCount(TASKS, {
    timeout: 60_000,
  });
  const reported = await waitForRun(page, before);
  const elapsed = Date.now() - started;
  console.log(`上限いっぱい: 画面の報告 ${reported} ms / 通しで ${elapsed} ms`);
  // 入れたときの実測は 10〜13 秒 (計算そのものは 2 秒)。残りは 500 行の
  // 表を描き直す時間で、フォーカスを戻すときの強制レイアウトが大きい。
  // 縮めるなら表の仮想化から。CI の遅い機械を見込んで 30 秒に置く。
  expect(elapsed).toBeLessThan(30_000);
  expect(errors).toEqual([]);
});

test("編集と再計算を繰り返しても、遅くならず、ヒープが増え続けない", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { errors } = await open(page);
  await page.click('.tabs button[data-tab="tasks"]');
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Runtime.getHeapUsage")).usedSize;
  };

  const input = page
    .locator(".task-table tbody tr")
    .nth(1)
    .locator('input[type="number"]')
    .first();
  const times = [];
  let heapAfterWarmup = 0;
  const ROUNDS = 60;
  for (let i = 0; i < ROUNDS; i++) {
    const before = await page.locator("#status").getAttribute("data-run");
    await input.fill(String(3 + (i % 5)));
    times.push(await waitForRun(page, before));
    if (i === 9) heapAfterWarmup = await heap();
  }
  const heapAtEnd = await heap();
  const average = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const early = average(times.slice(0, 10));
  const late = average(times.slice(-10));
  const grown = (heapAtEnd - heapAfterWarmup) / 1024 / 1024;
  console.log(
    `再計算: 最初の 10 回 ${early.toFixed(0)} ms / 最後の 10 回 ${late.toFixed(0)} ms / ヒープ +${grown.toFixed(1)} MiB`,
  );
  // 最後のほうが最初の 3 倍 (と 50 ms) を超えて遅いなら、何かが溜まっている。
  expect(late).toBeLessThan(early * 3 + 50);
  // 50 回の編集で 10 MiB 以上増えたら、どこかで離していない。
  expect(grown).toBeLessThan(10);
  expect(errors).toEqual([]);
});
