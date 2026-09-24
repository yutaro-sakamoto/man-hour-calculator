// E2E の両方の spec が使う、ページを開く手順。
//
// 開き方を 1 か所にまとめておくのは、「外部通信 0 件」「ページ内の例外 0 件」
// という見張りを、どの検査も同じ強さで掛けるため。
const path = require("path");
const { pathToFileURL } = require("url");
const { expect } = require("@playwright/test");

const PAGE_URL = pathToFileURL(
  path.resolve(__dirname, "../../dist/app.html"),
).href;

/**
 * 検査のあいだ、画面から見える「いま」。
 *
 * **固定しないとテストが腐る。** 見本データのカレンダーは `startDate` を
 * 今日にし、表示範囲は `startDate` から `horizonDays` 日ぶん。ここで
 * 直書きしている `2026-09-21` のような日付は、実際の今日がそれを追い越した
 * 瞬間に「範囲の外」になって落ちる。実行した日によって結果が変わる検査は、
 * 検査ではない。
 */
const FIXED_NOW = new Date("2026-09-01T09:00:00Z");

/**
 * ページを開き、外部への通信もページ内の例外も起きていないことを保証する。
 * localStorage は毎回まっさらな状態から始める (テスト間で引きずらないため)。
 */
async function open(page, { lang = "ja" } = {}) {
  // 読み込みより先に時計を据える。`todayIso()` は起動時に 1 度読む。
  await page.clock.install({ time: FIXED_NOW });
  const external = [];
  const errors = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("file://")) external.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.goto(PAGE_URL);
  await expect(page.locator(".summary-bar")).toBeVisible();
  await expect(page.locator("#status")).toContainText(/ms\)/);
  // 実行環境の locale に左右されないよう、表示言語を明示的に決めてから始める。
  await page.click(`.lang-toggle button[data-lang="${lang}"]`);
  return { external, errors };
}

module.exports = { PAGE_URL, FIXED_NOW, open };
