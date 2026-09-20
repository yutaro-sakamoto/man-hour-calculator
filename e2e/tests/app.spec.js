const path = require("path");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const PAGE_URL = pathToFileURL(
  path.resolve(__dirname, "../../dist/index.html"),
).href;

/** ページを開き、外部への通信が 1 件も起きていないことを保証する。 */
async function open(page) {
  const external = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("file://")) external.push(request.url());
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(PAGE_URL);
  await expect(page.locator("#results")).toBeVisible();
  return { external, errors };
}

/** KPI タイルの数値を、表示書式に左右されずに読む。 */
async function tile(page, key) {
  const raw = await page.locator(`.tile[data-key="${key}"]`).getAttribute("data-value");
  return Number(raw);
}

/** 操作して、計算が一巡し終わるまで待つ。
 *  status の文言は変わらないことがあるので、実行回数カウンタで待つ。 */
async function recompute(page, action) {
  const before = await page.locator("#status").getAttribute("data-run");
  await action();
  await expect(page.locator("#status")).not.toHaveAttribute("data-run", before);
}

async function setEngine(page, value) {
  await recompute(page, () => page.selectOption("#engine", value));
}

test("単一 HTML を file:// から開くだけで動き、外部通信が発生しない", async ({ page }) => {
  const { external, errors } = await open(page);
  expect(external, "外部へのリクエストが発生した").toEqual([]);
  expect(errors, "ページ内で例外が発生した").toEqual([]);
  await expect(page.locator("#status")).toContainText(/ms\)/);
});

test("サンプルの 3 タスクで P80 が最可能値の合計を明確に上回る", async ({ page }) => {
  await open(page);
  // 合計「最可能」は 8 + 3 + 15 = 26 人日。
  await expect(page.locator("#task-totals")).toContainText("26");

  const p80 = await tile(page, "results.p80");
  expect(p80).toBeGreaterThan(26);
  // 単純合計では足りない、という主張が数字で立っていること。
  expect(p80).toBeGreaterThan(30);
  expect(p80).toBeLessThan(45);

  const p50 = await tile(page, "results.p50");
  const p90 = await tile(page, "results.p90");
  expect(p50).toBeLessThan(p80);
  expect(p80).toBeLessThan(p90);
});

test("モンテカルロと畳み込みの結果がほぼ一致する", async ({ page }) => {
  await open(page);
  const monteCarlo = {
    p50: await tile(page, "results.p50"),
    p80: await tile(page, "results.p80"),
    p90: await tile(page, "results.p90"),
  };

  await setEngine(page, "1");
  await expect(page.locator("#status")).toContainText(/畳み込み|convolution/i);

  for (const key of ["p50", "p80", "p90"]) {
    const value = await tile(page, `results.${key}`);
    expect(Math.abs(value - monteCarlo[key]), `${key} が一致しない`).toBeLessThan(0.5);
  }
});

test("シードを変えても P80 はほとんど動かない", async ({ page }) => {
  await open(page);
  const before = await tile(page, "results.p80");
  await recompute(page, async () => {
    await page.fill("#seed", "12345");
    await page.locator("#seed").blur();
  });
  const after = await tile(page, "results.p80");
  expect(Math.abs(after - before), "試行回数が足りていない可能性").toBeLessThan(0.5);
});

test("分布を三角分布に変えると結果が変わる", async ({ page }) => {
  await open(page);
  const pert = await tile(page, "results.sd");
  await recompute(page, () => page.selectOption("#dist", "1"));
  const triangular = await tile(page, "results.sd");
  // 三角分布は両端が厚いぶん、PERT より必ずばらつきが大きくなる。
  expect(triangular).toBeGreaterThan(pert);
});

test("畳み込みを選ぶと試行回数とシードが操作できなくなる", async ({ page }) => {
  await open(page);
  await expect(page.locator("#iterations")).toBeEnabled();
  await expect(page.locator("#grid")).toBeDisabled();

  await setEngine(page, "1");
  await expect(page.locator("#iterations")).toBeDisabled();
  await expect(page.locator("#seed")).toBeDisabled();
  await expect(page.locator("#grid")).toBeEnabled();
});

test("不正な見積もりは行番号つきのエラーになる", async ({ page }) => {
  await open(page);
  // 2 行目の「最小」を「最大」より大きくする。
  const row = page.locator("#task-body tr").nth(1);
  await row.locator('input[type="number"]').first().fill("999");
  await expect(page.locator("#status")).toHaveAttribute("data-tone", "error");
  await expect(page.locator("#status")).toContainText("2");
  await expect(page.locator("#results")).toBeHidden();
  await expect(row).toHaveAttribute("data-invalid", "true");
});

