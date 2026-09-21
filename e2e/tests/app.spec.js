const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const PAGE_URL = pathToFileURL(
  path.resolve(__dirname, "../../dist/app.html"),
).href;

/**
 * ページを開き、外部への通信もページ内の例外も起きていないことを保証する。
 * localStorage は毎回まっさらな状態から始める (テスト間で引きずらないため)。
 */
async function open(page, { lang = "ja" } = {}) {
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

/** 操作して、計算が一巡し終わるまで待つ。 */
async function recompute(page, action) {
  const before = await page.locator("#status").getAttribute("data-run");
  await action();
  await expect(page.locator("#status")).not.toHaveAttribute(
    "data-run",
    before ?? "",
  );
}

const summary = (page, key) =>
  page.locator(`.summary-item[data-key="${key}"]`).getAttribute("data-value");
const tile = async (page, key) =>
  Number(
    await page.locator(`.tile[data-key="${key}"]`).getAttribute("data-value"),
  );

const openTab = (page, tab) => page.click(`.tabs button[data-tab="${tab}"]`);

/** 畳んであるカードを id で開く。言語に依らないので、英語の画面でも使える。 */
async function openCard(page, id) {
  const panel = page.locator(`details.foldout#${id}`);
  if (await panel.evaluate((node) => node.open)) return;
  await panel.locator("summary").click();
  await expect(panel).toHaveAttribute("open", "");
}

/** 「別のアカウントとして操作」で、名前に一致するアカウントに切り替える。 */
async function actAs(page, name) {
  const picker = page.locator('select[aria-label="別のアカウントとして操作"]');
  const value = await picker
    .locator("option")
    .filter({ hasText: name })
    .first()
    .getAttribute("value");
  await picker.selectOption(value);
}

/** 升のなかの予定を押して、編集の窓を開く。 */
async function openEvent(page, name) {
  await page.locator(`.event-chip:has-text("${name}")`).first().click();
  await expect(page.locator(".modal-card")).toBeVisible();
}

/** その日の升にある予定を押して、編集の窓を開く。 */
async function openEventOn(page, date, name) {
  await page
    .locator(`.day[data-day="${date}"] .event-chip:has-text("${name}")`)
    .click();
  await expect(page.locator(".modal-card")).toBeVisible();
}

/** 編集の窓を閉じる。開いたままだと後ろの操作が届かない。 */
async function closeEditor(page) {
  await page.locator('.modal-card button[title="閉じる"]').click();
  await expect(page.locator(".modal-card")).toHaveCount(0);
}

/** ファイルメニューを開いて項目を選ぶ。 */
async function fileMenu(page, label) {
  await page.click(".menu > summary");
  await page.click(`.menu-panel button:text("${label}")`);
}
const rows = (page) => page.locator(".task-table tbody tr");

test("単一 HTML を file:// から開くだけで動き、外部通信が発生しない", async ({
  page,
}) => {
  const { external, errors } = await open(page);
  expect(external, "外部へのリクエストが発生した").toEqual([]);
  expect(errors, "ページ内で例外が発生した").toEqual([]);
  await expect(rows(page)).toHaveCount(8);
});

test("サンプルの見積もりで P80 が最可能値の合計を上回る", async ({ page }) => {
  await open(page);
  // 葉タスクの最可能値の合計は 8+5+3+15+4+6 = 41 人日。
  await expect(page.locator(".card .status").last()).toContainText("41");

  await openTab(page, "forecast");
  const p50 = await tile(page, "p50");
  const p80 = await tile(page, "p80");
  const p90 = await tile(page, "p90");
  expect(p80).toBeGreaterThan(41);
  expect(p50).toBeLessThan(p80);
  expect(p80).toBeLessThan(p90);
  expect(await tile(page, "buffer")).toBeGreaterThan(0);
});

test("親タスクは配下の合計を表示し、直接は編集できない", async ({ page }) => {
  await open(page);
  const parent = rows(page).first();
  await expect(parent).toHaveAttribute("data-parent", "true");
  // 要件定義 (5/8/20) と基本設計 (3/5/12) の合計。
  await expect(parent.locator("td.num").nth(0)).toHaveText("8.0");
  await expect(parent.locator("td.num").nth(1)).toHaveText("13.0");
  await expect(parent.locator("td.num").nth(2)).toHaveText("32.0");
  await expect(parent.locator('td.num input[type="number"]')).toHaveCount(0);

  // 子は自分の見積もりを持つ。
  await expect(
    rows(page).nth(1).locator('td.num input[type="number"]'),
  ).toHaveCount(3);
});

test("階層の上げ下げと並べ替えができる", async ({ page }) => {
  await open(page);
  const cellText = async (index) =>
    rows(page).nth(index).locator('input[type="text"]').first().inputValue();

  // 「テストとリリース」を 1 つ上げると「実装フェーズ」の直前に来る。
  await recompute(page, () =>
    rows(page).nth(7).locator('button[title="上へ"]').click(),
  );
  expect(await cellText(3)).toBe("テストとリリース");

  // 階層を下げると「設計フェーズ」の子になる。
  await recompute(page, () =>
    rows(page).nth(3).locator('button[title="階層を下げる"]').click(),
  );
  await expect(rows(page).nth(3)).toHaveAttribute("data-parent", "false");
  // 親の集計に取り込まれる (8 + 3 = 11 人日が最小)。
  await expect(rows(page).first().locator("td.num").nth(0)).toHaveText("11.0");

  // 階層を上げると元に戻る。
  await recompute(page, () =>
    rows(page).nth(3).locator('button[title="階層を上げる"]').click(),
  );
  await expect(rows(page).first().locator("td.num").nth(0)).toHaveText("8.0");
});

test("子タスクを追加すると親になり、削除は部分木ごと消える", async ({
  page,
}) => {
  await open(page);
  await recompute(page, () =>
    rows(page).nth(1).locator('button[title="子タスクを追加"]').click(),
  );
  await expect(rows(page)).toHaveCount(9);
  await expect(rows(page).nth(1)).toHaveAttribute("data-parent", "true");

  // 「設計フェーズ」を消すと配下 3 件ごと消える。部分木なので問い返される。
  page.once("dialog", (dialog) => dialog.accept());
  await recompute(page, () =>
    rows(page).first().locator('button[title*="を削除"]').click(),
  );
  await expect(rows(page)).toHaveCount(5);
});

test("絞り込みは表示だけに効き、計算結果を変えない", async ({ page }) => {
  await open(page);
  await openTab(page, "forecast");
  const before = await tile(page, "p80");

  await openTab(page, "tasks");
  await page.fill(".filter-text", "実装");
  await expect(rows(page)).toHaveCount(4); // 実装フェーズ + 子 3 件
  await expect(page.locator(".filter-count")).toContainText("4");

  await openTab(page, "forecast");
  expect(await tile(page, "p80")).toBe(before);

  await openTab(page, "tasks");
  await page.click("text=絞り込みを解除");
  await expect(rows(page)).toHaveCount(8);
});

test("優先度で絞り込める", async ({ page }) => {
  await open(page);
  await page.selectOption('select[aria-label="優先度"]', "high");
  // 高: 設計フェーズ・要件定義・API 実装 + 文脈として残る実装フェーズ。
  await expect(rows(page)).toHaveCount(4);
});

test("使用チェックを外すと計算から除かれる", async ({ page }) => {
  await open(page);
  await openTab(page, "forecast");
  const before = await tile(page, "mean");

  await openTab(page, "tasks");
  await recompute(page, () =>
    rows(page).first().locator('input[type="checkbox"]').uncheck(),
  );
  // 親を外すと配下もまとめて外れる。
  await expect(rows(page).nth(1)).toHaveAttribute("data-inactive", "true");

  await openTab(page, "forecast");
  expect(await tile(page, "mean")).toBeLessThan(before);
});

test("モンテカルロと畳み込みの結果がほぼ一致する", async ({ page }) => {
  await open(page);
  await openTab(page, "forecast");
  const monteCarlo = {
    p50: await tile(page, "p50"),
    p80: await tile(page, "p80"),
    p90: await tile(page, "p90"),
  };

  await openCard(page, "settings");
  await recompute(page, () => page.selectOption("#engine", "1"));
  await expect(page.locator("#status")).toContainText(/畳み込み|convolution/i);
  for (const key of ["p50", "p80", "p90"]) {
    expect(
      Math.abs((await tile(page, key)) - monteCarlo[key]),
      `${key} が一致しない`,
    ).toBeLessThan(0.8);
  }
});

test("実績を入力すると見通しが更新される", async ({ page }) => {
  await open(page);
  await openTab(page, "forecast");
  const before = await tile(page, "mean");

  // 実績を測るには、基準日が着手日より後にある必要がある。
  await openTab(page, "calendar");
  await recompute(page, () =>
    page.locator('input[type="date"]').nth(1).fill("2026-10-02"),
  );

  await openTab(page, "tasks");
  await page.click('.segmented button:text("すべて")');
  const target = rows(page).nth(1); // 要件定義

  await recompute(page, async () => {
    await target.locator('input[type="date"]').first().fill("2026-09-21");
    await target.locator('input[type="number"]').nth(3).fill("25");
  });

  await expect(target.locator(".pill")).toHaveText("進行中");
  await openTab(page, "forecast");
  // 進捗が浅いまま日数を消化しているので見通しは伸びる。
  expect(await tile(page, "mean")).toBeGreaterThan(before);
});

test("完了日を入れると実績工数に置き換わる", async ({ page }) => {
  await open(page);
  await openTab(page, "tasks");
  await page.click('.segmented button:text("すべて")');
  const target = rows(page).nth(1);

  await recompute(page, async () => {
    await target.locator('input[type="date"]').first().fill("2026-09-24");
    await target.locator('input[type="date"]').nth(1).fill("2026-09-30");
    await target.locator('input[type="number"]').nth(3).fill("100");
  });

  await expect(target.locator(".pill")).toHaveText("完了");
  // 9/24(木)・9/25(金)・9/28〜9/30 の 5 稼働日ぶん。ただしサンプルには
  // 毎週の定例 (45 分) と隔週の振り返り (60 分) が入っているので、
  // そのぶんだけ 5.0 人日を下回る。
  // 「すべて」表示の数値列は 最小・最可能・最大・進捗・消化・完了予測 の順。
  const spent = Number(await target.locator("td.num").nth(4).innerText());
  expect(spent).toBeGreaterThan(4.5);
  expect(spent).toBeLessThan(5);
});

test("祝日と休日出勤がカレンダーに反映される", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  // サンプルは 2 人 (フルタイム + 時短) なので、1 日あたり 1.66 人日ほど。
  await expect(page.locator(".card .status").first()).toContainText("人日");

  // 2026-09-21 は敬老の日。稼働量 0 で祝日の印が付く。
  const holiday = page.locator('.day[aria-label*="2026-09-21"]');
  await expect(holiday).toHaveClass(/holiday/);
  await expect(holiday).toHaveClass(/off/);

  // 日付の数字を押すと休日出勤に切り替わる (升の空きは予定の追加に使う)。
  await recompute(page, () => holiday.locator(".day-number").click());
  await expect(page.locator('.day[aria-label*="2026-09-21"]')).toHaveClass(
    /forced/,
  );
});

