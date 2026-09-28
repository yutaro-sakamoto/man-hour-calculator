// 現場を模したシミュレーション (PM・上長・顧客・新任リーダー・保守リーダーの
// 役を立てて 12 週ぶん使った) で見つかったものの回帰テスト。
//
// どれも「動いてはいたが、実務で誤読・遠回り・取りこぼしを生んだ」もの。
// 計算の側 (基準日から積む・前提・実績工数) は Rust のテストが見ている。
// ここは画面から見える振る舞いだけ。
const { test, expect } = require("@playwright/test");
const { open } = require("./support");

const openTab = (page, tab) => page.click(`.tabs button[data-tab="${tab}"]`);

test("升を押しただけの予定は、× で閉じると残らない", async ({ page }) => {
  // 押した時点で予定ができ、× で閉じても「新しい予定」が残って、
  // 知らないうちにその日の稼働が減っていた。
  await open(page);
  await openTab(page, "calendar");
  const cell = page.locator('.day[data-day="2026-09-29"]');
  await expect(cell.locator(".event-chip")).toHaveCount(0);

  await cell.locator(".day-add").click();
  await expect(page.locator(".modal-card")).toBeVisible();
  await page.locator('.modal-card button[title="閉じる"]').click();
  await expect(page.locator(".modal-card")).toHaveCount(0);
  await expect(cell.locator(".event-chip")).toHaveCount(0);
});

test("開き直すと、前回開いていたプロジェクトが開く", async ({ page }) => {
  // 見本が開いていることに気づかず、そこへ CSV を読み込んで上書きしていた。
  await open(page);
  await openTab(page, "projects");
  await page.click('button:text-is("新しいプロジェクト")');
  const picker = page.locator("select.project-picker");
  await expect(picker.locator("option")).toHaveCount(2);
  const sample = await picker
    .locator("option", { hasText: "Sample project" })
    .getAttribute("value");
  await expect(picker).not.toHaveValue(sample ?? "");
  const created = await picker.inputValue();

  await page.reload();
  await expect(page.locator(".summary-bar")).toBeVisible();
  await expect(picker).toHaveValue(created);
});

test("表で進捗をその場で書ける。末端の行は入れた値のまま出る", async ({
  page,
}) => {
  // 実績の入力に 1 件ずつ詳細を開閉していた (1 件 3〜4 操作)。
  // 計算した比率を出していたので、90% と入れた行が 93% と出ていた。
  await open(page);
  await openTab(page, "tasks");
  const row = page.locator("tr.task-row").nth(1);
  const input = row.locator('td[data-progress] input[type="number"]');
  await input.fill("40");
  await expect(row.locator("td[data-progress]")).toHaveAttribute(
    "data-progress",
    "40",
  );
  await expect(row.locator(".pill")).toHaveText("進行中");
});

test("見通しの先頭に、期限までの確率と週報に貼れる文が出る", async ({
  page,
}) => {
  // 期限での確率は折りたたみの奥にしかなく、既定の日付も期限ではなかった。
  await open(page);
  await openTab(page, "forecast");
  const report = page.locator('[data-card="report"]');
  await expect(report).toBeVisible();
  await expect(report.locator('[data-key="due"]')).toContainText("%");
  await expect(report.locator("textarea")).toHaveValue(/完了日 P50/);

  // 予算を入れると、予算内に収まる確率と着地見込みが出る。
  await report.locator('input[aria-label="予算 (人日)"]').fill("45");
  await expect(report.locator('[data-key="budget"]')).toContainText("%");
  await expect(report.locator('[data-key="landing"]')).toContainText("P80");
});

test("見積もりが空の行があっても、残りで計算を続ける", async ({ page }) => {
  // 1 件読めないだけで、上の帯の数字が全部「—」になっていた。
  await open(page);
  await openTab(page, "tasks");
  await page.click("#add-row");
  await page.keyboard.press("Escape");
  await expect(page.locator(".chip.warn")).toContainText("見積もり未入力");
  await expect(
    page.locator('.summary-item[data-key="finishP80"]'),
  ).not.toHaveAttribute("data-value", "—");
  await expect(page.locator("#status")).toContainText("計算に入れていません");
});

test("期限を変えると、期限までの確率がその場で変わる", async ({ page }) => {
  // 期限を 12/25 から 1/8 に変えても、古い期限のまま 100% と出ていた。
  await open(page);
  await openTab(page, "forecast");
  const due = page.locator('[data-card="report"] [data-key="due"]');
  await expect(due).toContainText("%");

  await openTab(page, "projects");
  await page
    .locator('tr[data-project][data-open="true"] input[type="date"]')
    .fill("2026-09-02");
  await openTab(page, "forecast");
  await expect(page.locator('[data-card="report"] dt').nth(1)).toContainText(
    "2026-09-02",
  );
  await expect(due).toContainText("0%");
});
