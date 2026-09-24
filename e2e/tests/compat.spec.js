// 互換性: 狭い画面とタッチでも使えること。
//
// 1 枚の HTML は、スマートフォンで開かれることもある (メールに添付されて届く)。
// 横にはみ出すと、ページ全体を左右に動かさないと読めない。表のように
// 本当に広いものは、その部品の中だけで横に動けばよい。
//
// ブラウザの違い (Firefox / WebKit) は、MHC_BROWSERS で足せる
// (playwright.config.js)。CI は Chromium だけを入れているので既定では回らない。
const { test, expect } = require("@playwright/test");
const { open } = require("./support");

test.use({
  viewport: { width: 360, height: 740 },
  isMobile: true,
  hasTouch: true,
});

const TABS = ["tasks", "forecast", "calendar", "projects"];

test("幅 360px でも、ページそのものは横にはみ出さない", async ({ page }) => {
  const { errors } = await open(page);
  for (const tab of TABS) {
    await page.locator(`.tabs button[data-tab="${tab}"]`).tap();
    const overflow = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      // はみ出している要素のうち、横に動ける入れ物の中に無いもの。
      const offenders = [];
      for (const element of document.body.querySelectorAll("*")) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.right <= width + 1) continue;
        let scrollable = false;
        for (let up = element.parentElement; up; up = up.parentElement) {
          const style = getComputedStyle(up);
          if (
            /(auto|scroll|hidden)/.test(style.overflowX) &&
            up !== document.body
          ) {
            scrollable = true;
            break;
          }
        }
        if (!scrollable) {
          offenders.push(
            `${element.tagName.toLowerCase()}.${element.className} (${Math.round(box.right)}px)`,
          );
        }
      }
      return {
        page: document.documentElement.scrollWidth - width,
        offenders: offenders.slice(0, 5),
      };
    });
    expect(
      overflow.page,
      `${tab}: ページが横に ${overflow.page}px はみ出す ${overflow.offenders.join(", ")}`,
    ).toBeLessThanOrEqual(0);
  }
  expect(errors).toEqual([]);
});

test("タッチで数字を変えると、計算がやり直される", async ({ page }) => {
  await open(page);
  await page.locator('.tabs button[data-tab="tasks"]').tap();
  const before = await page.locator("#status").getAttribute("data-run");
  const input = page
    .locator(".task-table tbody tr")
    .nth(1)
    .locator('input[type="number"]')
    .first();
  await input.tap();
  await input.fill("9");
  await expect(page.locator("#status")).not.toHaveAttribute(
    "data-run",
    before ?? "",
  );
});