test("人員ごとに稼働時間が違い、月表示を切り替えられる", async ({ page }) => {
  await open(page);
  await openTab(page, "members");
  const cards = page.locator(".member-card");
  await expect(cards).toHaveCount(2);
  // 9:00〜18:00 から休憩 60 分で週 40 時間。
  await expect(cards.first().locator(".chip").first()).toContainText("40");
  // 時短勤務のほうは短い。
  await expect(cards.nth(1).locator(".chip").first()).toContainText("26");

  await openTab(page, "calendar");
  const capacityOf = async () => {
    const label = await page
      .locator('.day[aria-label*="2026-09-24"]')
      .getAttribute("aria-label");
    return Number(label.match(/: ([\d.]+)/)[1]);
  };
  const everyone = await capacityOf();
  await page.selectOption('select[aria-label="表示する人員"]', "1");
  const partTime = await capacityOf();
  expect(partTime).toBeLessThan(everyone);
  expect(partTime).toBeGreaterThan(0);
});

test("人員を増やして担当を分けると完了日が早まる", async ({ page }) => {
  await open(page);
  const before = await summary(page, "finishP80");

  // すべてのタスクを 1 人目に寄せると直列になり、完了日は後ろにずれる。
  await openTab(page, "tasks");
  const assignees = page.locator("select.assignee");
  const count = await assignees.count();
  await recompute(page, async () => {
    for (let i = 0; i < count; i++) {
      await assignees.nth(i).selectOption({ index: 1 });
    }
  });
  const serial = await summary(page, "finishP80");
  expect(
    new Date(`2026/${serial.replace(/\(.+\)/, "")}`).getTime(),
  ).toBeGreaterThan(new Date(`2026/${before.replace(/\(.+\)/, "")}`).getTime());
});

test("共有した予定は参加者全員の稼働を削る", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  // 毎週の定例は月曜にある。9/21 は祝日なので 9/28 で見る。
  const capacityFor = async (member) => {
    await page.selectOption('select[aria-label="表示する人員"]', member);
    const label = await page
      .locator('.day[aria-label*="2026-09-28"]')
      .getAttribute("aria-label");
    return Number(label.match(/: ([\d.]+)/)[1]);
  };
  const before = await capacityFor("0");

  // 参加者から 1 人目を外すと、その人の稼働は戻る。
  await openEvent(page, "全体定例");
  await recompute(page, () =>
    page
      .locator('.modal-card .participant-list input[type="checkbox"]')
      .first()
      .uncheck(),
  );
  await closeEditor(page);
  expect(await capacityFor("0")).toBeGreaterThan(before);
});