test("タスクの追加・削除・除外ができる", async ({ page }) => {
  await open(page);
  await expect(page.locator("#task-body tr")).toHaveCount(3);

  await page.click("#add-row");
  await expect(page.locator("#task-body tr")).toHaveCount(4);

  await page.locator("#task-body tr").first().locator("button.icon").click();
  await expect(page.locator("#task-body tr")).toHaveCount(3);

  // チェックを外すと合計から抜ける。
  const before = await tile(page, "results.mean");
  await recompute(page, () =>
    page.locator("#task-body tr").first().locator('input[type="checkbox"]').uncheck(),
  );
  expect(await tile(page, "results.mean")).toBeLessThan(before);

  await page.click("#clear-all");
  await expect(page.locator("#tasks-empty")).toBeVisible();
  await expect(page.locator("#results")).toBeHidden();
});

test("分位点表とデータ表がグラフと同じ内容を持つ", async ({ page }) => {
  await open(page);
  await expect(page.locator("#pct-body tr")).toHaveCount(7);
  await expect(page.locator('#pct-body tr[data-highlight="true"]')).toHaveCount(1);

  // データ表の行数はビン数と一致する。
  const bins = Number(await page.locator("#bins").inputValue());
  await expect(page.locator("#data-body tr")).toHaveCount(bins);

  // 累積は単調非減少。
  const cumulative = await page.$$eval("#data-body tr td:last-child", (cells) =>
    cells.map((c) => Number(c.textContent.replace("%", ""))),
  );
  for (let i = 1; i < cumulative.length; i++) {
    expect(cumulative[i]).toBeGreaterThanOrEqual(cumulative[i - 1]);
  }
  expect(cumulative[cumulative.length - 1]).toBeGreaterThan(99);
});

test("確率スライダが累積確率を返す", async ({ page }) => {
  await open(page);
  // 初期位置は P80。累積確率はビン境界での線形補間なので、ぴったり 80% に
  // ならないことがある (ビン幅ぶんの誤差)。
  const probability = Number(
    (await page.locator("#probe-output").innerText()).match(/([\d.]+)%/)[1],
  );
  expect(probability).toBeGreaterThan(78);
  expect(probability).toBeLessThan(82);

  // 下端まで動かすと、表示範囲の下限 (P0.1) にあたるのでほぼ 0%。
  await page.locator("#probe-range").fill("0");
  const atMinimum = Number(
    (await page.locator("#probe-output").innerText()).match(/([\d.]+)%/)[1],
  );
  expect(atMinimum).toBeLessThan(1);

  await page.locator("#probe-range").fill("1000");
  const atMaximum = Number(
    (await page.locator("#probe-output").innerText()).match(/([\d.]+)%/)[1],
  );
  expect(atMaximum).toBeGreaterThan(99);
});

test("グラフが実際に描画され、キーボードでも読める", async ({ page }) => {
  await open(page);
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector("#chart");
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
    return { opaque, width: canvas.width, height: canvas.height };
  });
  expect(painted.width).toBeGreaterThan(0);
  expect(painted.opaque, "canvas が真っ白").toBeGreaterThan(1000);

  // マウスを使わずにビンを読めること。
  await page.locator("#chart").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#chart-tooltip")).toHaveAttribute("data-visible", "true");
  await expect(page.locator("#chart-tooltip")).toContainText("%");
});

test("未置換の i18n プレースホルダが画面に残らない", async ({ page }) => {
  await open(page);
  for (const language of ["en", "ja"]) {
    await page.click(`.lang-toggle button[data-lang="${language}"]`);
    const text = await page.locator("body").innerText();
    // 「{unit}」のような差し込み漏れや、辞書に無いキーがそのまま出ていないか。
    expect(text, `${language} に差し込み漏れがある`).not.toMatch(/\{[a-z]+\}/);
    expect(text, `${language} に未定義のキーがある`).not.toMatch(/\b[a-z]+\.[a-zA-Z]+\b(?![\w.])/);
  }
});

test("日英を切り替えても結果が保たれる", async ({ page }) => {
  await open(page);
  await page.click('.lang-toggle button[data-lang="en"]');
  await expect(page.locator("h1")).toHaveText("Effort Estimator");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator('.tile[data-key="results.p80"] dt')).toHaveText("P80");
  await expect(page.locator("#results")).toBeVisible();

  await page.click('.lang-toggle button[data-lang="ja"]');
  await expect(page.locator("h1")).toHaveText("工数見積もり");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
});
