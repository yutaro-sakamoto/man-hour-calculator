const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const { pathToFileURL } = require("url");
const { test, expect } = require("@playwright/test");

const PAGE_URL = pathToFileURL(path.resolve(__dirname, "../../dist/index.html")).href;

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
  await expect(page.locator("#status")).not.toHaveAttribute("data-run", before ?? "");
}

const summary = (page, key) =>
  page.locator(`.summary-item[data-key="${key}"]`).getAttribute("data-value");
const tile = async (page, key) =>
  Number(await page.locator(`.tile[data-key="${key}"]`).getAttribute("data-value"));

const openTab = (page, tab) => page.click(`.tabs button[data-tab="${tab}"]`);

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

/** ファイルメニューを開いて項目を選ぶ。 */
async function fileMenu(page, label) {
  await page.click(".menu > summary");
  await page.click(`.menu-panel button:text("${label}")`);
}
const rows = (page) => page.locator(".task-table tbody tr");

test("単一 HTML を file:// から開くだけで動き、外部通信が発生しない", async ({ page }) => {
  const { external, errors } = await open(page);
  expect(external, "外部へのリクエストが発生した").toEqual([]);
  expect(errors, "ページ内で例外が発生した").toEqual([]);
  await expect(rows(page)).toHaveCount(8);
});

test("サンプルの見積もりで P80 が最可能値の合計を上回る", async ({ page }) => {
  await open(page);
  // 葉タスクの最可能値の合計は 8+5+3+15+4+6 = 41 人日。
  await expect(page.locator(".card .status").last()).toContainText("41");

  await openTab(page, "distribution");
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
  await expect(rows(page).nth(1).locator('td.num input[type="number"]')).toHaveCount(3);
});

test("階層の上げ下げと並べ替えができる", async ({ page }) => {
  await open(page);
  const cellText = async (index) =>
    rows(page).nth(index).locator('input[type="text"]').first().inputValue();

  // 「テストとリリース」を 1 つ上げると「実装フェーズ」の直前に来る。
  await recompute(page, () => rows(page).nth(7).locator("button[title]").nth(0).click());
  expect(await cellText(3)).toBe("テストとリリース");

  // 階層を下げると「設計フェーズ」の子になる。
  await recompute(page, () => rows(page).nth(3).locator("button[title]").nth(2).click());
  await expect(rows(page).nth(3)).toHaveAttribute("data-parent", "false");
  // 親の集計に取り込まれる (8 + 3 = 11 人日が最小)。
  await expect(rows(page).first().locator("td.num").nth(0)).toHaveText("11.0");

  // 階層を上げると元に戻る。
  await recompute(page, () => rows(page).nth(3).locator("button[title]").nth(3).click());
  await expect(rows(page).first().locator("td.num").nth(0)).toHaveText("8.0");
});

test("子タスクを追加すると親になり、削除は部分木ごと消える", async ({ page }) => {
  await open(page);
  await recompute(page, () => rows(page).nth(1).locator("button[title]").nth(4).click());
  await expect(rows(page)).toHaveCount(9);
  await expect(rows(page).nth(1)).toHaveAttribute("data-parent", "true");

  // 「設計フェーズ」を消すと配下 3 件ごと消える。
  await recompute(page, () => rows(page).first().locator("button[title]").nth(5).click());
  await expect(rows(page)).toHaveCount(5);
});

test("絞り込みは表示だけに効き、計算結果を変えない", async ({ page }) => {
  await open(page);
  await openTab(page, "distribution");
  const before = await tile(page, "p80");

  await openTab(page, "tasks");
  await page.fill(".filter-text", "実装");
  await expect(rows(page)).toHaveCount(4); // 実装フェーズ + 子 3 件
  await expect(page.locator(".filter-count")).toContainText("4");

  await openTab(page, "distribution");
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
  await openTab(page, "distribution");
  const before = await tile(page, "mean");

  await openTab(page, "tasks");
  await recompute(page, () =>
    rows(page).first().locator('input[type="checkbox"]').uncheck(),
  );
  // 親を外すと配下もまとめて外れる。
  await expect(rows(page).nth(1)).toHaveAttribute("data-inactive", "true");

  await openTab(page, "distribution");
  expect(await tile(page, "mean")).toBeLessThan(before);
});

