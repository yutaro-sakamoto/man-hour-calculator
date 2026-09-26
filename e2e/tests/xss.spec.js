// 書き込める文字のすべてが、画面のどこに出ても**文字のまま**であること。
//
// 取り決めは「文字は必ず textContent に入れる」(.claude/rules/frontend.md) で、
// ESLint が innerHTML などを禁じている。ここはその結果を配布物で確かめる。
// コメント欄は app.spec.js が見ているので、ここではそれ以外の自由記入欄
// (タスク名・グループ・担当・予定の名前・プロジェクト名 …) を全部埋める。
//
// モンキーテストでも同じ文字を打つが、打った欄がたまたま別の画面に出るとは
// 限らない。わざと innerHTML にした版を 4 本中 1 本でしか捕まえられなかった
// ので、ここでは**全部の欄に書いてから、全部の画面を回る**。
const { test, expect } = require("@playwright/test");
const { open } = require("./support");

const TABS = ["tasks", "forecast", "calendar", "projects"];

/** HTML として解釈されたら、印の付いた要素ができて、印の変数が立つ。 */
const payload = (n) =>
  `<img src=x data-xss=${n} onerror=window.__pwned=${n}><b data-xss=${n}>${n}</b>`;

/** 畳んである節を全部開く。欄が畳みの中に隠れていることが多い。 */
async function unfoldAll(page) {
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details"))
      details.open = true;
  });
}

/** 見えている自由記入欄を 1 つずつ埋める。書いた数を返す。 */
async function fillEveryTextField(page, start) {
  // 検索欄は一覧を絞り込んで、ほかの欄を隠してしまうので外す。
  const fields = page.locator(
    "input[type='text']:visible, input:not([type]):visible, textarea:visible",
  );
  let written = 0;
  const count = await fields.count();
  for (let i = 0; i < count; i++) {
    try {
      // 書くたびに描き直されうるので、毎回数え直した位置で引く。
      await fields.nth(i).fill(payload(start + written), { timeout: 1000 });
      await fields.nth(i).press("Tab", { timeout: 1000 });
      written += 1;
    } catch {
      // 描き直しで欄が消えた・動いた。次へ進む。
    }
  }
  return written;
}

/**
 * タスクの名前とグループを、詳細の窓を 1 件ずつ開いて埋める。
 *
 * 一覧は読むだけで、欄は詳細の窓にしか無い。一覧を舐めるだけでは、
 * いちばん数の多いタスク名を 1 つも書かないまま通ってしまう。
 */
async function fillEveryTaskDetail(page, start) {
  const rows = page.locator(".task-table tbody tr");
  const count = await rows.count();
  let written = 0;
  for (let i = 0; i < count; i++) {
    await rows.nth(i).locator(".row-open").click();
    written += await fillEveryTextField(page, start + written);
    await page.click('.modal-card.detail-card button[title="詳細を閉じる"]');
  }
  return written;
}

test("自由記入欄に書いた HTML は、どの画面でも文字のまま出る", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { external, errors } = await open(page);

  let written = 0;
  for (const tab of TABS) {
    await page.click(`.tabs button[data-tab="${tab}"]`);
    await unfoldAll(page);
    written += await fillEveryTextField(page, written);
    if (tab === "tasks") written += await fillEveryTaskDetail(page, written);
  }
  // 1 画面に数個では検査にならない。見本データなら 20 ほど書ける
  // (入れたときの実測 19)。大きく減ったら、欄を拾えていない。
  expect(written).toBeGreaterThanOrEqual(15);

  // 書いたものが出る画面を、全部回り直す。
  for (const tab of TABS) {
    await page.click(`.tabs button[data-tab="${tab}"]`);
    await unfoldAll(page);
    await expect(page.locator("[data-xss]")).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);

  // 書いたものが、文字として画面に出ていること (欄に残っているだけでなく)。
  await page.click('.tabs button[data-tab="forecast"]');
  await unfoldAll(page);
  await expect(page.locator("body")).toContainText("<img src=x data-xss=");
});

test("訳文の強調だけは要素になり、差し込んだ値は文字のまま", async ({
  page,
}) => {
  await open(page);
  await page.click('.tabs button[data-tab="forecast"]');
  await unfoldAll(page);
  const output = page.locator("#probe-output");
  // 「<b>日数</b> 人日 以内に収まる確率は <b>確率</b>」の 2 か所。
  await expect(output.locator("b")).toHaveCount(2);
  await expect(output).toContainText("以内に収まる確率は");
  await expect(output).not.toContainText("<b>");
});