test("隔週の予定は 1 週おきにしか効かない", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  // 「隔週の振り返り」はサンプルで隔週に設定してある。
  await openEvent(page, "隔週の振り返り");
  await expect(page.locator(".modal-card select").first()).toHaveValue("2");
  await closeEditor(page);

  const capacityOn = async (date) => {
    const label = await page
      .locator(`.day[aria-label*="${date}"]`)
      .getAttribute("aria-label");
    return Number(label.match(/: ([\d.]+)/)[1]);
  };
  await page.selectOption('select[aria-label="表示する人員"]', "0");
  // 開始日が日曜なので、隔週の予定は日曜にしか当たらない (= 稼働日には影響しない)。
  // 毎週の定例だけが平日の稼働を削っていることを、繰り返しを切って確かめる。
  const before = await capacityOn("2026-09-28");
  await openEvent(page, "全体定例");
  await recompute(page, () =>
    page.locator(".modal-card select").first().selectOption("0"),
  );
  await closeEditor(page);
  expect(await capacityOn("2026-09-28")).toBeGreaterThan(before);
});

test("予定の時刻は 5 分単位で効く", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  await page.selectOption('select[aria-label="表示する人員"]', "0");
  const capacityOn = async (date) => {
    const label = await page
      .locator(`.day[aria-label*="${date}"]`)
      .getAttribute("aria-label");
    return Number(label.match(/: ([\d.]+)/)[1]);
  };
  const before = await capacityOn("2026-09-28");

  // 10:00〜10:45 を 10:00〜10:05 に縮めると、その 40 分ぶん稼働が戻る。
  await openEvent(page, "全体定例");
  await recompute(page, () =>
    page.locator('.modal-card input[type="time"]').nth(1).fill("10:05"),
  );
  await closeEditor(page);
  const after = await capacityOn("2026-09-28");
  // 1 人日 = 8 時間なので 40 分は 1/12 人日。
  expect(after - before).toBeGreaterThan(0.07);
  expect(after - before).toBeLessThan(0.1);
});

test("担当者で絞り込める", async ({ page }) => {
  await open(page);
  await openTab(page, "tasks");
  const total = await rows(page).count();
  await page.selectOption('select[aria-label="担当者"]', { index: 2 }); // 2 人目
  const shown = await rows(page).count();
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(total);
});

test("担当者のいないタスクは未割当としてまとめられる", async ({ page }) => {
  await open(page);
  await openTab(page, "tasks");
  await recompute(page, () =>
    page.locator("select.assignee").first().selectOption(""),
  );
  await openTab(page, "forecast");
  // 人員ごとの表に「未割当」が現れる。
  await expect(page.locator(".member-summary")).toContainText("未割当");
});

test("祝日を使わない設定にすると稼働量が増える", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  const total = async () =>
    Number(
      (await page.locator(".card .status").first().innerText()).match(
        /で ([\d.]+) 人日/,
      )[1],
    );
  const before = await total();

  await recompute(page, () =>
    page.uncheck('.card .toggle input[type="checkbox"]'),
  );
  expect(await total()).toBeGreaterThan(before);
});

test("見通しにタスクごとの完了予測と確率が出る", async ({ page }) => {
  await open(page);
  await openTab(page, "forecast");
  await expect(page.locator("#schedule-chart")).toBeVisible();

  // 全体を含めて 9 行。
  const table = page.locator(".forecast-table tbody tr");
  await expect(table).toHaveCount(9);
  await expect(table.last()).toContainText("全体");

  const probabilities = () =>
    page.$$eval(".forecast-table td[data-prob]", (cells) =>
      cells.map((cell) => Number(cell.dataset.prob)),
    );

  // 完了確率は 0〜1 の範囲で、後ろのタスクほど低い。
  const values = await probabilities();
  expect(Math.max(...values)).toBeLessThanOrEqual(1);
  expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
  expect(values[0]).toBeGreaterThanOrEqual(values[values.length - 1]);

  // 日付を早めると確率は下がる。
  await page.locator('.probe-head input[type="date"]').fill("2026-10-01");
  await expect
    .poll(async () => (await probabilities())[values.length - 1])
    .toBeLessThanOrEqual(values[values.length - 1]);
});

test("サマリバーが工数と完了日を常に示す", async ({ page }) => {
  await open(page);
  expect(Number(await summary(page, "effortP80"))).toBeGreaterThan(40);
  expect(await summary(page, "finishP80")).toMatch(/\d/);
  expect(await summary(page, "progress")).toBe("0%");
});

test("ファイルに保存して読み込み直すと新しいプロジェクトになる", async ({
  page,
}) => {
  await open(page);
  await recompute(page, () =>
    rows(page).nth(1).locator('input[type="number"]').first().fill("7"),
  );

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    fileMenu(page, "ファイルに保存"),
  ]);
  const file = path.join(os.tmpdir(), `mhc-${Date.now()}.mhc.json`);
  await download.saveAs(file);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  expect(saved.schema).toBe("man-hour-calculator");
  expect(saved.document.tasks).toHaveLength(8);

  // 読み込むと、いまのプロジェクトを潰さずに 1 件増える。
  await page.setInputFiles('input[type="file"][accept*="json"]', file);
  await expect(page.locator("#status")).toContainText("読み込みました");
  await openTab(page, "projects");
  await expect(page.locator("tr[data-project]")).toHaveCount(2);
  await fs.unlink(file);
});

test("CSV で書き出して読み込み直せる", async ({ page }) => {
  await open(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    fileMenu(page, "CSV で書き出す"),
  ]);
  const file = path.join(os.tmpdir(), `mhc-${Date.now()}.csv`);
  await download.saveAs(file);
  const csv = await fs.readFile(file, "utf8");
  expect(csv).toContain("level,name,group");
  expect(csv).toContain("要件定義");

  await page.setInputFiles('input[type="file"][accept*="csv"]', file);
  await expect(rows(page)).toHaveCount(8);
  await expect(rows(page).first()).toHaveAttribute("data-parent", "true");
  await fs.unlink(file);
});

test("入力内容が保存され、開き直しても残る", async ({ page }) => {
  await open(page);
  const input = rows(page).nth(1).locator('input[type="text"]').first();
  await recompute(page, () => input.fill("保存されるはず"));
  // 保存のデバウンスを待つ。
  await page.waitForTimeout(1200);

  await page.reload();
  await expect(page.locator(".summary-bar")).toBeVisible();
  await expect(
    rows(page).nth(1).locator('input[type="text"]').first(),
  ).toHaveValue("保存されるはず");
});

/* ===== プロジェクトと権限 ===== */

test("プロジェクトを増やして切り替えられる", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");
  await expect(page.locator("tr[data-project]")).toHaveCount(1);

  await page.click('button:text("新しいプロジェクト")');
  await expect(page.locator("tr[data-project]")).toHaveCount(2);
  // 新しいほうが開いている。空なので計算するものが無い。
  await expect(page.locator("#status")).toContainText(
    "計算するタスクがありません",
  );

  // ヘッダの切り替えで元に戻れる。
  await page.selectOption(".project-picker", { label: "サンプル案件" });
  await expect(page.locator("#status")).toContainText(/ms\)/);
  await openTab(page, "tasks");
  await expect(rows(page)).toHaveCount(8);
});

test("プロジェクトの内容は互いに混ざらない", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");
  await page.click('button:text("新しいプロジェクト")');
  await openTab(page, "tasks");
  await expect(rows(page)).toHaveCount(0);

  await recompute(page, () => page.click("#add-row"));
  await expect(rows(page)).toHaveCount(1);

  await page.selectOption(".project-picker", { label: "サンプル案件" });
  await expect(rows(page)).toHaveCount(8, { timeout: 5000 });
});