test("モンテカルロと畳み込みの結果がほぼ一致する", async ({ page }) => {
  await open(page);
  await openTab(page, "distribution");
  const monteCarlo = {
    p50: await tile(page, "p50"),
    p80: await tile(page, "p80"),
    p90: await tile(page, "p90"),
  };

  await recompute(page, () => page.selectOption("#engine", "1"));
  await expect(page.locator("#status")).toContainText(/畳み込み|convolution/i);
  for (const key of ["p50", "p80", "p90"]) {
    expect(Math.abs((await tile(page, key)) - monteCarlo[key]), `${key} が一致しない`).toBeLessThan(
      0.8,
    );
  }
});

test("実績を入力すると見通しが更新される", async ({ page }) => {
  await open(page);
  await openTab(page, "distribution");
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
  await openTab(page, "distribution");
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

  // クリックで休日出勤に切り替わる。
  await recompute(page, () => holiday.click());
  await expect(page.locator('.day[aria-label*="2026-09-21"]')).toHaveClass(/forced/);
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
  expect(new Date(`2026/${serial.replace(/\(.+\)/, "")}`).getTime()).toBeGreaterThan(
    new Date(`2026/${before.replace(/\(.+\)/, "")}`).getTime(),
  );
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
  await openTab(page, "calendar");
  const firstEvent = page.locator(".event-card").first();
  await recompute(page, () =>
    firstEvent.locator('.participant-list input[type="checkbox"]').first().uncheck(),
  );
  expect(await capacityFor("0")).toBeGreaterThan(before);
});

test("隔週の予定は 1 週おきにしか効かない", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  const events = page.locator(".event-card");
  await expect(events).toHaveCount(2);
  // 2 件目はサンプルで隔週に設定してある。
  await expect(events.nth(1).locator("select").first()).toHaveValue("2");

  const capacityOn = async (date) => {
    const label = await page.locator(`.day[aria-label*="${date}"]`).getAttribute("aria-label");
    return Number(label.match(/: ([\d.]+)/)[1]);
  };
  await page.selectOption('select[aria-label="表示する人員"]', "0");
  // 開始日が日曜なので、隔週の予定は日曜にしか当たらない (= 稼働日には影響しない)。
  // 毎週の定例だけが平日の稼働を削っていることを、繰り返しを切って確かめる。
  const before = await capacityOn("2026-09-28");
  await recompute(page, () => events.first().locator("select").first().selectOption("0"));
  expect(await capacityOn("2026-09-28")).toBeGreaterThan(before);
});

test("予定の時刻は 5 分単位で効く", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  await page.selectOption('select[aria-label="表示する人員"]', "0");
  const capacityOn = async (date) => {
    const label = await page.locator(`.day[aria-label*="${date}"]`).getAttribute("aria-label");
    return Number(label.match(/: ([\d.]+)/)[1]);
  };
  const before = await capacityOn("2026-09-28");

  // 10:00〜10:45 を 10:00〜10:05 に縮めると、その 40 分ぶん稼働が戻る。
  const firstEvent = page.locator(".event-card").first();
  await recompute(page, () =>
    firstEvent.locator('input[type="time"]').nth(1).fill("10:05"),
  );
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
  await recompute(page, () => page.locator("select.assignee").first().selectOption(""));
  await openTab(page, "schedule");
  // 人員ごとの表に「未割当」が現れる。
  await expect(page.locator(".member-summary")).toContainText("未割当");
});

test("祝日を使わない設定にすると稼働量が増える", async ({ page }) => {
  await open(page);
  await openTab(page, "calendar");
  const total = async () =>
    Number((await page.locator(".card .status").first().innerText()).match(/で ([\d.]+) 人日/)[1]);
  const before = await total();

  await recompute(page, () => page.uncheck('.card .toggle input[type="checkbox"]'));
  expect(await total()).toBeGreaterThan(before);
});

test("スケジュールにタスクごとの完了予測と確率が出る", async ({ page }) => {
  await open(page);
  await openTab(page, "schedule");
  await expect(page.locator("#schedule-chart")).toBeVisible();

  // 全体を含めて 9 行。
  const table = page.locator(".probe-table tbody tr");
  await expect(table).toHaveCount(9);
  await expect(table.last()).toContainText("全体");

  // 完了確率は 0〜100% の範囲で、後ろのタスクほど低い。
  const values = await page.$$eval(".probe-table .bar-value", (cells) =>
    cells.map((cell) => Number(cell.textContent.replace("%", ""))),
  );
  expect(Math.max(...values)).toBeLessThanOrEqual(100);
  expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
  expect(values[0]).toBeGreaterThanOrEqual(values[values.length - 1]);

  // 日付を早めると確率は下がる。
  await page.locator('.probe-row input[type="date"]').fill("2026-10-01");
  const early = await page.$$eval(".probe-table .bar-value", (cells) =>
    cells.map((cell) => Number(cell.textContent.replace("%", ""))),
  );
  expect(early[early.length - 1]).toBeLessThanOrEqual(values[values.length - 1]);
});

