// アクセシビリティ: 配布物を axe (WCAG 2.2 AA までの自動検査) に掛ける。
//
// 自動で分かるのは WCAG のうち 3〜4 割 (名前の無い部品、色の対比、
// 見出しの構造など)。残り (意味の通る読み上げ順、分かりやすい文言) は
// 人の目が要る。ここでは**機械で分かるぶんを 0 件に保つ**。
//
// axe は `<script>` で差し込むと CSP が止める (それが CSP の仕事)。
// 開発者ツール越し (`page.evaluate`) に読み込む。
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");
const { open } = require("./support");

const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const LANDING = pathToFileURL(
  path.resolve(__dirname, "../../dist/index.html"),
).href;
const TABS = ["tasks", "forecast", "calendar", "projects"];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** axe を走らせて、違反を読める形で返す。 */
async function violations(page) {
  await page.evaluate(AXE);
  const result = await page.evaluate(
    (tags) => axe.run(document, { runOnly: { type: "tag", values: tags } }),
    TAGS,
  );
  return result.violations.map(
    (v) =>
      `${v.impact} ${v.id}: ${v.help} — ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(
          " | ",
        )}${v.nodes.length > 3 ? ` ほか ${v.nodes.length - 3} 件` : ""}`,
  );
}

async function unfoldAll(page) {
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details"))
      details.open = true;
  });
}

for (const lang of ["ja", "en"]) {
  for (const scheme of ["light", "dark"]) {
    test(`axe: どの画面も違反 0 件 (${lang}, ${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, { lang });
      for (const tab of TABS) {
        await page.click(`.tabs button[data-tab="${tab}"]`);
        await unfoldAll(page);
        expect(await violations(page), `${tab} タブ`).toEqual([]);
      }
    });
  }
}

test("axe: 紹介ページも違反 0 件", async ({ page }) => {
  for (const lang of ["en", "ja"]) {
    await page.goto(LANDING);
    await page.click(`[data-set-lang="${lang}"]`);
    expect(await violations(page), lang).toEqual([]);
  }
});

/**
 * 窓 (aria-modal) を開いたら、フォーカスが窓の中に入り、Esc で閉じる。
 *
 * フォーカスが窓の後ろに残ると、キーボードの利用者は窓の中に入れず、
 * Esc も効かない。コメント欄だけがそうなっていた (モンキーテストで見つかった)。
 */
test("どの窓も、開くとフォーカスが入り、Esc で閉じる", async ({ page }) => {
  await open(page);
  const openers = [
    [
      "コメント",
      async () => {
        await page.click('.tabs button[data-tab="tasks"]');
        await page
          .locator(".task-table tbody tr")
          .nth(1)
          .locator(".comment-open")
          .click();
      },
    ],
    [
      "タスクの詳細",
      async () => {
        await page.click('.tabs button[data-tab="tasks"]');
        await page
          .locator(".task-table tbody tr")
          .nth(1)
          .locator('button[title*="詳細"]')
          .click();
      },
    ],
    [
      "予定",
      async () => {
        await page.click('.tabs button[data-tab="calendar"]');
        await page.locator(".event-chip").first().click();
      },
    ],
  ];
  for (const [name, openIt] of openers) {
    await openIt();
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog, name).toHaveCount(1);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              !!document.activeElement?.closest('[role="dialog"][aria-modal]'),
          ),
        { message: `${name}: フォーカスが窓の中に無い` },
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog, `${name}: Esc で閉じない`).toHaveCount(0);
  }
});