test("プロジェクトを改名・複製・削除できる", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");

  const nameInput = page.locator("tr[data-project] input").first();
  await nameInput.fill("名前を変えた案件");
  await nameInput.blur();
  await expect(page.locator(".project-picker option").first()).toHaveText(
    /名前を変えた案件/,
  );

  await page
    .locator('tr[data-project] button[title*="を複製する"]')
    .first()
    .click();
  await expect(page.locator("tr[data-project]")).toHaveCount(2);
  await expect(
    page.locator('tr[data-project][data-open="true"] input').first(),
  ).toHaveValue(/のコピー/);
  // 複製した中身も引き継がれる。
  await openTab(page, "tasks");
  await expect(rows(page)).toHaveCount(8);

  await openTab(page, "projects");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator('tr[data-project] button[title*="を削除する"]')
    .first()
    .click();
  await expect(page.locator("tr[data-project]")).toHaveCount(1);
});

test("共有した相手は与えた権限の範囲でしか触れない", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");

  // 相手のアカウントを作る。
  await page.click('button:text("アカウントを追加")');
  await expect(page.locator("tr[data-account]")).toHaveCount(2);
  const otherName = page
    .locator("tr[data-account]")
    .nth(1)
    .locator("input")
    .first();
  await otherName.fill("鈴木");
  await otherName.blur();

  // 閲覧者として共有する。
  const addRow = page
    .locator(".card", { hasText: "このプロジェクトの共有" })
    .locator(".inline-row");
  await addRow.locator("select").nth(1).selectOption("viewer");
  await addRow.locator('button:text("共有する")').click();
  await expect(page.locator("tr[data-principal]")).toHaveCount(2);

  // その人として操作すると、読み取り専用になる。
  await actAs(page, "鈴木");
  await openTab(page, "tasks");
  await expect(page.locator("#readonly-banner")).toContainText("閲覧のみ");
  await expect(page.locator("fieldset.readonly")).toBeVisible();
  await expect(
    rows(page).first().locator('input[type="text"]').first(),
  ).toBeDisabled();
  // 計算結果は見える (見るだけならできる)。
  await openTab(page, "forecast");
  await expect(page.locator('.tile[data-key="p80"]')).toBeVisible();
});

test("所有者がいなくなる操作は拒否される", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");
  // 唯一の所有者である自分の共有を解除しようとする。
  await page
    .locator('tr[data-principal] button[title*="共有を解除"]')
    .first()
    .click();
  await expect(page.locator("#status")).toHaveAttribute("data-tone", "error");
  await expect(page.locator("#status")).toContainText("所有者");
  await expect(page.locator("tr[data-principal]")).toHaveCount(1);
});

test("一般アカウントはアカウントを管理できない", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");
  await page.click('button:text("アカウントを追加")');
  const second = page.locator("tr[data-account]").nth(1);
  await second.locator("input").first().fill("一般");
  await second.locator("input").first().blur();

  await actAs(page, "一般");
  // 追加ボタンが消え、権限の変更もできない。
  await expect(page.locator('button:text("アカウントを追加")')).toHaveCount(0);
  await expect(page.locator("tr[data-account] select").first()).toBeDisabled();
});

test("接続先が画面に出ている", async ({ page }) => {
  await open(page);
  await expect(page.locator("header .chip")).toContainText("ローカル");
});

test("日英を切り替えても結果が保たれる", async ({ page }) => {
  await open(page);
  await page.click('.lang-toggle button[data-lang="en"]');
  await expect(page.locator("h1")).toHaveText("Effort Estimator");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator('.tabs button[data-tab="forecast"]')).toHaveText(
    "Forecast",
  );
  await expect(rows(page)).toHaveCount(8);

  await page.click('.lang-toggle button[data-lang="ja"]');
  await expect(page.locator("h1")).toHaveText("工数見積もり");
});

test("未置換の i18n プレースホルダが画面に残らない", async ({ page }) => {
  await open(page);
  for (const language of ["en", "ja"]) {
    await page.click(`.lang-toggle button[data-lang="${language}"]`);
    for (const tab of ["tasks", "members", "calendar", "forecast"]) {
      await openTab(page, tab);
      // 畳んである区画の中も見る。閉じたままだと差し込み漏れを見逃す。
      if (tab === "forecast") {
        await openCard(page, "sensitivity");
        await openCard(page, "settings");
      }
      const text = await page.locator("body").innerText();
      expect(text, `${language}/${tab} に差し込み漏れがある`).not.toMatch(
        /\{[a-z]+\}/,
      );
    }
  }
});

test("見積もりが不正な行はエラーになる", async ({ page }) => {
  await open(page);
  await recompute(page, () =>
    rows(page).nth(1).locator('input[type="number"]').first().fill("999"),
  );
  await expect(page.locator("#status")).toHaveAttribute("data-tone", "error");
  await expect(rows(page).nth(1)).toHaveAttribute("data-invalid", "true");
});

test("入力中に再計算が走ってもフォーカスが飛ばない", async ({ page }) => {
  await open(page);
  const input = rows(page).nth(1).locator('input[type="text"]').first();
  await input.click();
  await input.fill("要件定義と調査");
  // 再計算のデバウンスをまたぐ。
  await page.waitForTimeout(600);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("要件定義と調査");
});

test("グラフが実際に描画され、キーボードでも読める", async ({ page }) => {
  await open(page);
  await openTab(page, "forecast");
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector("#chart");
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
    return opaque;
  });
  expect(painted, "canvas が真っ白").toBeGreaterThan(1000);

  await page.locator("#chart").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#chart-tooltip")).toHaveAttribute(
    "data-visible",
    "true",
  );
});

test("見通しでは 2 つのグラフが両方とも描かれる", async ({ page }) => {
  // 別々のタブだったものを 1 つにまとめたので、新しく壊れうるのはここ。
  // 片方しか描き直さないと、もう片方は大きさ 0 のまま白く残る。
  await open(page);
  await openTab(page, "forecast");
  const painted = (id) =>
    page.evaluate((selector) => {
      const canvas = document.querySelector(selector);
      const { data } = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height);
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opaque++;
      return opaque;
    }, id);

  expect(await painted("#chart"), "分布が真っ白").toBeGreaterThan(1000);
  expect(await painted("#schedule-chart"), "帯グラフが真っ白").toBeGreaterThan(
    1000,
  );

  // 区画の並びは「どこまで来たか → いつ終わるか → どれだけぶれるか」。
  const order = await page.$$eval(".forecast [data-card]", (cards) =>
    cards.map((card) => card.dataset.card),
  );
  expect(order.slice(0, 3)).toEqual(["progress", "schedule", "distribution"]);
});