test("サマリバーが工数と完了日を常に示す", async ({ page }) => {
  await open(page);
  expect(Number(await summary(page, "effortP80"))).toBeGreaterThan(40);
  expect(await summary(page, "finishP80")).toMatch(/\d/);
  expect(await summary(page, "progress")).toBe("0%");
});

test("ファイルに保存して読み込み直すと新しいプロジェクトになる", async ({ page }) => {
  await open(page);
  await recompute(page, () => rows(page).nth(1).locator('input[type="number"]').first().fill("7"));

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
  await expect(rows(page).nth(1).locator('input[type="text"]').first()).toHaveValue(
    "保存されるはず",
  );
});

/* ===== プロジェクトと権限 ===== */

test("プロジェクトを増やして切り替えられる", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");
  await expect(page.locator("tr[data-project]")).toHaveCount(1);

  await page.click('button:text("新しいプロジェクト")');
  await expect(page.locator("tr[data-project]")).toHaveCount(2);
  // 新しいほうが開いている。空なので計算するものが無い。
  await expect(page.locator("#status")).toContainText("計算するタスクがありません");

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
  await expect(page.locator(".project-picker option").first()).toHaveText(/名前を変えた案件/);

  await page.click('button:text("複製する")');
  await expect(page.locator("tr[data-project]")).toHaveCount(2);
  await expect(page.locator('tr[data-project][data-open="true"] input').first()).toHaveValue(
    /のコピー/,
  );
  // 複製した中身も引き継がれる。
  await openTab(page, "tasks");
  await expect(rows(page)).toHaveCount(8);

  await openTab(page, "projects");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('tr[data-project] button[title="削除する"]').first().click();
  await expect(page.locator("tr[data-project]")).toHaveCount(1);
});

test("共有した相手は与えた権限の範囲でしか触れない", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");

  // 相手のアカウントを作る。
  await page.click('button:text("アカウントを追加")');
  await expect(page.locator("tr[data-account]")).toHaveCount(2);
  const otherName = page.locator("tr[data-account]").nth(1).locator("input").first();
  await otherName.fill("鈴木");
  await otherName.blur();

  // 閲覧者として共有する。
  const addRow = page.locator(".card", { hasText: "このプロジェクトの共有" }).locator(".inline-row");
  await addRow.locator("select").nth(1).selectOption("viewer");
  await addRow.locator('button:text("共有する")').click();
  await expect(page.locator("tr[data-principal]")).toHaveCount(2);

  // その人として操作すると、読み取り専用になる。
  await actAs(page, "鈴木");
  await openTab(page, "tasks");
  await expect(page.locator("#readonly-banner")).toContainText("閲覧のみ");
  await expect(page.locator("fieldset.readonly")).toBeVisible();
  await expect(rows(page).first().locator('input[type="text"]').first()).toBeDisabled();
  // 計算結果は見える (見るだけならできる)。
  await openTab(page, "distribution");
  await expect(page.locator('.tile[data-key="p80"]')).toBeVisible();
});

test("所有者がいなくなる操作は拒否される", async ({ page }) => {
  await open(page);
  await openTab(page, "projects");
  // 唯一の所有者である自分の共有を解除しようとする。
  await page.locator('tr[data-principal] button[title*="共有を解除"]').first().click();
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
  await expect(page.locator('.tabs button[data-tab="schedule"]')).toHaveText("Schedule");
  await expect(rows(page)).toHaveCount(8);

  await page.click('.lang-toggle button[data-lang="ja"]');
  await expect(page.locator("h1")).toHaveText("工数見積もり");
});

test("未置換の i18n プレースホルダが画面に残らない", async ({ page }) => {
  await open(page);
  for (const language of ["en", "ja"]) {
    await page.click(`.lang-toggle button[data-lang="${language}"]`);
    for (const tab of ["tasks", "members", "calendar", "distribution", "schedule"]) {
      await openTab(page, tab);
      const text = await page.locator("body").innerText();
      expect(text, `${language}/${tab} に差し込み漏れがある`).not.toMatch(/\{[a-z]+\}/);
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
  await openTab(page, "distribution");
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
  await expect(page.locator("#chart-tooltip")).toHaveAttribute("data-visible", "true");
});
