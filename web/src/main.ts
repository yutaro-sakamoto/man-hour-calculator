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
import type { ApiClient } from "./api/client.ts";
import { HttpApiClient } from "./api/http.ts";
import { LocalApiClient } from "./api/local.ts";
import { ApiError, type ProjectDocument, type ProjectStatus, type User } from "./api/types.ts";
import {
  TABS,
  canWrite,
  type AppActions,
  type AppState,
  type AppWidgets,
  type TabId,
} from "./app.ts";
import { createDistributionChart } from "./charts/distribution.ts";
import { createScheduleChart } from "./charts/schedule.ts";
import {
  addDays,
  dayFromIso,
  formatDayShort,
  formatNumber,
  formatPercent,
  todayIso,
} from "./format.ts";
import { lang, setLang, t } from "./i18n.ts";
import {
  loadConnection,
  loadLastProject,
  saveConnection,
  saveLastProject,
  type Connection,
} from "./model/connection.ts";
import { recordSnapshot, snapshotOf } from "./model/history.ts";
import { applyCalibration, calibrationOf } from "./model/calibration.ts";
import { memberLabel, resolveMembers } from "./model/members.ts";
import { createMember, emptyDocument, newId, sampleDocument, sampleName } from "./model/project.ts";
import { buildScheduleModel, withDueDate } from "./model/schedule.ts";
import { buildStatus } from "./model/status.ts";
import {
  downloadBundle,
  downloadCsv,
  downloadProject,
  projectToCsv,
  readAnyFile,
} from "./model/storage.ts";
import { readCsv, readCsvText } from "./model/storage.ts";
import type { ResolvedMembers } from "./model/members.ts";
import type { ScheduleModel } from "./model/schedule.ts";
import { buildRows, dependencyPairs, invalidRows, type TreeRow } from "./model/tree.ts";
import { renderCalendarTab } from "./ui/calendar.ts";
import { append, button, clear, h } from "./ui/dom.ts";
import { renderMembersTab } from "./ui/members.ts";
import { renderCommentsModal } from "./ui/comments.ts";
import { renderProjectsTab } from "./ui/projects.ts";
import { renderForecastTab } from "./ui/forecast.ts";
import { openTaskDetail } from "./ui/schedule.ts";
import { renderTaskDetailModal } from "./ui/taskDetail.ts";
import { renderTasksTab } from "./ui/tasks.ts";
import { cumulativeAt } from "./ui/results.ts";
import {
  ComputeError,
  boot,
  buildRequest,
  compute,
  leafInputFromTask,
  type ComputeResult,
} from "./wasm.ts";

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
  userGroups: [],
  projectGroups: [],
  projects: [],
  projectFilter: { text: "", group: "", health: "", role: "" },
  projectSort: "attention",
  openPanels: {},
  open: null,
  document: emptyDocument(),
  rows: [],
  result: null,
  schedule: null,
  members: { all: [], indexById: new Map(), unassignedIndex: null },
  filter: { text: "", group: "", priority: "", state: "", assignee: "" },
  activeTab: "tasks",
  calendarMonth: { year: startMonth.getUTCFullYear(), month: startMonth.getUTCMonth() + 1 },
  calendarMember: null,
  editingEventId: null,
  editingEventDay: null,
  editingEventIsNew: false,
  expandedDay: null,
  connectionDraft: null,
  comments: [],
  commentScope: null,
  commentDraft: "",
  commentPreview: false,
  editingCommentId: null,
  commentAttachments: [],
  status: { text: "", tone: "info" },
  probeDate: null,
  taskDetailId: null,
  hoursDraft: null,
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
  /** 中身の高さに合わせて伸びるか (タスクの数で背が変わる図)。 */
  grows = false,
): ChartHost {
  const canvas = h("canvas", {
    id: canvasId,
    dataset: { focus: `chart:${canvasId}` },
    attrs: { tabindex: 0, role: "img", "aria-label": t(labelKey) },
  });
  const tooltip = h("div", {
    id: tooltipId,
    class: "tooltip",
    attrs: { role: "status", "aria-live": "polite" },
  });
  return {
    figure: h("figure", { class: `chart-box${grows ? " grows" : ""}` }, [canvas, tooltip]),
    canvas,
    tooltip,
  };
}

const distributionHost = chartHost("chart", "chart-tooltip", "chart.altHist");
// 帯グラフはタスクの数だけ背が伸びる。入れ物を 340px に固定すると
// **はみ出した図が下の見出しに重なり、押せなくなる**。実際になっていた。
const scheduleHost = chartHost("schedule-chart", "schedule-tooltip", "sched.ganttTitle", true);