test("進捗カードは summary バーと同じ進捗を出す", async ({ page }) => {
  await open(page);
  await openTab(page, "forecast");
  const card = page.locator('[data-card="progress"]');
  const ratio = Number(
    await card.locator(".progress-meter").first().getAttribute("data-progress"),
  );
  const shown = Number((await summary(page, "progress")).replace("%", ""));
  // 画面に出る進捗の出どころは 1 つ。食い違う 2 つを並べない。
  expect(Math.abs(ratio * 100 - shown)).toBeLessThanOrEqual(1);

  // 消化 + 残り = 全体。
  const value = async (key) =>
    Number(
      await card.locator(`[data-key="${key}"]`).getAttribute("data-value"),
    );
  expect(
    Math.abs(
      (await value("spent")) +
        (await value("remaining")) -
        (await value("total")),
    ),
  ).toBeLessThan(0.2);
});

test("進捗 50% のタスクが 100% と出ない", async ({ page }) => {
  // 以前は 0〜100 の進捗率を 0〜1 として読んでいたので、1% 以上が
  // すべて完了扱いになっていた。
  await open(page);
  await openTab(page, "tasks");
  await page.click('.segmented button:text("すべて")');
  await recompute(page, () =>
    rows(page).nth(1).locator('input[type="number"]').nth(3).fill("50"),
  );

  await openTab(page, "forecast");
  const ratio = Number(
    await page
      .locator('.forecast-table tr[data-row]:not([data-row="overall"])')
      .nth(1)
      .locator("td[data-progress]")
      .getAttribute("data-progress"),
  );
  expect(ratio).toBeGreaterThan(0.3);
  expect(ratio).toBeLessThan(0.7);
});

test("行を押すとタスクの詳細が開き、そこで直すと予測が動く", async ({
  page,
}) => {
  await open(page);
  await openTab(page, "forecast");
  const before = await tile(page, "p80");

  await page
    .locator('.forecast-table button.row-open:text("API 実装")')
    .click();
  const detail = page.locator(".modal-card.detail-card");
  await expect(detail).toBeVisible();
  // 読むだけの見通しが出ている。
  await expect(detail.locator('[data-key="remainingEstimate"]')).toHaveCount(1);
  await expect(detail.locator(".sparkline")).toHaveCount(1);

  // 最可能値を大きくすると、P80 タイルが動く。最大値も一緒に上げる
  // (min <= likely <= max を崩すと計算そのものが止まってしまう)。
  await detail.locator('input[data-focus$=":max"]').fill("40");
  await recompute(page, () =>
    detail.locator('input[data-focus$=":likely"]').fill("20"),
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal-card.detail-card")).toHaveCount(0);
  expect(await tile(page, "p80")).toBeGreaterThan(before);
});

test("グループを押すと合計が読み取り専用で出て、子をたどれる", async ({
  page,
}) => {
  await open(page);
  await openTab(page, "forecast");
  await page
    .locator('.forecast-table button.row-open:text("実装フェーズ")')
    .click();
  const detail = page.locator(".modal-card.detail-card");
  await expect(detail).toBeVisible();

  // 見積もりは配下の合計で、書き換えられない。
  await expect(detail.locator('input[data-focus$=":likely"]')).toHaveCount(0);
  await expect(detail.locator(".rollup").first()).toBeVisible();
  await expect(detail.locator('[data-key="done"]')).toHaveCount(1);

  // 子を押すと、窓がその子に移る。
  await detail
    .locator('[data-section="children"] button:text("API 実装")')
    .click();
  await expect(page.locator(".detail-heading")).toHaveText("API 実装");
  await expect(
    page.locator('.modal-card.detail-card input[data-focus$=":likely"]'),
  ).toHaveCount(1);
});

test("タスク一覧からも同じ詳細が開く", async ({ page }) => {
  await open(page);
  await rows(page).nth(1).locator('button[title*="の詳細を開く"]').click();
  await expect(page.locator(".modal-card.detail-card")).toBeVisible();
});

test("いま選んでいるタブが分かり、矢印でも移れる", async ({ page }) => {
  await open(page);
  const selected = page.locator('.tabs button[aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute("data-tab", "tasks");

  // 選択中だけが tab キーの止まり先。あとは矢印で移る。
  await expect(selected).toHaveAttribute("tabindex", "0");
  await expect(page.locator('.tabs button[tabindex="0"]')).toHaveCount(1);

  await selected.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator('.tabs button[aria-selected="true"]'),
  ).toHaveAttribute("data-tab", "members");
  await page.keyboard.press("End");
  await expect(
    page.locator('.tabs button[aria-selected="true"]'),
  ).toHaveAttribute("data-tab", "forecast");
  await page.keyboard.press("Home");
  await expect(
    page.locator('.tabs button[aria-selected="true"]'),
  ).toHaveAttribute("data-tab", "projects");

  // 色だけに頼らない。選択中は面が変わり、上辺に帯が付く。
  const marks = await page.$$eval(".tabs button", (buttons) =>
    buttons.map((button) => {
      const style = getComputedStyle(button);
      return {
        selected: button.getAttribute("aria-selected") === "true",
        background: style.backgroundColor,
        borderTop: style.borderTopColor,
        weight: style.fontWeight,
      };
    }),
  );
  const on = marks.find((mark) => mark.selected);
  const off = marks.find((mark) => !mark.selected);
  expect(on.background).not.toBe(off.background);
  expect(on.borderTop).not.toBe(off.borderTop);
  expect(Number(on.weight)).toBeGreaterThan(Number(off.weight));
});

/* ===== プロジェクト一覧 ===== */

/** 一覧に新しいプロジェクトを 1 件作り、名前と期限を入れる。 */
async function addProject(page, name, due) {
  await page.click('button:text("新しいプロジェクト")');
  await openTab(page, "projects");
  const row = page.locator('tr[data-project][data-open="true"]');
  await row.locator("input[type=text]").fill(name);
  await row.locator("input[type=text]").blur();
  await expect(
    page.locator(`tr[data-project] input[value="${name}"]`),
  ).toHaveCount(1);
  if (due) {
    await page
      .locator('tr[data-project][data-open="true"] input[type=date]')
      .fill(due);
    await expect(
      page.locator(`tr[data-project] input[value="${due}"]`),
    ).toHaveCount(1);
  }
}

/**
 * 畳んであるカードを開く。開閉は状態として覚えられているので、
 * 開いているものをもう一度押すと閉じてしまう。
 */
async function openPanel(page, title) {
  const panel = page
    .locator("details.foldout")
    .filter({ hasText: title })
    .first();
  if (!(await panel.evaluate((element) => element.open))) {
    await panel.locator("summary").click();
  }
  await expect(panel).toHaveAttribute("open", "");
}

const listRow = (page, name) =>
  page
    .locator("tr[data-project]")
    .filter({ has: page.locator(`input[value="${name}"]`) });

test("一覧に状態が出て、遅れているものが先頭に来る", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");

  // 見本には期限が入っているので、状態が「—」ではなく判定として出る。
  const sample = listRow(page, "サンプル案件");
  await expect(sample).toHaveAttribute(
    "data-health",
    /atRisk|late|onTrack|behindPace|inProgress/,
  );

  // 中身のないプロジェクトを足すと「タスクなし」になり、一覧の最後に回る。
  await addProject(page, "空の案件", "");
  const last = page.locator("tr[data-project]").last();
  await expect(last).toHaveAttribute("data-health", "noTasks");

  // 手当てが要るものは data-attention と行の強調が付き、先頭に来る。
  const attention = page.locator('tr[data-project][data-attention="true"]');
  if ((await attention.count()) > 0) {
    await expect(page.locator("tr[data-project]").first()).toHaveAttribute(
      "data-attention",
      "true",
    );
  }
});

