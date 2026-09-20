/**
 * アプリの入り口。状態を持ち、変更を受けて再計算し、画面を組み立てる。
 *
 * 画面は変更のたびに作り直す。差分更新を避けるかわりに、入力中の
 * フォーカスとカーソル位置だけは明示的に持ち越している (`captureFocus`)。
 */

import "./styles.css";

import { P80_INDEX } from "./abi.ts";
import { TABS, type AppActions, type AppState, type AppWidgets } from "./app.ts";
import { createDistributionChart } from "./charts/distribution.ts";
import { createScheduleChart } from "./charts/schedule.ts";
import { dayFromIso, formatDayShort, formatNumber, formatPercent, todayIso } from "./format.ts";
import { lang, setLang, t } from "./i18n.ts";
import { emptyProject, sampleProject } from "./model/project.ts";
import { buildScheduleModel } from "./model/schedule.ts";
import { buildRows, invalidRows } from "./model/tree.ts";
import {
  csvToTasks,
  downloadCsv,
  downloadProject,
  loadLocal,
  projectToCsv,
  readProjectFile,
  saveLocal,
} from "./model/storage.ts";
import { button, h, clear } from "./ui/dom.ts";
import { renderCalendarTab } from "./ui/calendar.ts";
import { renderDistributionTab } from "./ui/results.ts";
import { renderScheduleTab } from "./ui/schedule.ts";
import { renderTasksTab } from "./ui/tasks.ts";
import { ComputeError, boot, buildRequest, compute, leafInputFromTask } from "./wasm.ts";

const PREFIX_BINS = 256;
const COMPUTE_DELAY_MS = 220;
const AUTOSAVE_DELAY_MS = 900;

const today = todayIso();
const startMonth = new Date(`${today}T00:00:00Z`);

const state: AppState = {
  project: emptyProject("project"),
  rows: [],
  result: null,
  schedule: null,
  filter: { text: "", group: "", priority: "", state: "" },
  columnMode: "estimate",
  activeTab: "tasks",
  calendarMonth: { year: startMonth.getUTCFullYear(), month: startMonth.getUTCMonth() + 1 },
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
let autosaveTimer: number | undefined;

function setStatus(text: string, tone: "info" | "error" = "info"): void {
  state.status = { text, tone };
}

function recompute(): void {
  state.rows = buildRows(state.project.tasks);
  const leaves = state.rows.filter((row) => row.leafIndex !== null);
  const broken = invalidRows(state.rows);

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
      leaves.map((row) => leafInputFromTask(row.task)),
      state.project.calendar,
      state.project.settings,
      PREFIX_BINS,
    );
    state.result = compute(request);
  } catch (error) {
    state.result = null;
    state.schedule = null;
    if (error instanceof ComputeError) {
      const key = `error.${error.status}` as `error.${1 | 2 | 3 | 4 | 5 | 6 | 7}`;
      const known = [1, 2, 3, 4, 5, 6, 7].includes(error.status);
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
    dayFromIso(state.project.calendar.today) ?? state.result.calendarStartDay,
    t("tasks.untitled"),
  );
  setStatus(
    t("status.done", {
      engine: t(
        state.project.settings.engine === 0 ? "settings.engine.mc" : "settings.engine.conv",
      ),
      ms: Math.round(performance.now() - started),
    }),
  );
}

function scheduleAutosave(): void {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    saveLocal(state.project);
  }, AUTOSAVE_DELAY_MS);
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
      void readProjectFile(file).then((project) => {
        if (project === null) {
          setStatus(t("file.badFile"), "error");
          render();
          return;
        }
        state.project = project;
        setStatus(t("file.imported", { name: file.name }));
        refreshAll();
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
      void file.text().then((text) => {
        const tasks = csvToTasks(text);
        if (tasks.length === 0) {
          setStatus(t("file.badFile"), "error");
          render();
          return;
        }
        state.project.tasks = tasks;
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
        downloadProject(state.project);
        setStatus(t("file.saved"));
        render();
      }),
      button(t("file.open"), () => {
        fileInput.click();
      }),
      h("hr"),
      button(t("file.exportCsv"), () => {
        downloadCsv(state.project.name, projectToCsv(state.rows));
      }),
      button(t("file.importCsv"), () => {
        csvInput.click();
      }),
      h("hr"),
      button(t("file.sample"), () => {
        state.project = sampleProject(lang());
        refreshAll();
      }),
      button(t("file.new"), () => {
        if (state.project.tasks.length > 0 && !confirm(t("file.confirmNew"))) return;
        state.project = emptyProject("project");
        refreshAll();
      }),
    ]),
  ]);
  // 項目を選んだら閉じる。
  menu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).tagName === "BUTTON") menu.open = false;
  });
  return menu;
}

function header(): HTMLElement {
  return h("header", {}, [
    h("div", { class: "title-row" }, [
      h("h1", { text: t("app.title") }),
      h("input", {
        class: "project-name",
        attrs: {
          type: "text",
          value: state.project.name,
          "aria-label": t("file.projectName"),
          placeholder: t("file.projectName"),
        },
        dataset: { focus: "project:name" },
        on: {
          input: (event) => {
            state.project.name = (event.target as HTMLInputElement).value;
            scheduleAutosave();
          },
        },
      }),
      fileMenu(),
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

function tabContent(actions: AppActions): HTMLElement {
  switch (state.activeTab) {
    case "tasks":
      return renderTasksTab(state, actions);
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
  root.append(
    header(),
    tabBar(),
    h("p", {
      class: "status",
      id: "status",
      text: state.status.text,
      dataset: { tone: state.status.tone, run: String(runCount) },
    }),
    h("div", { class: "tab-panel", attrs: { role: "tabpanel" } }, [tabContent(actions)]),
    h("footer", {}, [h("p", { text: t("footer.offline") }), h("p", { text: t("footer.engine") })]),
  );
  restoreFocus(focus);

  // グラフは DOM に載ってから描く (大きさが決まらないと解像度を合わせられない)。
  if (state.activeTab === "distribution") distributionChart.redraw();
  if (state.activeTab === "schedule") scheduleChart.redraw();
}

let runCount = 0;

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
  scheduleAutosave();
}

const actions: AppActions = {
  mutate(change) {
    change(state.project);
    window.clearTimeout(computeTimer);
    computeTimer = window.setTimeout(refreshAll, COMPUTE_DELAY_MS);
    // 構造の変化はすぐ画面に出す。数字の更新だけ少し遅れて追いつく。
    state.rows = buildRows(state.project.tasks);
    render();
  },
  patch(change) {
    change(state);
    render();
  },
  render,
};

/* ===== 起動 ================================================= */

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

  state.project = loadLocal() ?? sampleProject(lang());
  if (state.project.calendar.today !== today) state.project.calendar.today = today;
  refreshAll();
}

document.addEventListener("DOMContentLoaded", () => {
  void main();
});
