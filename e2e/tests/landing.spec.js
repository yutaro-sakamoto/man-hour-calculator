// 紹介ページ (dist/index.html) を file:// から開いて検証する。
//
// ここで見るのは「入口として成り立っているか」の 3 つ:
// 開発中だと分かるか、英語が既定か、ボタンから道具に行けるか。

const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const LANDING = pathToFileURL(
  path.resolve(__dirname, "../../dist/index.html"),
).href;

/** 紹介ページを開き、外部への通信もページ内の例外も起きていないことを保証する。 */
async function open(page) {
  const external = [];
  const errors = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("file://")) external.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(LANDING);
  await expect(page.locator("h1").first()).toBeVisible();
  return { external, errors };
}

test("既定は英語で、日本語に切り替えられる", async ({ page }) => {
  // 実行環境の言語に関わらず、まず英語で出す。
  const { external, errors } = await open(page);

  await expect(page.locator("body")).toHaveAttribute("data-lang", "en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator('h1[lang="en"]')).toBeVisible();
  await expect(page.locator('h1[lang="ja"]')).toBeHidden();
  await expect(page.locator('.notice[lang="en"]')).toBeVisible();
  await expect(page.locator('.notice[lang="ja"]')).toBeHidden();

  await page.click('button[data-set-lang="ja"]');
  await expect(page.locator('h1[lang="ja"]')).toBeVisible();
  await expect(page.locator('h1[lang="en"]')).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute("data-lang", "ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.locator('.notice[lang="ja"]')).toBeVisible();
  await expect(page.locator('.notice[lang="en"]')).toBeHidden();

  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test("選んだ言語は覚えている", async ({ page }) => {
  await open(page);
  await page.click('button[data-set-lang="ja"]');
  // 覚えたことを確かめてから読み込み直す。押しただけでは、保存まで
  // 進んだかどうかが分からず、読み込み直しと競争になる。
  await expect(page.locator("body")).toHaveAttribute("data-lang", "ja");
  await expect
    .poll(() =>
      page.evaluate(() => {
        try {
          return localStorage.getItem("mhc.landing.lang");
        } catch {
          return null;
        }
      }),
    )
    .toBe("ja");

  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-lang", "ja");
});

test("開発中であることが両方の言語で書いてある", async ({ page }) => {
  await open(page);
  await expect(page.locator('.notice[lang="en"]')).toContainText(
    "Work in progress",
  );
  await page.click('button[data-set-lang="ja"]');
  await expect(page.locator('.notice[lang="ja"]')).toContainText("開発中");
});

test("ローカル版であることの断りがある", async ({ page }) => {
  await open(page);
  // 何が起きるのか (ブラウザのなかだけ・消えうる) を先に伝える。
  const caveat = page.locator('.caveat[lang="en"]');
  await expect(caveat).toContainText("local version");
  await expect(caveat).toContainText("browser");

  await page.click('button[data-set-lang="ja"]');
  await expect(page.locator('.caveat[lang="ja"]')).toContainText("ローカル版");
});

test("ボタンを押すと見積もりツールが開く", async ({ page }) => {
  await open(page);
  await page.click('a.button.primary[lang="en"]');

  // 道具そのものが立ち上がり、計算まで進む。
  await expect(page.locator(".summary-bar")).toBeVisible();
  await expect(page.locator("#status")).toContainText(/ms\)/);
  await expect(page).toHaveTitle(/工数見積もり/);
});

test("ファイルとして保存するリンクがある", async ({ page }) => {
  await open(page);
  const link = page.locator('a[download][lang="en"]');
  await expect(link).toHaveAttribute("href", "app.html");
  await expect(link).toHaveAttribute("download", "man-hour-calculator.html");
});
