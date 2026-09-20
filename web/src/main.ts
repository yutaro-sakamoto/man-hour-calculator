/**
 * アプリの入り口。
 *
 * 画面は {@link ApiClient} しか知らない。その後ろがローカルの WASM でも
 * 社内サーバでも、通る道は同じ。ここでは
 *
 * 1. 接続先を決めて起動する
 * 2. プロジェクトを開いて内容を編集する
 * 3. 変更を API に保存し、計算し直して描き直す
 *
 * の 3 つをつないでいる。
 *
 * 画面は変更のたびに作り直す。差分更新を避けるかわりに、入力中の
 * フォーカスとカーソル位置だけは明示的に持ち越している (`captureFocus`)。
 */

import "./styles.css";

import { P80_INDEX } from "./abi.ts";
import { LocalApiClient } from "./api/local.ts";
import { ApiError, type ProjectDocument, type User } from "./api/types.ts";
import { TABS, canWrite, type AppActions, type AppState, type AppWidgets } from "./app.ts";
import { createDistributionChart } from "./charts/distribution.ts";
import { createScheduleChart } from "./charts/schedule.ts";
import { dayFromIso, formatDayShort, formatNumber, formatPercent, todayIso } from "./format.ts";
import { lang, setLang, t } from "./i18n.ts";
import { memberLabel, resolveMembers } from "./model/members.ts";
import { emptyDocument, newId, sampleDocument, sampleName } from "./model/project.ts";
import { buildScheduleModel } from "./model/schedule.ts";
import { downloadCsv, downloadProject, projectToCsv, readFile } from "./model/storage.ts";
import { csvToTasks } from "./model/storage.ts";
import { buildRows, invalidRows } from "./model/tree.ts";
import { renderCalendarTab } from "./ui/calendar.ts";
import { button, clear, h } from "./ui/dom.ts";
import { renderMembersTab } from "./ui/members.ts";
import { renderProjectsTab } from "./ui/projects.ts";
import { renderDistributionTab } from "./ui/results.ts";
import { renderScheduleTab } from "./ui/schedule.ts";
import { renderTasksTab } from "./ui/tasks.ts";
import { ComputeError, boot, buildRequest, compute, leafInputFromTask } from "./wasm.ts";

const PREFIX_BINS = 256;
const COMPUTE_DELAY_MS = 220;
const SAVE_DELAY_MS = 700;
/** ローカルで使う、ただ 1 人の持ち主のアカウント id。 */
const LOCAL_OWNER = "local-owner";

const today = todayIso();
const startMonth = new Date(`${today}T00:00:00Z`);

const placeholderUser: User = {
  id: LOCAL_OWNER,
  name: "",
  systemRole: "admin",
  createdAt: new Date().toISOString(),
};

const state: AppState = {
  client: new LocalApiClient(LOCAL_OWNER),
  me: placeholderUser,
  users: [],
  projects: [],
  open: null,
  document: emptyDocument(),
  rows: [],
  result: null,
  schedule: null,
  members: { all: [], indexById: new Map(), unassignedIndex: null },
  filter: { text: "", group: "", priority: "", state: "", assignee: "" },
  columnMode: "estimate",
  activeTab: "tasks",
  calendarMonth: { year: startMonth.getUTCFullYear(), month: startMonth.getUTCMonth() + 1 },
  calendarMember: null,
  status: { text: "", tone: "info" },
  probeDate: null,
};

const root = document.createElement("div");
root.className = "wrap";

interface ChartHost {
  figure: HTMLElement;
  canvas: HTMLCanvasElement;
  tooltip: HTMLElement;
}

/** グラフを載せる枠。canvas と吹き出しは作り直さず使い回す。 */
function chartHost(
  canvasId: string,
  tooltipId: string,
  labelKey: "chart.altHist" | "sched.ganttTitle",
): ChartHost {
  const canvas = h("canvas", {
    id: canvasId,
    attrs: { tabindex: 0, role: "img", "aria-label": t(labelKey) },
  });
  const tooltip = h("div", {
    id: tooltipId,
    class: "tooltip",
    attrs: { role: "status", "aria-live": "polite" },
  });
  return { figure: h("figure", { class: "chart-box" }, [canvas, tooltip]), canvas, tooltip };
}

