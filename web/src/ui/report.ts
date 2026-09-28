/**
 * 見通しタブの先頭の「要点」。週報に書くことを 1 枚に集める。
 *
 * シミュレーションで、報告を受ける側 (上長・顧客) が毎週聞いてきたのは
 * 「いつ終わるか・期限に間に合うか・予算に収まるか・先週から何が変わったか・
 * 何が詰まっているか」だった。それぞれが別のタブや折りたたみの奥にあり、
 * PM は数字を手で書き写して引き算していた。ここに並べ、そのまま貼れる
 * テキストでも渡す。
 */

import { P50_INDEX, P80_INDEX } from "../abi.ts";
import type { AppActions, AppState } from "../app.ts";
import { canWrite } from "../app.ts";
import { dayFromIso, formatDayShort, formatNumber, formatPercent } from "../format.ts";
import { lang, t } from "../i18n.ts";
import { CALIBRATION_MIN_TASKS, calibrationOf } from "../model/calibration.ts";
import { deltaOf, previousSnapshot, snapshotOf } from "../model/history.ts";
import { buildStatus } from "../model/status.ts";
import { criticalChain, type ScheduleModel } from "../model/schedule.ts";
import { dependencyPairs } from "../model/tree.ts";
import type { ComputeResult } from "../wasm.ts";
import { button, card, checkbox, foldout, h, numberInput } from "./dom.ts";
import { cumulativeAt } from "./results.ts";

/** 1 週間。止まっているタスクを見るときの幅。 */
const STALL_DAYS = 7;

interface Line {
  key: string;
  label: string;
  value: string;
  /** 前回からの差。無ければ出さない。 */
  delta?: { text: string; worse: boolean } | undefined;
}

function signed(value: number, digits: number): { sign: string; text: string } {
  const l = lang();
  return {
    sign: value > 0 ? "+" : value < 0 ? "−" : "±",
    text: formatNumber(Math.abs(value), l, digits),
  };
}

/** 期限の確率。期限が無い・期間の外なら、その旨の文。 */
function dueLine(schedule: ScheduleModel, due: string | null): Line {
  if (due === null)
    return { key: "due", label: t("report.due", { date: "—" }), value: t("report.noDue") };
  const label = t("report.due", { date: due });
  if (schedule.dueIndex === null) return { key: "due", label, value: t("report.dueOutside") };
  const probability = schedule.overall[schedule.dueIndex] ?? 0;
  return { key: "due", label, value: formatPercent(probability, lang(), 0) };
}

/** 完了日を決めている流れ (タスクの名前を前から後ろへ)。2 件以上のときだけ。 */
function chainLine(state: AppState, result: ComputeResult, schedule: ScheduleModel): string | null {
  const chain = criticalChain(result, schedule, state.rows, dependencyPairs(state.rows));
  if (chain.length < 2) return null;
  const names = new Map(
    state.rows.filter((row) => row.leafIndex !== null).map((row) => [row.leafIndex, row.task.name]),
  );
  const mark = schedule.overallMarks.p80;
  return t("report.chainValue", {
    chain: chain.map((leaf) => names.get(leaf) ?? "?").join(" → "),
    date:
      mark === null ? t("sched.notFinishing") : formatDayShort(schedule.startDay + mark, lang()),
  });
}

/** 1 週間以上前の控えから進捗が動いていない、進行中のタスク。 */
function stalledTasks(state: AppState): string[] {
  const old = previousSnapshot(state.document.history, state.document.calendar.today, STALL_DAYS);
  if (old === null) return [];
  return state.rows
    .filter((row) => row.leafIndex !== null)
    .map((row) => row.task)
    .filter(
      (task) =>
        task.endDate === null &&
        task.progress > 0 &&
        task.progress < 100 &&
        old.taskProgress[task.id] === task.progress,
    )
    .map((task) => t("report.stalledItem", { name: task.name, progress: task.progress }));
}