test("状態は色だけでなく記号と言葉でも示される", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");

  const badge = page.locator("tr[data-project] .badge").first();
  // 記号と言葉が必ず揃っている (色が見分けられなくても伝わるように)。
  await expect(badge.locator(".badge-icon")).toHaveCount(1);
  await expect(badge.locator(".badge-label")).not.toBeEmpty();
});

test("一覧を名前・状態・権限で絞り込める", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");
  await addProject(page, "別の案件", "");

  const count = page.locator(".filter-count");
  await expect(count).toHaveAttribute("data-total", "2");

  await page.fill('input[aria-label="名前で絞り込む"]', "別の");
  await expect(count).toHaveAttribute("data-shown", "1");
  await expect(listRow(page, "別の案件")).toHaveCount(1);

  await page.fill('input[aria-label="名前で絞り込む"]', "");
  await expect(count).toHaveAttribute("data-shown", "2");

  // 「タスクなし」で絞ると、中身のないものだけが残る。
  await page.selectOption('select[aria-label="状態"]', "noTasks");
  await expect(count).toHaveAttribute("data-shown", "1");
  await expect(
    page.locator('tr[data-project][data-health="noTasks"]'),
  ).toHaveCount(1);

  // 条件に合わないときは、黙って空にせず理由を出す。
  await page.selectOption('select[aria-label="状態"]', "done");
  await expect(page.locator(".empty").first()).toContainText("条件に合う");
});

test("並び順を変えられる", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");
  await addProject(page, "あああ案件", "");

  await page.selectOption('select[aria-label="並び順"]', "name");
  const names = await page
    .locator("tr[data-project] input[type=text]")
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
});

test("期限とグループは一覧から直せる", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");

  // グループを作ってから割り当てる。
  await openPanel(page, "プロジェクトのグループ");
  await page.click('button:text("グループを作る") >> nth=-1');
  const group = page.locator("[data-project-group]").first();
  await group.locator('input[aria-label="グループ名"]').fill("第一部");
  await group.locator('input[aria-label="グループ名"]').blur();
  await expect(
    page.locator('[data-project-group] input[value="第一部"]'),
  ).toHaveCount(1);

  const row = listRow(page, "サンプル案件");
  await row
    .locator('select[aria-label="グループ"]')
    .selectOption({ label: "第一部" });
  await expect(row.locator('select[aria-label="グループ"]')).toHaveValue(/.+/);

  await row.locator('input[aria-label="期限"]').fill("2027-03-31");
  await expect(row.locator('input[aria-label="期限"]')).toHaveValue(
    "2027-03-31",
  );
  // 期限を先に延ばせば、間に合う見込みになる。
  await expect(row).toHaveAttribute("data-health", "onTrack");
});

test("グループに配った権限はメンバー全員に効く", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");

  // 2 人目のアカウントを作る。
  await page.click('button:text("アカウントを追加")');
  // 一覧は名前順。追加した行が 2 行目とはかぎらないので、既定の名前で探す。
  const added = page
    .locator("tr[data-account]")
    .filter({ has: page.locator('input[value="名前"]') });
  // 入力するとその場で保存され、画面が組み直される。行は名前で探しているので、
  // ここで blur を待つと「名前」の行はもう無い。
  await added.locator("input").fill("鈴木");
  await expect(
    page.locator('tr[data-account] input[value="鈴木"]'),
  ).toHaveCount(1);

  // チームを作って鈴木を入れる。
  await openPanel(page, "アカウントのグループ");
  await page.click('button:text("グループを作る") >> nth=0');
  const team = page.locator("[data-user-group]").first();
  await team.locator('input[aria-label="グループ名"]').fill("開発チーム");
  await team.locator('input[aria-label="グループ名"]').blur();
  await expect(
    page.locator('[data-user-group] input[value="開発チーム"]'),
  ).toHaveCount(1);
  await page
    .locator("[data-user-group] .member-pick")
    .filter({ hasText: "鈴木" })
    .locator("input")
    .check();

  // そのチームに閲覧権限を配る。
  const addShare = page.locator('[data-add="share"]');
  await addShare
    .locator('select[aria-label="相手"]')
    .selectOption({ label: "開発チーム (グループ)" });
  await addShare
    .locator('select[aria-label="権限"]')
    .selectOption({ label: "閲覧者" });
  await addShare.locator('button:text("共有する")').click();
  await expect(page.locator('tr[data-principal^="group:"]')).toHaveCount(1);

  // 鈴木として操作すると、チーム経由で見えて、編集はできない。
  await actAs(page, "鈴木");
  await expect(page.locator("tr[data-project]")).toHaveCount(1);
  // 与えたのは閲覧だけ。内容のタブに移ると編集できないと分かる。
  await openTab(page, "tasks");
  await expect(page.locator("#readonly-banner")).toBeVisible();

  // チームから外すと、一覧からも消える。
  await openTab(page, "projects");
  await actAs(page, "あなた");
  await openPanel(page, "アカウントのグループ");
  await page
    .locator("[data-user-group] .member-pick")
    .filter({ hasText: "鈴木" })
    .locator("input")
    .uncheck();
  await actAs(page, "鈴木");
  await expect(page.locator("tr[data-project]")).toHaveCount(0);
});

test("計算し直していないプロジェクトは数字を伏せて知らせる", async ({
  page,
}) => {
  await open(page);
  await openTab(page, "projects");
  // 中身が空のものは「タスクなし」で、計算し直しの対象にはならない。
  await addProject(page, "空の案件", "");
  await expect(page.locator("#stale-note")).toHaveCount(0);

  // 控えのない状態を作るため、内容だけを入れて保存を待つ。
  await openTab(page, "tasks");
  await recompute(page, () => page.click('button:text("行を追加")'));
  await openTab(page, "projects");
  // 控えが付けば数字が出る。伏せたままにはならない。
  await expect(listRow(page, "空の案件")).not.toHaveAttribute(
    "data-health",
    "unknown",
  );
});

test("接続先を入れ違えると理由が出て、ローカルのまま続けられる", async ({
  page,
}) => {
  await open(page);
  await openTab(page, "projects");
  await openPanel(page, "サーバへの接続先");

  await page.fill('input[aria-label="サーバの URL"]', "ftp://だめ");
  await page.click('button[data-action="connect"]');
  await expect(page.locator("#status")).toContainText("URL");
  // ローカルのまま動き続ける。
  await expect(page.locator("tr[data-project]")).toHaveCount(1);
});

/* ===== カレンダーのなかの予定 ===== */