const distributionHost = chartHost("chart", "chart-tooltip", "chart.altHist");
const scheduleHost = chartHost("schedule-chart", "schedule-tooltip", "sched.ganttTitle");

const widgets: AppWidgets = {
  distributionFigure: distributionHost.figure,
  scheduleFigure: scheduleHost.figure,
};

const distributionChart = createDistributionChart(
  distributionHost.canvas,
  distributionHost.tooltip,
  lang,
);
const scheduleChart = createScheduleChart(scheduleHost.canvas, scheduleHost.tooltip, lang);

/* ===== 計算 ================================================= */

let computeTimer: number | undefined;
let saveTimer: number | undefined;
let runCount = 0;

function setStatus(text: string, tone: "info" | "error" = "info"): void {
  state.status = { text, tone };
}

function recompute(): void {
  state.rows = buildRows(state.document.tasks);
  const leaves = state.rows.filter((row) => row.leafIndex !== null);
  const broken = invalidRows(state.rows);

  // 担当者のいないタスクは「未割当」という仮の人員にまとめる。
  state.members = resolveMembers(
    state.document.calendar.members,
    leaves.map((row) => row.task),
  );
  if (state.calendarMember !== null && state.calendarMember >= state.members.all.length) {
    state.calendarMember = null;
  }

  if (broken.length > 0) {
    state.result = null;
    state.schedule = null;
    setStatus(t("error.invalidRows", { count: broken.length }), "error");
    return;
  }
  if (leaves.length === 0) {
    state.result = null;
    state.schedule = null;
    setStatus(t("status.noTasks"), "error");
    return;
  }

  const started = performance.now();
  try {
    const request = buildRequest(
      leaves.map((row) => leafInputFromTask(row.task, state.members)),
      state.document.calendar,
      state.members,
      state.document.settings,
      PREFIX_BINS,
    );
    state.result = compute(request);
  } catch (error) {
    state.result = null;
    state.schedule = null;
    if (error instanceof ComputeError) {
      const key = `error.${error.status}` as `error.${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
      const known = [1, 2, 3, 4, 5, 6, 7, 8].includes(error.status);
      setStatus(
        known ? t(key, { index: error.detail + 1 }) : t("error.unknown", { code: error.status }),
        "error",
      );
    } else {
      setStatus(t("error.boot", { message: String(error) }), "error");
    }
    return;
  }

  state.schedule = buildScheduleModel(
    state.result,
    state.rows,
    dayFromIso(state.document.calendar.today) ?? state.result.calendarStartDay,
    t("tasks.untitled"),
    state.members.all.map(memberLabel),
  );
  setStatus(
    t("status.done", {
      engine: t(
        state.document.settings.engine === 0 ? "settings.engine.mc" : "settings.engine.conv",
      ),
      ms: Math.round(performance.now() - started),
    }),
  );
}

/** 変更を API に保存する。閲覧権限しか無いときは何もしない。 */
function scheduleSave(): void {
  const open = state.open;
  if (open === null || !canWrite(state)) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void state.client
      .saveDocument(open.id, state.document)
      .then((summary) => {
        state.projects = state.projects.map((item) => (item.id === summary.id ? summary : item));
        if (state.open) state.open.updatedAt = summary.updatedAt;
      })
      .catch((error: unknown) => {
        reportError(error);
        render();
      });
  }, SAVE_DELAY_MS);
}

function reportError(error: unknown): void {
  if (error instanceof ApiError) {
    setStatus(t(`api.${error.code}`, { message: error.message }), "error");
  } else {
    setStatus(String(error), "error");
  }
}

/* ===== フォーカスの持ち越し ================================== */

interface FocusSnapshot {
  key: string;
  start: number | null;
  end: number | null;
}

function captureFocus(): FocusSnapshot | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLSelectElement)) return null;
  const key = active.dataset.focus;
  if (key === undefined) return null;
  const canSelect = active instanceof HTMLInputElement && active.type !== "date";
  return {
    key,
    start: canSelect ? active.selectionStart : null,
    end: canSelect ? active.selectionEnd : null,
  };
}

function restoreFocus(snapshot: FocusSnapshot | null): void {
  if (!snapshot) return;
  const target = root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(snapshot.key)}"]`);
  if (!target) return;
  target.focus();
  if (target instanceof HTMLInputElement && snapshot.start !== null) {
    try {
      target.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
    } catch {
      /* 選択範囲を持てない種類の入力では無視してよい */
    }
  }
}

/* ===== 画面 ================================================= */

function summaryBar(): HTMLElement {
  const l = lang();
  const result = state.result;
  const schedule = state.schedule;
  const none = t("summary.noData");

  const effort = result === null ? none : formatNumber(result.percentiles[P80_INDEX] ?? 0, l);
  const finishDay = schedule?.overallMarks.p80 ?? null;
  const finish =
    schedule === null
      ? none
      : finishDay === null
        ? t("summary.notFinishing")
        : formatDayShort(schedule.startDay + finishDay, l);
  const progress =
    result === null || result.mean <= 0
      ? none
      : formatPercent(result.totalSpent / result.mean, l, 0);
  const remaining =
    result === null ? none : formatNumber(Math.max(0, result.mean - result.totalSpent), l);

  const item = (label: string, value: string, key: string, accent = false): HTMLElement =>
    h("div", { class: `summary-item${accent ? " accent" : ""}`, dataset: { key, value } }, [
      h("span", { class: "summary-label", text: label }),
      h("strong", { class: "summary-value", text: value }),
    ]);

  return h("div", { class: "summary-bar" }, [
    item(`${t("summary.effortP80")} (${t("unit.days")})`, effort, "effortP80", true),
    item(t("summary.finishP80"), finish, "finishP80", true),
    item(t("summary.progress"), progress, "progress"),
    item(`${t("summary.remaining")} (${t("unit.days")})`, remaining, "remaining"),
  ]);
}

const fileInput = h("input", {
  attrs: { type: "file", accept: ".json,.mhc.json,application/json" },
  style: { display: "none" },
  on: {
    change: (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      actions.run(async () => {
        const loaded = await readFile(file);
        if (loaded === null) {
          setStatus(t("file.badFile"), "error");
          return;
        }
        // 読み込んだ内容は、いまのプロジェクトを潰さずに新しい 1 件として足す。
        await openProject(await state.client.createProject(newId(), loaded.name, loaded.document));
        setStatus(t("file.imported", { name: file.name }));
      });
    },
  },
});

const csvInput = h("input", {
  attrs: { type: "file", accept: ".csv,text/csv" },
  style: { display: "none" },
  on: {
    change: (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      actions.run(async () => {
        const tasks = csvToTasks(await file.text());
        if (tasks.length === 0) {
          setStatus(t("file.badFile"), "error");
          return;
        }
        state.document.tasks = tasks;
        setStatus(t("file.imported", { name: file.name }));
        refreshAll();
      });
    },
  },
});

function fileMenu(): HTMLElement {
  const menu = h("details", { class: "menu" }, [
    h("summary", { text: t("file.menu") }),
    h("div", { class: "menu-panel" }, [
      button(t("file.save"), () => {
        downloadProject(state.open?.name ?? "project", state.document);
        setStatus(t("file.saved"));
        render();
      }),
      button(t("file.open"), () => {
        fileInput.click();
      }),
      h("hr"),
      button(t("file.exportCsv"), () => {
        downloadCsv(state.open?.name ?? "project", projectToCsv(state.rows));
      }),
      button(
        t("file.importCsv"),
        () => {
          csvInput.click();
        },
        { attrs: { disabled: !canWrite(state) } },
      ),
    ]),
  ]);
  menu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).tagName === "BUTTON") menu.open = false;
  });
  return menu;
}