const widgets: AppWidgets = {
  distributionFigure: distributionHost.figure,
  scheduleFigure: scheduleHost.figure,
};

const distributionChart = createDistributionChart(
  distributionHost.canvas,
  distributionHost.tooltip,
  lang,
);
// 帯グラフの行を押すと、そのタスクの詳細が開く。表の名前と同じ道を通す。
// (`actions` はこの下で定義する。押されるのは描いたあとなので、そのときには在る。)
const scheduleChart = createScheduleChart(scheduleHost.canvas, scheduleHost.tooltip, lang, (id) => {
  openTaskDetail(actions, id);
});

/* ===== 計算 ================================================= */

let computeTimer: number | undefined;
let saveTimer: number | undefined;
let runCount = 0;

function setStatus(text: string, tone: "info" | "error" = "info"): void {
  state.status = { text, tone };
}

/** 1 回ぶんの計算結果。 */
interface Computed {
  rows: TreeRow[];
  members: ResolvedMembers;
  result: ComputeResult;
  schedule: ScheduleModel;
}

/**
 * 内容を 1 つ受け取って計算する。状態は触らない。
 *
 * 「いま開いているもの」と「一覧から計算し直すもの」で同じ道を通すために
 * 切り出してある。失敗は投げるので、呼び出し側が事情に合わせて扱う。
 */
function runEngine(document: ProjectDocument): Computed {
  const rows = buildRows(document.tasks);
  const leaves = rows.filter((row) => row.leafIndex !== null);
  // 見積もりが未入力・読めない行は、**除いて計算する**。1 件のために全体の
  // 数字を伏せていたころは、上の帯が全部「—」になり、どの行が悪いのかも
  // 分かりにくかった。除いたことは状態表示と行の印で知らせる (`recompute`)。
  // **「まだ無い」と「あるのに選ばれていない」を分ける。** 前者で
  // 「選んでください」と言っても、選ぶものが無い。次にやることが
  // 変わるのだから、言うことも変える。
  if (leaves.length === 0)
    throw new EngineUnavailable(rows.length === 0 ? t("status.noTasksYet") : t("status.noTasks"));

  // 担当者のいないタスクは「未割当」という仮の人員にまとめる。
  const members = resolveMembers(
    document.calendar.members,
    leaves.map((row) => row.task),
  );
  // 見積もりの偏りを掛けるなら、計算に渡すときだけ掛ける (画面の見積もりは
  // 書いたとおりのまま)。
  const hoursPerDay = document.calendar.hoursPerPersonDay;
  const calibration = document.calibrate ? calibrationOf(document.tasks, hoursPerDay) : null;
  const adjusted = new Map(
    (calibration === null ? [] : applyCalibration(document.tasks, calibration.factor)).map(
      (task) => [task.id, task],
    ),
  );
  const result = compute(
    buildRequest(
      leaves.map((row) =>
        leafInputFromTask(adjusted.get(row.task.id) ?? row.task, members, hoursPerDay),
      ),
      document.calendar,
      members,
      document.settings,
      PREFIX_BINS,
      dependencyPairs(rows),
    ),
  );
  const schedule = buildScheduleModel(
    result,
    rows,
    dayFromIso(document.calendar.today) ?? result.calendarStartDay,
    t("tasks.untitled"),
    members.all.map(memberLabel),
  );
  return { rows, members, result, schedule };
}

/**
 * 計算できる状態にない、というだけの失敗。異常ではない。
 *
 * **だから既定では赤くしない。** 新しく作ったプロジェクトは必ずここを
 * 通る。作った直後に赤い字が出ると、初めての人は「何か壊した」と読む。
 * 本当に直すものがあるとき (不正な行) だけ `tone` を `error` にする。
 */
class EngineUnavailable extends Error {
  constructor(
    message: string,
    readonly tone: "info" | "error" = "info",
  ) {
    super(message);
  }
}