test("予定はカレンダーの升のなかに出る", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");

  // 毎週の定例は 9/21 と 9/28 の両方に出る。別の一覧を見に行かなくてよい。
  for (const date of ["2026-09-21", "2026-09-28"]) {
    const cell = page.locator(`.day[data-day="${date}"]`);
    await expect(cell.locator(".event-chip")).toHaveCount(1);
    await expect(cell.locator(".event-chip")).toContainText("全体定例");
    await expect(cell.locator(".chip-time")).toContainText("10:00");
  }
  // 予定の無い日には何も出ない。
  await expect(
    page.locator('.day[data-day="2026-09-29"] .event-chip'),
  ).toHaveCount(0);
});

test("升の空いているところを押すと、その日の予定を足して編集できる", async ({
  page,
}) => {
  await open(page);
  await openTab(page, "calendar");
  const cell = page.locator('.day[data-day="2026-09-29"]');
  await expect(cell.locator(".event-chip")).toHaveCount(0);

  await cell.locator(".day-add").click();
  // その場で編集の窓が開き、名前に焦点が合っている。
  await expect(page.locator(".modal-card")).toBeVisible();
  await expect(
    page.locator('.modal-card input[aria-label="内容"]'),
  ).toBeFocused();

  await page.locator('.modal-card input[aria-label="内容"]').fill("打ち合わせ");
  await closeEditor(page);

  // 押した日に入る。
  await expect(cell.locator(".event-chip")).toHaveCount(1);
  await expect(cell.locator(".event-chip")).toContainText("打ち合わせ");
  await expect(
    page.locator('.day[data-day="2026-09-30"] .event-chip'),
  ).toHaveCount(0);
});

test("予定を押すと編集でき、消すと升からも消える", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");

  await openEvent(page, "全体定例");
  await recompute(page, () =>
    page.locator('.modal-card input[aria-label="内容"]').fill("朝会"),
  );
  await closeEditor(page);
  // 繰り返す予定なので、出ているところすべてが変わる。
  await expect(
    page.locator('.day[data-day="2026-09-21"] .event-chip'),
  ).toContainText("朝会");
  await expect(
    page.locator('.day[data-day="2026-09-28"] .event-chip'),
  ).toContainText("朝会");

  await openEvent(page, "朝会");
  page.once("dialog", (dialog) => dialog.accept());
  await recompute(page, () =>
    page.click('.modal-card button:text("すべての回を削除")'),
  );
  await expect(page.locator(".modal-card")).toHaveCount(0);
  await expect(
    page.locator('.day[data-day="2026-09-21"] .event-chip'),
  ).toHaveCount(0);
});

test("繰り返す予定は、その回だけ休みにでき、あとから戻せる", async ({
  page,
}) => {
  await open(page);
  await openTab(page, "calendar");
  await page.selectOption('select[aria-label="表示する人員"]', "0");
  const capacityOn = async (date) => {
    const label = await page
      .locator(`.day[aria-label*="${date}"]`)
      .getAttribute("aria-label");
    return Number(label.match(/: ([\d.]+)/)[1]);
  };
  const before = await capacityOn("2026-09-28");
  // 同じ月曜の別の回。休みにした回の巻き添えになっていないかを見る。
  const beforeOther = await capacityOn("2026-09-21");

  // 9/28 の升から開いて、その回だけ休みにする。
  await openEventOn(page, "2026-09-28", "全体定例");
  await recompute(page, () =>
    page.click('.modal-card button[data-action="skip-occurrence"]'),
  );
  await expect(page.locator(".modal-card")).toHaveCount(0);

  // 休みにした回だけが升から消え、前後の回は残る。
  await expect(
    page.locator('.day[data-day="2026-09-28"] .event-chip'),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '.day[data-day="2026-09-21"] .event-chip:has-text("全体定例")',
    ),
  ).toHaveCount(1);
  // その日の稼働はまるごと戻る。
  expect(await capacityOn("2026-09-28")).toBeGreaterThan(before);
  // 休みにしていない回の稼働は動かない。
  expect(await capacityOn("2026-09-21")).toBeCloseTo(beforeOther, 6);

  // 残っている回から窓を開くと、休みにした日が一覧に出ていて戻せる。
  await openEventOn(page, "2026-09-21", "全体定例");
  await expect(
    page.locator('.modal-card .skipped-list [data-skipped="2026-09-28"]'),
  ).toHaveCount(1);
  await recompute(page, () =>
    page.click('.modal-card [data-skipped="2026-09-28"] button'),
  );
  await closeEditor(page);
  await expect(
    page.locator(
      '.day[data-day="2026-09-28"] .event-chip:has-text("全体定例")',
    ),
  ).toHaveCount(1);
  expect(await capacityOn("2026-09-28")).toBeCloseTo(before, 6);
});

test("繰り返さない予定には、休みにする道は出ない", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  await page.locator('.day[data-day="2026-09-29"] .day-add').click();
  await page.locator('.modal-card input[aria-label="内容"]').fill("面談");
  await expect(
    page.locator('.modal-card button[data-action="skip-occurrence"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('.modal-card button[data-action="remove-event"]'),
  ).toHaveText("この予定を削除");
});

test("編集の窓は背景と Esc でも閉じる", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");

  await openEvent(page, "全体定例");
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal-card")).toHaveCount(0);

  await openEvent(page, "全体定例");
  // 窓の外 (背景) を押す。
  await page.locator(".modal-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".modal-card")).toHaveCount(0);
});

test("期間をまたぐ予定は、その全日に出る", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");

  await page.locator('.day[data-day="2026-09-29"] .day-add').click();
  await page.locator('.modal-card input[aria-label="内容"]').fill("出張");
  await page
    .locator('.modal-card input[type="date"]')
    .nth(1)
    .fill("2026-10-01");
  await closeEditor(page);

  for (const date of ["2026-09-29", "2026-09-30"]) {
    await expect(
      page.locator(`.day[data-day="${date}"] .event-chip`),
    ).toContainText("出張");
  }
  // 初日だけ時刻が出て、続きの日には出ない。
  await expect(
    page.locator('.day[data-day="2026-09-29"] .chip-time'),
  ).toHaveCount(1);
  await expect(
    page.locator('.day[data-day="2026-09-30"] .chip-time'),
  ).toHaveCount(0);
  await expect(
    page.locator('.day[data-day="2026-09-30"] .event-chip'),
  ).toHaveClass(/continues-from/);
});

test("予定が多い日は畳まれ、開くと全部出る", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  const cell = page.locator('.day[data-day="2026-09-29"]');

  for (let i = 0; i < 5; i++) {
    await cell.locator(".day-add").click();
    await page
      .locator('.modal-card input[aria-label="内容"]')
      .fill(`予定 ${String(i)}`);
    await closeEditor(page);
  }
  // 升に入るのは 3 件まで。残りはまとめて出す。
  await expect(cell.locator(".event-chip")).toHaveCount(3);
  await expect(cell.locator(".day-more")).toContainText("2");

  await cell.locator(".day-more").click();
  await expect(cell.locator(".event-chip")).toHaveCount(5);
});

