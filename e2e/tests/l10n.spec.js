// 英語の画面に、日本語が残っていないこと (訳し忘れ・訳を通さず直書きした文字)。
//
// 訳の表そのものは web/src/i18n.test.ts が見ている。ここは**画面に出た文字**を
// 見る。表を通さずに書いた文字や、Rust 側から来た文字 (祝日の名前など) は
// 表の検査では見つからない。
//
// 見本データは起動した環境の言語で作られるので、英語の環境で開く。
const { test, expect } = require("@playwright/test");
const { open } = require("./support");

test.use({ locale: "en-US" });

const TABS = ["tasks", "forecast", "calendar", "projects"];

test("英語の画面に、日本語の文字が出ていない", async ({ page }) => {
  await open(page, { lang: "en" });
  for (const tab of TABS) {
    await page.click(`.tabs button[data-tab="${tab}"]`);
    await page.evaluate(() => {
      for (const details of document.querySelectorAll("details"))
        details.open = true;
    });
    const leftovers = await page.evaluate(() => {
      const japanese = /[぀-ヿ㐀-鿿]+/g;
      const out = new Set();
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        // noscript は両方の言語で書いてある。言語の切り替えボタンは
        // その言語自身の名前で書く (英語の画面でも「日本語」)。
        if (parent?.closest("script, style, noscript, .lang-toggle")) continue;
        for (const match of (node.textContent ?? "").matchAll(japanese)) {
          out.add(`${match[0]} (${parent?.className || parent?.tagName})`);
        }
      }
      for (const element of document.querySelectorAll(
        "[title], [aria-label], [placeholder]",
      )) {
        if (element.closest(".lang-toggle")) continue;
        for (const name of ["title", "aria-label", "placeholder"]) {
          const value = element.getAttribute(name) ?? "";
          if (japanese.test(value)) out.add(`${name}="${value}"`);
          japanese.lastIndex = 0;
        }
      }
      return [...out];
    });
    expect(leftovers, `${tab} タブ`).toEqual([]);
  }
});

test("日本語と英語を行き来しても、数字と日付は崩れない", async ({ page }) => {
  await open(page, { lang: "en" });
  const read = () =>
    page
      .locator('.summary-item[data-key="effortP80"]')
      .getAttribute("data-value");
  const english = await read();
  await page.click('.lang-toggle button[data-lang="ja"]');
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  // 表示の言語を変えても、計算の値 (data-value の素の値) は変わらない。
  expect(await read()).toBe(english);
  await page.click('.lang-toggle button[data-lang="en"]');
  expect(await read()).toBe(english);
});