function recompute(): void {
  const started = performance.now();
  let computed: Computed;
  try {
    computed = runEngine(state.document);
  } catch (error) {
    // 途中まで分かっていることは残す。人員一覧は画面が使う。
    state.rows = buildRows(state.document.tasks);
    state.members = resolveMembers(
      state.document.calendar.members,
      state.rows.filter((row) => row.leafIndex !== null).map((row) => row.task),
    );
    state.result = null;
    state.schedule = null;
    if (state.calendarMember !== null && state.calendarMember >= state.members.all.length) {
      state.calendarMember = null;
    }
    if (error instanceof EngineUnavailable) {
      setStatus(error.message, error.tone);
    } else if (error instanceof ComputeError) {
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

  state.rows = computed.rows;
  state.members = computed.members;
  state.result = computed.result;
  // 期限は内容の外 (プロジェクトの情報) にあるので、ここで載せる。
  state.schedule = withDueDate(computed.schedule, dayFromIso(openDueDate()));
  if (state.calendarMember !== null && state.calendarMember >= state.members.all.length) {
    state.calendarMember = null;
  }
  const broken = invalidRows(computed.rows);
  if (broken.length > 0) {
    setStatus(t("error.invalidRows", { count: broken.length }), "error");
    return;
  }
  setStatus(
    t("status.done", {
      // 前提があるとモンテカルロに切り替わる。指定ではなく、実際に使ったほうを言う。
      engine: t(computed.result.engineUsed === 0 ? "settings.engine.mc" : "settings.engine.conv"),
      ms: Math.round(performance.now() - started),
    }),
  );
}

/**
 * いまの計算結果から、一覧に出す控えを作る。
 *
 * 計算できていないとき (見積もりが不正、タスクが無い) は `undefined`。
 * そのときは控え無しで保存され、一覧には「再計算が必要」と出る。
 * 古い数字を新しい内容のものとして見せないため。
 */
function currentStatus(): ProjectStatus | undefined {
  if (state.result === null) return undefined;
  return buildStatus(state.document, state.result, state.schedule, new Date().toISOString());
}

/**
 * 保存待ち。プロジェクトを切り替える前に必ず流し切る。
 *
 * これが無いと、直前の編集が保存される前に切り替えが走って消えてしまう。
 */
let pendingSave: (() => Promise<void>) | null = null;

/** 変更を API に保存する。閲覧権限しか無いときは何もしない。 */
function scheduleSave(): void {
  const open = state.open;
  if (open === null || !canWrite(state)) return;

  // いま画面にある内容と、その内容から計算した控えを捕まえておく。
  // 送るころに state が別のプロジェクトを指していても取り違えない。
  const id = open.id;
  const document = state.document;
  const status = currentStatus();

  const save = async (): Promise<void> => {
    pendingSave = null;
    const summary = await state.client.saveDocument(id, document, status);
    state.projects = state.projects.map((item) => (item.id === summary.id ? summary : item));
    if (state.open?.id === id) state.open.updatedAt = summary.updatedAt;
    // 保存で状態の判定が変わる。描き直さないと一覧が古いままになる。
    render();
  };

  window.clearTimeout(saveTimer);
  pendingSave = save;
  saveTimer = window.setTimeout(() => {
    void save().catch((error: unknown) => {
      reportError(error);
      render();
    });
  }, SAVE_DELAY_MS);
}

/** 保存待ちがあれば先に済ませる。 */
async function flushSave(): Promise<void> {
  const save = pendingSave;
  if (save === null) return;
  window.clearTimeout(saveTimer);
  await save();
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
  // ボタンも拾う。タブを矢印で移ると描き直しが走るので、拾わないと
  // 1 回移っただけで焦点が本文へ落ちてしまう。
  // グラフ (canvas) も拾う。キーボードで行を選んでいる最中に自動保存の
  // 描き直しが入ると、焦点が外れて ↓ も Enter も効かなくなっていた。
  if (!(
    active instanceof HTMLInputElement ||
    active instanceof HTMLSelectElement ||
    active instanceof HTMLButtonElement ||
    active instanceof HTMLCanvasElement
  )) {
    return null;
  }
  const key = active.dataset.focus;
  if (key === undefined) return null;
  return {
    key,
    ...readSelection(active),
  };
}

/**
 * 選択範囲を読む。読めない種類の入力では `null`。
 *
 * `type="number"` と `type="date"` は選択範囲を持たない。**だから数値の欄は
 * 作り直してはいけない** — 位置を戻す手立てが無く、キャレットが先頭へ落ちる
 * (`type` を一時的に `text` にしても、戻した時点で選択は消える。確認済み)。
 * 値の編集で描き直しを起こさないのは、そのため ({@link AppActions.edit})。
 */
function readSelection(element: Element): { start: number | null; end: number | null } {
  if (!(element instanceof HTMLInputElement)) return { start: null, end: null };
  if (element.type === "date" || element.type === "number") {
    return { start: null, end: null };
  }
  return { start: element.selectionStart, end: element.selectionEnd };
}

function restoreFocus(snapshot: FocusSnapshot | null): void {
  if (!snapshot) return;
  const target = root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(snapshot.key)}"]`);
  if (!target) return;
  target.focus();
  if (!(target instanceof HTMLInputElement) || snapshot.start === null) return;
  try {
    target.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
  } catch {
    /* 選択範囲を持てない種類の入力では無視してよい */
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
  // 進捗と残りは、見通しタブと**同じ定義** (`model/progress.ts`) から出す。
  // ここだけ平均から引いていたころは、上の帯で 76.5、見通しタブで 72.0 と
  // 同じ「残り」が 2 つの値になり、どちらを報告すればよいか分からなかった。
  const overall = schedule?.overallProgress ?? null;
  const progress = overall === null ? none : formatPercent(overall.ratio, l, 0);
  const remaining = overall === null ? none : formatNumber(overall.remaining, l);

  // **説明は、疑問が起きる場所に置く。** いちばん目立つ数字が「P80」
  // なのに、その意味は「見通し」タブの奥にしか書かれていなかった。
  const item = (
    label: string,
    value: string,
    key: string,
    help: string,
    accent = false,
  ): HTMLElement =>
    h(
      "div",
      {
        class: `summary-item${accent ? " accent" : ""}`,
        dataset: { key, value },
        attrs: { title: help },
      },
      [
        h("span", { class: "summary-label", text: label }),
        h("strong", { class: "summary-value", text: value }),
      ],
    );

  return h("div", { class: "summary-bar" }, [
    item(
      `${t("summary.effortP80")} (${t("unit.days")})`,
      effort,
      "effortP80",
      t("summary.effortP80Help"),
      true,
    ),
    item(t("summary.finishP80"), finish, "finishP80", t("summary.finishP80Help"), true),
    item(t("summary.progress"), progress, "progress", t("summary.progressHint")),
    item(
      `${t("summary.remaining")} (${t("unit.days")})`,
      remaining,
      "remaining",
      t("summary.remainingHint"),
    ),
  ]);
}

const fileInput = h("input", {
  attrs: { type: "file", accept: ".json,.mhc.json,.mhcall.json,application/json" },
  style: { display: "none" },
  on: {
    change: (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      actions.run(async () => {
        // 1 件ぶんかまとめたものかは、ファイルの中身で決まる。
        const loaded = await readAnyFile(file);
        if (loaded === null) {
          setStatus(t("file.badFile"), "error");
          return;
        }
        // 読み込んだ内容は、いまのプロジェクトを潰さずに新しい 1 件として足す。
        let last: Awaited<ReturnType<ApiClient["createProject"]>> | null = null;
        for (const item of loaded) {
          last = await state.client.createProject(newId(), item.name, item.document);
          // 期限はファイルに一緒に書いてある。内容の外にあるので別に入れる。
          if (item.dueDate) {
            await state.client.updateProject(last.id, { dueDate: item.dueDate });
          }
        }
        if (last !== null) await openProject(await state.client.getProject(last.id));
        setStatus(
          loaded.length === 1
            ? t("file.imported", { name: file.name })
            : t("file.importedMany", { name: file.name, count: loaded.length }),
        );
      });
    },
  },
});

/**
 * CSV をどこへ読み込むか。
 *
 * 1 つの口で「いま開いているものを置き換える」だけだったころは、開き直した
 * ときに別のプロジェクトが開いていたのに気づかず、見本や別案件のタスクを
 * 確認なしで上書きしていた。置き換えと新規を分け、置き換えは確かめる。
 */
let csvMode: "replace" | "new" = "replace";

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
        await importCsv(file, csvMode);
      });
    },
  },
});