/** プロジェクトの切り替え。 */
function projectPicker(): HTMLElement {
  if (state.projects.length === 0) {
    return h("span", { class: "chip muted", text: t("projects.none") });
  }
  const select = h(
    "select",
    {
      class: "project-picker",
      dataset: { focus: "project:picker" },
      attrs: { "aria-label": t("projects.switch") },
      on: {
        change: (event) => {
          const id = (event.target as HTMLSelectElement).value;
          actions.run(async () => {
            await openProject(await state.client.getProject(id));
          });
        },
      },
    },
    state.projects.map((project) =>
      h("option", {
        text: `${project.name}${project.role === "owner" ? "" : ` (${t(`role.${project.role}`)})`}`,
        attrs: { value: project.id, selected: project.id === state.open?.id },
      }),
    ),
  );
  select.value = state.open?.id ?? "";
  return select;
}

function header(): HTMLElement {
  return h("header", {}, [
    h("div", { class: "title-row" }, [
      h("h1", { text: t("app.title") }),
      projectPicker(),
      fileMenu(),
      h("span", {
        class: `chip${state.client.remote ? "" : " muted"}`,
        title: t("api.connectionHint"),
        text: state.client.remote
          ? t("api.connectedTo", { target: state.client.label })
          : t("api.local"),
      }),
      h("div", { class: "lang-toggle", attrs: { role: "group", "aria-label": "Language" } }, [
        ...(["ja", "en"] as const).map((code) =>
          button(
            t(code === "ja" ? "lang.ja" : "lang.en"),
            () => {
              setLang(code);
              render();
              distributionChart.redraw();
              scheduleChart.redraw();
            },
            { attrs: { "aria-pressed": lang() === code }, dataset: { lang: code } },
          ),
        ),
      ]),
    ]),
    h("p", { class: "tagline", text: t("app.tagline") }),
    summaryBar(),
  ]);
}