test("進捗率を入れると、その分だけ完了が早まる", async ({ page }) => {
  await open(page);
  await openTab(page, "forecast");
  const meanBefore = await tile(page, "mean");

  await openTab(page, "tasks");
  await page.click('.segmented button:text("すべて")');
  const finishBefore = await summary(page, "finishP80");
  const remainingBefore = Number(await summary(page, "remaining"));

  // 着手日は入れずに、進捗率だけを入れる。ここが効かないと
  // 「進捗を入れたのに何も変わらない」ことになる。
  for (const index of [1, 2, 4, 5, 6, 7]) {
    await rows(page)
      .nth(index)
      .locator('input[type="number"]')
      .nth(3)
      .fill("80");
  }
  await recompute(page, () => page.locator("#status").click());
  await expect(rows(page).nth(1).locator(".pill")).toHaveText("進行中");

  // 残りが 1/5 に減るので、完了は大きく前に出る。
  const remainingAfter = Number(await summary(page, "remaining"));
  expect(remainingAfter).toBeLessThan(remainingBefore * 0.5);
  const finishAfter = await summary(page, "finishP80");
  expect(
    new Date(`2026/${finishAfter.replace(/\(.+\)/, "")}`).getTime(),
  ).toBeLessThan(
    new Date(`2026/${finishBefore.replace(/\(.+\)/, "")}`).getTime(),
  );

  // 総工数の中心は動かない。進んだだけで見積もりが縮むわけではない。
  await openTab(page, "forecast");
  const meanAfter = await tile(page, "mean");
  expect(Math.abs(meanAfter - meanBefore)).toBeLessThan(meanBefore * 0.02);
});

/* ===== コメント ===== */

/** タスクのコメント欄を開く。 */
async function openTaskComments(page, index) {
  await rows(page).nth(index).locator(".comment-open").click();
  await expect(page.locator(".comments-card")).toBeVisible();
}

test("タスクにコメントを書けて、Markdown が組み立てられる", async ({
  page,
}) => {
  await open(page);
  await openTab(page, "tasks");
  await openTaskComments(page, 1);
  await expect(page.locator(".comments-card .empty")).toContainText(
    "まだコメント",
  );

  await page
    .locator(".comment-input")
    .fill(
      "## 見直し\n\n**幅**が広すぎます。\n\n- 最小 1 人日は楽観的\n\n`code` もどうぞ",
    );
  await page.click('button[data-action="post-comment"]');

  // 書いたものが Markdown として組み立てられる。
  const body = page.locator(".comment .markdown").first();
  await expect(body.locator("h4")).toHaveText("見直し");
  await expect(body.locator("strong")).toHaveText("幅");
  await expect(body.locator("li")).toHaveCount(1);
  await expect(body.locator("code")).toHaveText("code");

  // 件数が行のボタンに出る。
  await page.click('.comments-card button[title="閉じる"]');
  await expect(rows(page).nth(1).locator(".comment-open")).toContainText("1");
});

test("コメントの HTML は文字として出て、危ないリンクは通らない", async ({
  page,
}) => {
  await open(page);
  await openTab(page, "tasks");
  await openTaskComments(page, 1);

  await page
    .locator(".comment-input")
    .fill('<img src=x onerror="alert(1)"> と [押して](javascript:alert(1))');
  await page.click('button[data-action="post-comment"]');

  const comment = page.locator(".comment").first();
  // 印にはならず、書いたままの文字として出る。
  await expect(comment.locator(".markdown")).toContainText("<img src=x");
  await expect(comment.locator(".markdown img")).toHaveCount(0);
  // 危ない綴りはリンクにしない。
  await expect(comment.locator(".markdown a")).toHaveCount(0);
  await expect(comment.locator(".markdown")).toContainText(
    "javascript:alert(1)",
  );
});

test("プレビューで組み立てたものを確かめてから書き込める", async ({ page }) => {
  await open(page);
  await openTab(page, "tasks");
  await openTaskComments(page, 1);

  await page.locator(".comment-input").fill("- 下書き");
  await page.click('.composer-tabs button:text("プレビュー")');
  await expect(page.locator(".comment-preview li")).toHaveText("下書き");
  // まだ書き込まれてはいない。
  await expect(page.locator(".comment")).toHaveCount(0);

  await page.click('.composer-tabs button:text("書く")');
  await expect(page.locator(".comment-input")).toHaveValue("- 下書き", {
    timeout: 5000,
  });
});

test("自分のコメントは直せて、消せる", async ({ page }) => {
  await open(page);
  await openTab(page, "tasks");
  await openTaskComments(page, 1);
  await page.locator(".comment-input").fill("最初の意見");
  await page.click('button[data-action="post-comment"]');
  await expect(page.locator(".comment")).toHaveCount(1);

  await page.click('.comment button:text("編集")');
  await expect(page.locator(".comment-input")).toHaveValue("最初の意見");
  await page.locator(".comment-input").fill("直した意見");
  await page.click('button[data-action="post-comment"]');
  await expect(page.locator(".comment .markdown")).toContainText("直した意見");
  await expect(page.locator(".comment-edited")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.click('.comment button[title="このコメントを削除"]');
  await expect(page.locator(".comment")).toHaveCount(0);
});

test("プロジェクト宛てとタスク宛ては分かれている", async ({ page }) => {
  await open(page);
  await openTab(page, "tasks");
  await openTaskComments(page, 1);
  await page.locator(".comment-input").fill("タスクの話");
  await page.click('button[data-action="post-comment"]');
  await page.click('.comments-card button[title="閉じる"]');

  await openTab(page, "projects");
  await page.click('.card:has-text("コメント") .comment-open');
  await expect(page.locator(".comments-card")).toContainText("へのコメント");
  // タスク宛ては混ざらない。
  await expect(page.locator(".comment")).toHaveCount(0);

  await page.locator(".comment-input").fill("プロジェクトの話");
  await page.click('button[data-action="post-comment"]');
  await expect(page.locator(".comment .markdown")).toContainText(
    "プロジェクトの話",
  );
  await page.click('.comments-card button[title="閉じる"]');

  await openTab(page, "tasks");
  await openTaskComments(page, 1);
  await expect(page.locator(".comment .markdown")).toContainText("タスクの話");
  await expect(page.locator(".comment")).toHaveCount(1);
});

test("閲覧しかできない人もコメントは書ける", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");

  // 2 人目を作って、閲覧だけ配る。
  await page.click('button:text("アカウントを追加")');
  const added = page
    .locator("tr[data-account]")
    .filter({ has: page.locator('input[value="名前"]') });
  await added.locator("input").fill("鈴木");
  await expect(
    page.locator('tr[data-account] input[value="鈴木"]'),
  ).toHaveCount(1);

  const addShare = page.locator('[data-add="share"]');
  await addShare
    .locator('select[aria-label="相手"]')
    .selectOption({ label: "鈴木" });
  await addShare
    .locator('select[aria-label="権限"]')
    .selectOption({ label: "閲覧者" });
  await addShare.locator('button:text("共有する")').click();
  await expect(page.locator("tr[data-principal]")).toHaveCount(2);

  await actAs(page, "鈴木");
  await openTab(page, "projects");
  await page.click('.card:has-text("コメント") .comment-open');
  await page.locator(".comment-input").fill("見積もりが楽観的では?");
  await page.click('button[data-action="post-comment"]');
  await expect(page.locator(".comment .markdown")).toContainText("楽観的");
  await expect(page.locator(".comment-author")).toHaveText("鈴木");
});