async function importCsv(file: File, mode: "replace" | "new"): Promise<void> {
  const text = await readCsvText(file);
  const base = mode === "new" ? emptyDocument() : state.document;
  const members = [...base.calendar.members];
  const imported = readCsv(text, {
    members,
    hoursPerDay: base.calendar.hoursPerPersonDay,
  });
  if (imported.tasks.length === 0) {
    setStatus(t("file.badFile"), "error");
    return;
  }
  if (mode === "replace" && state.document.tasks.length > 0) {
    const ok = confirm(
      t("file.confirmReplace", {
        name: state.open?.name ?? "",
        count: state.document.tasks.length,
        next: imported.tasks.length,
      }),
    );
    if (!ok) return;
  }
  // 担当者の列にあって人員にいない名前は、人員として足す。1 件ずつ
  // 担当を選び直させると、16 件で 36 回の操作になっていた。
  const added = imported.unknownAssignees.map((name) => createMember(name));
  const tasks =
    added.length === 0
      ? imported.tasks
      : readCsv(text, {
          members: [...members, ...added],
          hoursPerDay: base.calendar.hoursPerPersonDay,
        }).tasks;

  const notes = [t("file.importedCsv", { name: file.name, count: tasks.length })];
  if (added.length > 0) {
    notes.push(t("file.csvNewMembers", { names: added.map((m) => m.name).join(", ") }));
  }
  if (imported.filledEstimates > 0) {
    notes.push(t("file.csvFilled", { count: imported.filledEstimates }));
  }
  if (imported.unreadable > 0) notes.push(t("file.csvUnreadable", { count: imported.unreadable }));
  if (imported.parentEstimates > 0) {
    notes.push(t("file.csvParentEstimates", { count: imported.parentEstimates }));
  }
  // UTF-8 でも Shift_JIS でもない (あるいは途中が壊れた) ときに出る置換文字。
  const garbled = text.includes("\uFFFD");
  if (garbled) notes.push(t("file.csvGarbled"));
  const tone = imported.unreadable > 0 || garbled ? "error" : "info";

  if (mode === "new") {
    const document = emptyDocument();
    document.tasks = tasks;
    document.calendar.members = added;
    const name = file.name.replace(/\.csv$/i, "") || "project";
    const created = await state.client.createProject(newId(), name, document);
    await openProject(created);
  } else {
    applyChange((document) => {
      document.tasks = tasks;
      document.calendar.members.push(...added);
    });
    refreshAll();
  }
  setStatus(notes.join(" "), tone);
}