function tabBar(): HTMLElement {
  return h(
    "div",
    { class: "tabs", attrs: { role: "tablist" } },
    TABS.map((tab) =>
      button(
        t(`tab.${tab}`),
        () => {
          state.activeTab = tab;
          render();
        },
        {
          attrs: { role: "tab", "aria-selected": state.activeTab === tab },
          dataset: { tab },
        },
      ),
    ),
  );
}

function tabContent(): HTMLElement {
  switch (state.activeTab) {
    case "projects":
      return renderProjectsTab(state, actions);
    case "tasks":
      return renderTasksTab(state, actions);
    case "members":
      return renderMembersTab(state, actions);
    case "calendar":
      return renderCalendarTab(state, actions);
    case "distribution":
      return renderDistributionTab(state, actions, widgets);
    case "schedule":
      return renderScheduleTab(state, actions, widgets);
  }
}

function render(): void {
  // 言語は毎回書き戻す。切り替えたときに <html lang> が取り残されると、
  // 読み上げソフトや辞書機能が古い言語のまま扱ってしまう。
  document.documentElement.lang = lang();
  const focus = captureFocus();
  clear(root);

  const editable = canWrite(state) || state.activeTab === "projects";
  const panel = h("div", { class: "tab-panel", attrs: { role: "tabpanel" } }, [
    // 閲覧権限しか無いときは、まとめて操作を止める。個々の入力に
    // disabled を配るより取りこぼしが無い。
    editable
      ? tabContent()
      : h("fieldset", { class: "readonly", attrs: { disabled: true } }, [tabContent()]),
  ]);

  root.append(
    header(),
    tabBar(),
    h("p", {
      class: "status",
      id: "status",
      text: state.status.text,
      dataset: { tone: state.status.tone, run: String(runCount) },
    }),
    editable
      ? panel
      : h("div", {}, [
          h("p", { id: "readonly-banner", class: "hint warn", text: t("role.readOnly") }),
          panel,
        ]),
    h("footer", {}, [h("p", { text: t("footer.offline") }), h("p", { text: t("footer.engine") })]),
  );
  restoreFocus(focus);

  if (state.activeTab === "distribution") distributionChart.redraw();
  if (state.activeTab === "schedule") scheduleChart.redraw();
}

