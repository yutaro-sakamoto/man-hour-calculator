// 配布物そのものを file:// で開いて、「1 枚で動き、外に 1 件も通信しない」を
// 毎回検査する。http サーバを立てない — 立てると要件が検査できなくなる。
import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const APP = pathToFileURL(path.resolve("../dist/app.html")).href;

/** 外部通信とページ内例外を数えながら開く。 */
async function open(page) {
  const external = [];
  const errors = [];
  page.on("request", (r) => {
    const url = r.url();
    if (!url.startsWith("file://") && !url.startsWith("data:") && !url.startsWith("blob:")) {
      external.push(url);
    }
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  // 実行した日で結果が変わらないように時計を固定する。
  await page.addInitScript(() => {
    const FIXED = new Date("2026-01-15T00:00:00Z").getTime();
    const Real = Date;
    // eslint-disable-next-line no-global-assign
    Date = class extends Real {
      constructor(...args) {
        super(...(args.length ? args : [FIXED]));
      }
      static now() {
        return FIXED;
      }
    };
  });

  await page.goto(APP);
  return { external, errors };
}

test("file:// で開くだけで動き、外部へ通信しない", async ({ page }) => {
  const { external, errors } = await open(page);
  await expect(page.locator("<<<READY_SELECTOR>>>")).toBeVisible();
  expect(external, `外部への通信: ${external.join(", ")}`).toEqual([]);
  expect(errors, `ページ内の例外: ${errors.join(", ")}`).toEqual([]);
});