function fileMenu(): HTMLElement {
  const menu = h("details", { class: "menu" }, [
    h("summary", { text: t("file.menu") }),
    h("div", { class: "menu-panel" }, [
      button(t("file.save"), () => {
        downloadProject(state.open?.name ?? "project", state.document, openDueDate());
        setStatus(t("file.saved"));
        render();
      }),
      // まとめて渡せるようにする。1 件ずつ書き出させるのは、渡す側にも
      // 受け取る側にも手間でしかない。
      button(
        t("file.saveAll", { count: state.projects.length }),
        () => {
          actions.run(async () => {
            const projects = [];
            for (const summary of state.projects) {
              const project = await state.client.getProject(summary.id);
              projects.push({
                name: project.name,
                dueDate: summary.dueDate,
                document: project.document,
              });
            }
            if (projects.length === 0) {
              setStatus(t("projects.none"), "error");
              return;
            }
            downloadBundle(projects);
            setStatus(t("file.savedAll", { count: projects.length }));
          });
        },
        { attrs: { disabled: state.projects.length === 0 } },
      ),
      button(t("file.open"), () => {
        fileInput.click();
      }),
      h("hr"),
      button(t("file.exportCsv"), () => {
        downloadCsv(
          state.open?.name ?? "project",
          projectToCsv(state.rows, state.document.calendar.members),
        );
      }),
      button(t("file.importCsvNew"), () => {
        csvMode = "new";
        csvInput.click();
      }),
      button(
        t("file.importCsv"),
        () => {
          csvMode = "replace";
          csvInput.click();
        },
        { attrs: { disabled: !canWrite(state) } },
      ),
    ]),
  ]);
  // 開閉は状態に持つ。描き直しで作り直されると、開いたばかりのメニューが
  // 閉じる (最初の計算が終わったときに、押した直後のメニューが閉じていた)。
  menu.open = state.openPanels["file-menu"] === true;
  menu.addEventListener("toggle", () => {
    state.openPanels["file-menu"] = menu.open;
  });
  menu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).tagName === "BUTTON") {
      menu.open = false;
      state.openPanels["file-menu"] = false;
    }
  });
  return menu;
}

/** 開いているプロジェクトの期限。 */
function openDueDate(): string | null {
  return state.projects.find((project) => project.id === state.open?.id)?.dueDate ?? null;
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
    summaryBar(),
  ]);
}

const TAB_PANEL_ID = "tab-panel";

/** タブ id から、見出しとして参照するボタンの id。 */
function tabButtonId(tab: TabId): string {
  return `tab-${tab}`;
}