function refreshAll(): void {
  recompute();
  runCount += 1;
  distributionChart.setData(
    state.result === null
      ? null
      : {
          lo: state.result.lo,
          hi: state.result.hi,
          probs: state.result.probs,
          cdf: state.result.cdf,
          p80: state.result.percentiles[P80_INDEX] ?? 0,
        },
  );
  scheduleChart.setData(state.schedule);
  render();
  scheduleSave();
}

const actions: AppActions = {
  mutate(change) {
    change(state.document);
    window.clearTimeout(computeTimer);
    computeTimer = window.setTimeout(refreshAll, COMPUTE_DELAY_MS);
    // 構造の変化はすぐ画面に出す。数字の更新だけ少し遅れて追いつく。
    state.rows = buildRows(state.document.tasks);
    render();
  },
  patch(change) {
    change(state);
    render();
  },
  openProject(id) {
    return reopen(id);
  },
  run(action) {
    void action()
      .catch((error: unknown) => {
        reportError(error);
      })
      .finally(() => {
        render();
      });
  },
  render,
};

/* ===== プロジェクトの開閉 =================================== */

async function reloadProjects(): Promise<void> {
  state.projects = await state.client.listProjects();
  state.users = await state.client.listUsers();
}

async function openProject(project: {
  id: string;
  name: string;
  access: AppState["open"] extends null ? never : NonNullable<AppState["open"]>["access"];
  updatedAt: string;
  document: ProjectDocument;
}): Promise<void> {
  // 直接の付与から自分の役割を引く。グループ経由の分やシステム管理者の扱いは
  // API 側が決めるので、ここで分からなければ一覧が返した役割に従う。
  const granted = project.access.find(
    (entry) => entry.principal.kind === "user" && entry.principal.id === state.me.id,
  )?.role;
  const role = granted ?? state.projects.find((item) => item.id === project.id)?.role ?? "viewer";
  state.open = {
    id: project.id,
    name: project.name,
    role,
    access: project.access,
    updatedAt: project.updatedAt,
  };
  state.document = project.document;
  // 基準日は開いた日に合わせる。保存された日付のまま進捗を測らない。
  if (state.document.calendar.today !== today) state.document.calendar.today = today;
  await reloadProjects();
  refreshAll();
}

async function reopen(id: string): Promise<void> {
  await openProject(await state.client.getProject(id));
}

/* ===== 起動 ================================================= */

/** まっさらなときの初期化。持ち主のアカウントと見本のプロジェクトを作る。 */
async function seed(): Promise<void> {
  const client = state.client;
  // 自分がいなければ作る。ローカルではこの 1 人が管理者。
  try {
    await client.me();
  } catch {
    LocalApiClient.replace(
      JSON.stringify({
        version: 1,
        users: [
          {
            id: LOCAL_OWNER,
            name: t("members.you"),
            systemRole: "admin",
            createdAt: new Date().toISOString(),
          },
        ],
        projects: [],
      }),
    );
    LocalApiClient.persist();
  }
  if ((await client.listProjects()).length === 0) {
    await client.createProject(newId(), sampleName(lang()), sampleDocument(lang()));
  }
}

async function main(): Promise<void> {
  document.body.append(root, fileInput, csvInput);
  setStatus(t("status.loading"));
  render();

  try {
    await boot();
  } catch (error) {
    setStatus(
      t("error.boot", { message: error instanceof Error ? error.message : String(error) }),
      "error",
    );
    render();
    return;
  }

  try {
    LocalApiClient.restore();
    await seed();
    state.me = await state.client.me();
    await reloadProjects();
    const first = state.projects[0];
    if (first) {
      await openProject(await state.client.getProject(first.id));
    } else {
      refreshAll();
    }
  } catch (error) {
    reportError(error);
    render();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void main();
});
