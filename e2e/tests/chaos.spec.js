// 障害の注入: ブラウザの側が思いどおりに動かないときも、道具は使えること。
//
// - localStorage が満杯 (QuotaExceededError)。添付の多いコメントで実際に起きる
// - localStorage そのものが使えない (プライベートモードや、ファイルを開いた
//   ときの設定で SecurityError になるブラウザがある)
//
// どちらでも、ページ内で例外が漏れず (open() が数えている)、計算と編集が
// 続けられること。保存できないことは画面で伝わること。
const { test, expect } = require("@playwright/test");
const { open } = require("./support");

const FAULTS = {
  満杯: () => {
    Storage.prototype.setItem = function () {
      throw new DOMException("満杯", "QuotaExceededError");
    };
  },
  使えない: () => {
    for (const name of ["getItem", "setItem", "removeItem", "clear", "key"]) {
      Storage.prototype[name] = function () {
        throw new DOMException("使えない", "SecurityError");
      };
    }
  },
};

for (const [name, fault] of Object.entries(FAULTS)) {
  test(`localStorage が${name}でも、計算と編集は続けられる`, async ({
    page,
  }) => {
    await page.addInitScript(fault);
    const { errors, external } = await open(page);

    await page.click('.tabs button[data-tab="tasks"]');
    const before = await page
      .locator('.summary-item[data-key="effortP80"]')
      .getAttribute("data-value");
    const run = await page.locator("#status").getAttribute("data-run");
    await page
      .locator(".task-table tbody tr")
      .nth(1)
      .locator('input[type="number"]')
      .first()
      .fill("40");
    // 計算が一巡し、結果が変わる。
    await expect(page.locator("#status")).not.toHaveAttribute(
      "data-run",
      run ?? "",
    );
    await expect(
      page.locator('.summary-item[data-key="effortP80"]'),
    ).not.toHaveAttribute("data-value", before ?? "");

    // 保存できていないことを、黙らずに画面で伝える。
    await expect(page.locator("#storage-warning")).toBeVisible();

    // ほかの画面も開ける。
    for (const tab of ["forecast", "calendar", "projects"]) {
      await page.click(`.tabs button[data-tab="${tab}"]`);
    }
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
}