function selectTab(tab: TabId): void {
  state.activeTab = tab;
  render();
  // 移った先のタブに焦点を残す。矢印で送っているときに本文へ落ちると、
  // そのまま矢印で戻ることができなくなる。
  root.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
}

function tabBar(): HTMLElement {
  const rail = h(
    "div",
    { class: "tabs", attrs: { role: "tablist" } },
    TABS.map((tab) => {
      const selected = state.activeTab === tab;
      return button(
        t(`tab.${tab}`),
        () => {
          selectTab(tab);
        },
        {
          id: tabButtonId(tab),
          dataset: { tab, focus: `tab:${tab}` },
          attrs: {
            role: "tab",
            "aria-selected": selected,
            "aria-controls": TAB_PANEL_ID,
            // 選択中の 1 つだけが tab キーの止まり先。あとは矢印で移る。
            tabindex: selected ? 0 : -1,
          },
        },
      );
    }),
  );

  rail.addEventListener("keydown", (event) => {
    const at = TABS.indexOf(state.activeTab);
    const next =
      event.key === "ArrowRight"
        ? TABS[(at + 1) % TABS.length]
        : event.key === "ArrowLeft"
          ? TABS[(at - 1 + TABS.length) % TABS.length]
          : event.key === "Home"
            ? TABS[0]
            : event.key === "End"
              ? TABS[TABS.length - 1]
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(next);
  });
  return rail;
}

/** このリポジトリの置き場所。不具合の報告先もここから組み立てる。 */
const REPOSITORY = "https://github.com/yutaro-sakamoto/man-hour-calculator";

/**
 * 画面の下の案内。
 *
 * **素の `<a>` だけを置く。** 押すまで通信は起きないので、外と繋がらない
 * という約束は保たれる。外のアイコンや画像は置けない (E2E が
 * 「`file://` 以外へのリクエストが 1 件でもあれば落ちる」ことを見張っている)。
 */
function footer(): HTMLElement {
  const link = (label: string, href: string, kind: string): HTMLElement =>
    h("a", {
      text: label,
      attrs: { href, target: "_blank", rel: "noopener noreferrer" },
      dataset: { feedback: kind },
    });

  return h("footer", { class: "app-footer" }, [
    h("span", { text: t("feedback.lead") }),
    link(t("feedback.bug"), `${REPOSITORY}/issues/new?labels=bug`, "bug"),
    h("span", { class: "sep", text: "·" }),
    link(t("feedback.idea"), `${REPOSITORY}/issues/new`, "idea"),
    h("span", { class: "sep", text: "·" }),
    link(t("feedback.repo"), REPOSITORY, "repo"),
  ]);
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
    case "forecast":
      return renderForecastTab(state, actions, widgets);
  }
}

/**
 * 期限は一覧 (プロジェクトの情報) の側にある。描く前に、計算結果に載って
 * いる期限と今の期限を照らし、違えば載せ直す (計算はし直さなくてよい)。
 *
 * 期限を変える道はいくつもある (一覧の欄・読み込み・複製)。どこか 1 か所で
 * 載せ直す形だと、通らない道が残る。実際、一覧の欄で 12/25 を 1/8 に変えても
 * 「期限までに終わる確率」が古い期限のまま出ていた。
 */
function syncDueDate(): void {
  const schedule = state.schedule;
  if (schedule === null) return;
  const due = dayFromIso(openDueDate());
  const wanted = due === null ? null : due - schedule.startDay;
  const inRange = wanted !== null && wanted >= 0 && wanted < schedule.days ? wanted : null;
  if (schedule.dueIndex === inRange) return;
  state.schedule = withDueDate(schedule, due);
  scheduleChart.setData(state.schedule);
}