/**
 * 前回より進捗が下がったタスク。手戻りや申告の見直しの合図なので、黙って
 * 数字を差し替えない (シミュレーションで 30% → 15% が素通りしていた)。
 */
function droppedTasks(state: AppState): string[] {
  const previous = previousSnapshot(state.document.history, state.document.calendar.today);
  if (previous === null) return [];
  return state.rows
    .filter((row) => row.leafIndex !== null)
    .map((row) => row.task)
    .filter((task) => (previous.taskProgress[task.id] ?? 0) > task.progress)
    .map((task) =>
      t("report.droppedItem", {
        name: task.name,
        before: previous.taskProgress[task.id] ?? 0,
        after: task.progress,
      }),
    );
}

/** ばらつきの元になっているタスク (上位 3)。 */
function topRisks(state: AppState, result: ComputeResult): string[] {
  const l = lang();
  return state.rows
    .filter((row) => row.leafIndex !== null)
    .map((row) => ({ name: row.task.name, share: result.sensitivity[row.leafIndex ?? 0] ?? 0 }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 3)
    .filter((item) => item.share > 0)
    .map((item) => `${item.name} (${formatPercent(item.share, l, 0)})`);
}

type Delta = ReturnType<typeof deltaOf> | null;

function finishDelta(delta: Delta): Line["delta"] {
  if (delta?.finishP80Days == null) return undefined;
  const s = signed(delta.finishP80Days, 0);
  return {
    text: t("report.deltaDays", { sign: s.sign, days: s.text }),
    worse: delta.finishP80Days > 0,
  };
}

function effortDelta(delta: Delta): Line["delta"] {
  if (delta === null) return undefined;
  const s = signed(delta.effortP80, 1);
  return {
    text: t("report.deltaEffort", { sign: s.sign, value: s.text }),
    worse: delta.effortP80 > 0.05,
  };
}

function progressDelta(delta: Delta): Line["delta"] {
  if (delta === null) return undefined;
  const s = signed(delta.progress * 100, 0);
  const tasks =
    delta.taskCount === 0
      ? ""
      : ` · ${t("report.deltaTasks", {
          sign: delta.taskCount > 0 ? "+" : "−",
          count: Math.abs(delta.taskCount),
        })}`;
  return {
    text: `${t("report.deltaPoints", { sign: s.sign, value: s.text })}${tasks}`,
    worse: false,
  };
}

function buildLines(
  state: AppState,
  result: ComputeResult,
  schedule: ScheduleModel,
  due: string | null,
): Line[] {
  const l = lang();
  const day = (mark: number | null): string =>
    mark === null ? t("sched.notFinishing") : formatDayShort(schedule.startDay + mark, l);
  const today = state.document.calendar.today;
  const previous = previousSnapshot(state.document.history, today);
  const current = snapshotOf(
    today,
    buildStatus(state.document, result, schedule, ""),
    schedule.overallProgress.remaining,
  );
  const delta = previous === null ? null : deltaOf(previous, current);

  const lines: Line[] = [
    {
      key: "finish",
      label: `${t("summary.finishP50")} / ${t("summary.finishP80")} / P90`,
      value: `${day(schedule.overallMarks.p50)} / ${day(schedule.overallMarks.p80)} / ${day(schedule.overallMarks.p90)}`,
      delta: finishDelta(delta),
    },
    dueLine(schedule, due),
    {
      key: "effort",
      label: `${t("summary.effortP80")} (${t("unit.days")})`,
      value: formatNumber(result.percentiles[P80_INDEX] ?? 0, l),
      delta: effortDelta(delta),
    },
    {
      key: "progress",
      label: t("summary.progress"),
      value: `${formatPercent(schedule.overallProgress.ratio, l, 0)} (${t("progress.spent")} ${formatNumber(schedule.overallProgress.spent, l, 1)} / ${t("progress.remaining")} ${formatNumber(schedule.overallProgress.remaining, l, 1)} ${t("unit.days")})`,
      delta: progressDelta(delta),
    },
  ];

  const budget = state.document.budget;
  if (budget !== null) {
    const p80 = result.percentiles[P80_INDEX] ?? 0;
    lines.push(
      {
        key: "budget",
        label: `${t("report.withinBudget")} (${formatNumber(budget, l)} ${t("unit.days")})`,
        value: formatPercent(cumulativeAt(result, budget), l, 0),
      },
      {
        key: "landing",
        label: t("report.landing"),
        value:
          t("report.landingValue", {
            p50: formatNumber(result.percentiles[P50_INDEX] ?? 0, l),
            p80: formatNumber(p80, l),
          }) +
          (p80 > budget ? ` — ${t("report.over", { days: formatNumber(p80 - budget, l) })}` : ""),
      },
    );
  }

  const chain = chainLine(state, result, schedule);
  if (chain !== null) lines.push({ key: "chain", label: t("report.chain"), value: chain });
  const stalled = stalledTasks(state);
  if (stalled.length > 0) {
    lines.push({ key: "stalled", label: t("report.stalled"), value: stalled.join(", ") });
  }
  const dropped = droppedTasks(state);
  if (dropped.length > 0) {
    lines.push({ key: "dropped", label: t("report.dropped"), value: dropped.join(", ") });
  }
  const risks = topRisks(state, result);
  if (risks.length > 0)
    lines.push({ key: "risks", label: t("report.risks"), value: risks.join(", ") });
  return lines;
}

/**
 * 見積もりの偏り。終わったタスクが見積もりの何倍かかったかと、それを残りに
 * 掛けるかどうか。掛けるかどうかは PM が決める (既定は掛けない)。
 */
function biasBlock(state: AppState, actions: AppActions): HTMLElement {
  const calibration = calibrationOf(
    state.document.tasks,
    state.document.calendar.hoursPerPersonDay,
  );
  if (calibration === null) {
    return h("p", { class: "hint", text: t("report.biasNeed", { count: CALIBRATION_MIN_TASKS }) });
  }
  return h("div", { class: "report-bias", dataset: { key: "bias" } }, [
    h("p", {
      text: t("report.biasValue", {
        count: calibration.count,
        factor: formatNumber(calibration.factor, lang(), 2),
      }),
    }),
    h("label", { class: "toggle" }, [
      checkbox(
        state.document.calibrate,
        (checked) => {
          actions.mutate((document) => {
            document.calibrate = checked;
          });
        },
        {
          dataset: { focus: "report:calibrate" },
          attrs: { disabled: !canWrite(state), "aria-label": t("report.biasApply") },
        },
      ),
      h("span", { text: t("report.biasApply") }),
    ]),
  ]);
}

/** 週報に貼るためのテキスト。 */
function asText(state: AppState, lines: readonly Line[], since: string | null): string {
  const head = `${state.open?.name ?? ""} — ${t("report.asOf", { date: state.document.calendar.today })}`;
  const body = lines.map(
    (line) => `- ${line.label}: ${line.value}${line.delta ? ` (${line.delta.text})` : ""}`,
  );
  return [head, ...(since === null ? [] : [`(${since})`]), ...body].join("\n");
}

function historyTable(state: AppState): HTMLElement | null {
  const history = state.document.history;
  if (history.length < 2) return null;
  const l = lang();
  const day = (value: number | null): string => (value === null ? "—" : formatDayShort(value, l));
  const chance = (value: number | null): string =>
    value === null ? "—" : formatPercent(value, l, 0);
  const key = "panel-history";
  return foldout(
    {
      id: key,
      title: t("report.history"),
      open: state.openPanels[key] ?? false,
      onToggle: (open) => {
        state.openPanels[key] = open;
      },
    },
    [
      h("div", { class: "table-scroll" }, [
        h("table", { class: "member-summary history-table" }, [
          h("thead", {}, [
            h("tr", {}, [
              h("th", { text: t("report.historyDate") }),
              h("th", { text: t("summary.finishP80") }),
              h("th", { class: "num", text: t("summary.effortP80") }),
              h("th", { class: "num", text: t("report.progress") }),
              h("th", { class: "num", text: t("progress.spent") }),
              h("th", { class: "num", text: t("report.dueChance") }),
              h("th", { class: "num", text: t("report.budgetChance") }),
            ]),
          ]),
          h(
            "tbody",
            {},
            [...history]
              .reverse()
              .slice(0, 30)
              .map((item) =>
                h("tr", {}, [
                  h("td", { text: item.date }),
                  h("td", { text: day(item.finishP80) }),
                  h("td", { class: "num", text: formatNumber(item.effortP80, l) }),
                  h("td", { class: "num", text: formatPercent(item.progress, l, 0) }),
                  h("td", { class: "num", text: formatNumber(item.spent, l) }),
                  h("td", { class: "num", text: chance(item.dueProbability) }),
                  h("td", { class: "num", text: chance(item.budgetProbability) }),
                ]),
              ),
          ),
        ]),
      ]),
    ],
  );
}

export function renderReportCard(state: AppState, actions: AppActions): HTMLElement | null {
  const result = state.result;
  const schedule = state.schedule;
  if (result === null || schedule === null) return null;
  const due = state.projects.find((project) => project.id === state.open?.id)?.dueDate ?? null;
  const lines = buildLines(state, result, schedule, due);
  const previous = previousSnapshot(state.document.history, state.document.calendar.today);
  const since =
    previous === null
      ? null
      : t("report.since", { date: formatDayShort(dayFromIso(previous.date) ?? 0, lang()) });
  const text = asText(state, lines, since);

  const copy = (): void => {
    const done = (ok: boolean): void => {
      actions.patch((s) => {
        s.status = ok
          ? { text: t("report.copied"), tone: "info" }
          : { text: t("report.copyFailed"), tone: "error" };
      });
    };
    // file:// やプライベートモードでは書けないことがある。黙って失敗しない。
    void navigator.clipboard.writeText(text).then(
      () => {
        done(true);
      },
      () => {
        done(false);
      },
    );
  };

  return card(
    t("report.heading"),
    [
      h("p", { class: "muted", text: t("report.asOf", { date: state.document.calendar.today }) }),
      h(
        "dl",
        { class: "report-lines" },
        lines.flatMap((line) => [
          h("dt", { text: line.label }),
          h("dd", { dataset: { key: line.key } }, [
            h("strong", { text: line.value }),
            line.delta === undefined
              ? null
              : h("span", {
                  class: `chip${line.delta.worse ? " warn" : " muted"}`,
                  text: `${since ?? ""} ${line.delta.text}`.trim(),
                }),
          ]),
        ]),
      ),
      previous === null ? h("p", { class: "hint", text: t("report.noPrevious") }) : null,
      biasBlock(state, actions),
      h("div", { class: "row-actions" }, [
        h("label", { class: "inline-field" }, [
          h("span", { text: t("report.budget") }),
          numberInput(
            state.document.budget ?? "",
            (value) => {
              const number = Number(value);
              actions.edit((document) => {
                document.budget = value.trim() !== "" && number > 0 ? number : null;
              });
            },
            {
              dataset: { focus: "report:budget" },
              attrs: {
                min: 0,
                step: 1,
                disabled: !canWrite(state),
                "aria-label": t("report.budget"),
              },
            },
          ),
        ]),
        button(t("report.copy"), copy),
      ]),
      h("textarea", {
        class: "report-text",
        attrs: {
          readonly: true,
          rows: Math.min(12, lines.length + 2),
          "aria-label": t("report.copy"),
        },
        text,
      }),
      historyTable(state),
      h("p", { class: "hint", text: t("report.dependencyNote") }),
    ],
    "card-report",
  );
}