function render(): void {
  // 言語は毎回書き戻す。切り替えたときに <html lang> が取り残されると、
  // 読み上げソフトや辞書機能が古い言語のまま扱ってしまう。
  document.documentElement.lang = lang();
  syncDueDate();
  const focus = captureFocus();
  clear(root);

  const editable = canWrite(state) || state.activeTab === "projects";
  const panel = h(
    "div",
    {
      class: "tab-panel",
      id: TAB_PANEL_ID,
      attrs: { role: "tabpanel", "aria-labelledby": tabButtonId(state.activeTab) },
    },
    [
      // 閲覧権限しか無いときは、まとめて操作を止める。個々の入力に
      // disabled を配るより取りこぼしが無い。
      editable
        ? tabContent()
        : h("fieldset", { class: "readonly", attrs: { disabled: true } }, [tabContent()]),
    ],
  );

  append(root, [
    header(),
    // 状態表示はタブより上。全体の状態であってタブの中身ではないし、
    // レールとパネルの間に挟まると、繋がって見えるのを邪魔する。
    // 道具の語彙を 1 行だけ置く。「P80」は画面のいちばん目立つところに
    // 出ているのに、意味は「見通し」タブの奥にしか書かれていなかった。
    h("p", { class: "hint summary-legend", text: t("summary.legend") }),
    h("p", {
      class: "status",
      id: "status",
      text: state.status.text,
      dataset: { tone: state.status.tone, run: String(runCount) },
    }),
    tabBar(),
    // 自動保存が効いていないことは、黙っていてはいけない。
    // 気づかないまま書き続けて、再読み込みで全部消えるのがいちばん困る。
    state.client.remote || !LocalApiClient.storageBroken()
      ? null
      : h("p", { id: "storage-warning", class: "hint warn", text: t("file.autosaveOff") }),
    editable
      ? panel
      : h("div", {}, [
          h("p", { id: "readonly-banner", class: "hint warn", text: t("role.readOnly") }),
          panel,
        ]),
    footer(),
  ]);
  // コメントとタスクの詳細はどのタブからでも開くので、タブの中身の外に置く。
  // (閲覧権限しか無いときの囲いも外れるため、詳細は自前で無効にする。)
  const detail = renderTaskDetailModal(state, actions);
  if (detail) root.append(detail);
  const comments = renderCommentsModal(state, actions);
  if (comments) root.append(comments);

  restoreFocus(focus);

  // 2 つの canvas が同じタブに並ぶので、まとめて描き直す。片方だけだと
  // もう片方は大きさ 0 のまま白く残る。
  if (state.activeTab === "forecast") {
    scheduleChart.redraw();
    distributionChart.redraw();
  }
}

function refreshAll(): void {
  recompute();
  runCount += 1;
  rememberForecast();
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

/**
 * 今日の見通しを控えに残す。週報で「先週から何が変わったか」を答えるため。
 *
 * 書ける人のときだけ。閲覧者の手元で控えが増えても保存されず、
 * 次に開いたときには消えている。
 */
function rememberForecast(): void {
  const status = currentStatus();
  if (status === undefined || !canWrite(state)) return;
  const remaining = state.schedule?.overallProgress.remaining ?? 0;
  state.document.history = recordSnapshot(
    state.document.history,
    snapshotOf(
      state.document.calendar.today,
      status,
      remaining,
      state.rows.filter((row) => row.leafIndex !== null).map((row) => row.task),
      forecastChances(),
    ),
  );
}

/** 期限までに終わる確率と、予算内に収まる確率。推移に残すため。 */
function forecastChances(): { due: number | null; budget: number | null } {
  const schedule = state.schedule;
  const result = state.result;
  const dueIndex = schedule?.dueIndex ?? null;
  const budget = state.document.budget;
  return {
    due: schedule === null || dueIndex === null ? null : (schedule.overall[dueIndex] ?? null),
    budget: result === null || budget === null ? null : cumulativeAt(result, budget),
  };
}

/** 内容を変えて、再計算を予約する。描き直しは呼び出し側が決める。 */
function applyChange(change: (document: ProjectDocument) => void): void {
  change(state.document);
  // 利用者が内容を変えた印。開いて計算し直しただけでは動かさない
  // (一覧の「最終入力」で、最後に実績を入れた日が分かるように)。
  state.document.editedAt = new Date().toISOString();
  window.clearTimeout(computeTimer);
  computeTimer = window.setTimeout(refreshAll, COMPUTE_DELAY_MS);
  state.rows = buildRows(state.document.tasks);
}

const actions: AppActions = {
  mutate(change) {
    applyChange(change);
    // 構造の変化はすぐ画面に出す。数字の更新だけ少し遅れて追いつく。
    render();
  },
  edit(change) {
    // **描き直さない。** 入力欄を作り直すとキャレットが失われる種類
    // (`type="number"`) があり、1 打鍵ごとに作り直すと `125` が `521` になる。
    // 打ち終わって 220ms すれば `refreshAll` が描き直す。
    applyChange(change);
  },
  patch(change) {
    change(state);
    render();
  },
  openProject(id) {
    return reopen(id);
  },
  recomputeStatuses(ids) {
    return recomputeStatuses(ids);
  },
  connect(connection) {
    return connect(connection);
  },
  run(action) {
    // 何かを呼ぶ前に、溜まっている編集を先に送る。複製や切り替えが
    // 直前の入力を取りこぼさないようにするため。
    void flushSave()
      .then(action)
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
  state.userGroups = await state.client.listUserGroups();
  state.projectGroups = await state.client.listProjectGroups();
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
  saveLastProject(loadConnection(), project.id);
  // コメントはまとめて持つ。タスク一覧に件数を出すため、1 件ずつ
  // 数えに行くと行の数だけ問い合わせることになる。
  state.comments = await state.client.listComments(project.id);
  state.commentScope = null;
  // 基準日は開いた日に合わせる。保存された日付のまま進捗を測らない。
  if (state.document.calendar.today !== today) state.document.calendar.today = today;
  await reloadProjects();
  refreshAll();
}

/** 起動や接続のときに開くもの。前回開いていたものがあればそれ。 */
function initialProject(): (typeof state.projects)[number] | undefined {
  const last = loadLastProject(loadConnection());
  return state.projects.find((project) => project.id === last) ?? state.projects[0];
}

async function reopen(id: string): Promise<void> {
  await openProject(await state.client.getProject(id));
}

/**
 * 控えが古いプロジェクトを計算し直して保存する。
 *
 * 中身を読み込んで**手元の WASM で**回すので、サーバは何も計算しない。
 * 計算できないもの (見積もりが不正など) は数字を伏せたまま残す。
 * 勝手に何かを埋めるより、「再計算が必要」と出しつづけるほうが正直。
 */
async function recomputeStatuses(ids: readonly string[]): Promise<number> {
  let updated = 0;
  for (const id of ids) {
    const project = await state.client.getProject(id);
    let status: ProjectStatus | undefined;
    try {
      const computed = runEngine(project.document);
      status = buildStatus(
        project.document,
        computed.result,
        computed.schedule,
        new Date().toISOString(),
      );
    } catch {
      continue;
    }
    await state.client.saveDocument(id, project.document, status);
    updated += 1;
  }
  state.projects = await state.client.listProjects();
  setStatus(t("projects.recomputed", { count: updated }));
  return updated;
}

/* ===== 接続先 ============================================== */

function makeClient(connection: Connection | null): ApiClient {
  if (connection === null) return new LocalApiClient(LOCAL_OWNER);
  return new HttpApiClient(
    connection.token === ""
      ? { baseUrl: connection.baseUrl }
      : { baseUrl: connection.baseUrl, token: connection.token },
  );
}

/**
 * 接続先を切り替える。
 *
 * 繋がらなければ元に戻す。「繋いだつもりで実は何も保存されていない」
 * という状態を作らないため。
 */
async function connect(connection: Connection | null): Promise<void> {
  const previous = state.client;
  state.client = makeClient(connection);
  try {
    state.me = await state.client.me();
    await reloadProjects();
  } catch (error) {
    state.client = previous;
    throw error;
  }
  saveConnection(connection);
  state.open = null;
  state.document = emptyDocument();
  const first = initialProject();
  if (first) await openProject(await state.client.getProject(first.id));
  else refreshAll();
  setStatus(
    connection === null
      ? t("conn.disconnected")
      : t("conn.connected", { target: connection.baseUrl }),
  );
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
            // データは英語、画面は選んだ言語。持ち主の名前も中身なので英語。
            name: "You",
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
    const created = await client.createProject(newId(), sampleName(), sampleDocument());
    // 見本にも期限を入れておく。そうしないと一覧の「状態」が
    // 「進行中」しか出ず、何を見る欄なのか伝わらない。
    await client.updateProject(created.id, { dueDate: addDays(today, 60) });
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

  // 接続先が覚えてあればサーバに繋ぐ。繋がらなければローカルで続ける
  // (手元の分まで見られなくなるほうが困る)。
  const saved = loadConnection();
  if (saved !== null) {
    state.client = makeClient(saved);
    try {
      state.me = await state.client.me();
      await reloadProjects();
      const first = initialProject();
      if (first) await openProject(await state.client.getProject(first.id));
      else refreshAll();
      return;
    } catch (error) {
      state.client = new LocalApiClient(LOCAL_OWNER);
      reportError(error);
    }
  }

  try {
    // 読めない内容は**空で上書きしない**。書き込みを止めたうえで、
    // 画面は使える状態にして注意書きを出す (`storageBroken`)。
    LocalApiClient.restore();
    await seed();
    state.me = await state.client.me();
    await reloadProjects();
    const first = initialProject();
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
