/** 見通しタブのうち、完了日まわり。帯グラフ・行ごとの表・人員ごとのまとめ。 */

import type { AppActions, AppState, AppWidgets } from "../app.ts";
import {
  dayFromIso,
  formatDayLong,
  formatDayShort,
  formatNumber,
  formatPercent,
  isoFromDay,
} from "../format.ts";
import { lang, t } from "../i18n.ts";
import { progressOfSubtree, progressOverall, type Progress } from "../model/progress.ts";
import type { ScheduleModel, ScheduleRow } from "../model/schedule.ts";
import type { TreeRow } from "../model/tree.ts";
import { button, card, dateInput, foldout, h, subfold } from "./dom.ts";

function legend(): HTMLElement {
  return h("div", { class: "legend" }, [
    h("span", { class: "legend-item" }, [h("i", { class: "swatch band" }), t("sched.legendBand")]),
    h("span", { class: "legend-item" }, [h("i", { class: "swatch core" }), t("sched.legendCore")]),
    h("span", { class: "legend-item" }, [
      h("i", { class: "swatch marker" }),
      t("sched.legendMedian"),
    ]),
  ]);
}

/** ④ 人員ごとに「担当ぶんを終える時期」をまとめる。2 人以上のときだけ。 */
export function renderMemberCard(state: AppState): HTMLElement | null {
  const model = state.schedule;
  if (model === null) return null;
  const working = model.members.filter((member) => member.taskCount > 0);
  if (working.length <= 1) return null;
  const l = lang();

  return foldout(
    {
      id: "panel-by-member",
      title: t("sched.byMember"),
      open: state.openPanels["panel-by-member"] ?? false,
      onToggle: (open) => {
        state.openPanels["panel-by-member"] = open;
      },
    },
    [
      h("p", { class: "hint", text: t("sched.memberNote") }),
      h("table", { class: "member-summary" }, [
        h("thead", {}, [
          h("tr", {}, [
            h("th", { text: t("sched.memberCol") }),
            h("th", { class: "num", text: t("members.tasks", { count: "" }).trim() }),
            h("th", { class: "num", text: `${t("col.forecast")} (${t("unit.days")})` }),
            h("th", { text: t("summary.finishP50") }),
            h("th", { text: t("summary.finishP80") }),
          ]),
        ]),
        h(
          "tbody",
          {},
          working.map((member) =>
            h("tr", {}, [
              h("td", { text: member.label }),
              h("td", { class: "num", text: String(member.taskCount) }),
              h("td", { class: "num", text: formatNumber(member.gridHi, l) }),
              ...([member.marks.p50, member.marks.p80] as const).map((mark) =>
                h("td", {
                  text:
                    mark === null
                      ? t("sched.notFinishing")
                      : formatDayShort(model.startDay + mark, l),
                  class: mark === null ? "warn" : "",
                }),
              ),
            ]),
          ),
        ),
      ]),
    ],
  );
}

/** 表の 1 行ぶんの数字。帯グラフの行と 1 対 1 で並べる。 */
interface ForecastRow {
  id: string | null;
  label: string;
  depth: number;
  strong: boolean;
  /** 押して詳細を開けるか。全体行だけは開かない。 */
  openable: boolean;
  progress: Progress | null;
  marks: ScheduleRow["marks"] | null;
  probability: number;
}

function forecastRows(state: AppState, model: ScheduleModel, at: number | null): ForecastRow[] {
  const result = state.result;
  // 帯グラフと同じ順・同じ行数で並べる。`ScheduleRow` は部分木を知らないので、
  // 進捗と残りは `state.rows` に id で突き合わせて引く。
  const byId = new Map<string, number>();
  state.rows.forEach((row: TreeRow, index) => byId.set(row.task.id, index));

  const rows: ForecastRow[] = model.rows.map((row) => {
    const index = byId.get(row.id);
    return {
      id: row.id,
      label: row.label,
      depth: row.depth,
      strong: row.isParent,
      openable: true,
      progress:
        result === null || index === undefined
          ? null
          : progressOfSubtree(result, state.rows, index),
      marks: row.marks,
      probability: at === null ? 0 : (row.probabilities[at] ?? 0),
    };
  });

  rows.push({
    id: null,
    label: t("sched.overall"),
    depth: 0,
    strong: true,
    openable: false,
    progress: result === null ? null : progressOverall(result),
    marks: model.overallMarks,
    probability: at === null ? 0 : (model.overall[at] ?? 0),
  });
  return rows;
}

function progressCell(progress: Progress | null): HTMLElement {
  if (progress === null) return h("td", { class: "num", text: "—" });
  return h("td", { class: "num", dataset: { progress: progress.ratio.toFixed(4) } }, [
    h("span", { class: "bar-track inline" }, [
      h("span", { class: "bar-fill", style: { width: `${String(progress.ratio * 100)}%` } }),
    ]),
    h("span", { class: "bar-value", text: formatPercent(progress.ratio, lang(), 0) }),
  ]);
}

function markCell(model: ScheduleModel, mark: number | null | undefined): HTMLElement {
  return h("td", {
    text:
      mark === null || mark === undefined
        ? t("sched.notFinishing")
        : formatDayShort(model.startDay + mark, lang()),
    class: mark === null || mark === undefined ? "warn" : "",
  });
}

/**
 * 行ごとの見通し。帯グラフのすぐ下に、**同じ行順で**置く。
 *
 * タブを 1 つにまとめた見返りがここ。工数のぶれと完了日を、タスクごとに
 * 1 行で読める。行を押すと、そのタスクの詳細が開く。
 */
function renderForecastTable(
  state: AppState,
  actions: AppActions,
  model: ScheduleModel,
): HTMLElement {
  const l = lang();
  // 既定は「全体の P50 完了日」。期間の真ん中を出しても、そこはたいてい
  // 全部 100% で何も読み取れない。
  const defaultDay = model.overallMarks.p50 ?? Math.floor(model.displayDays / 2);
  const probeIso = state.probeDate ?? isoFromDay(model.startDay + defaultDay);
  const probeDay = dayFromIso(probeIso);
  const at =
    probeDay === null ? null : Math.max(0, Math.min(model.days - 1, probeDay - model.startDay));

  const picker = h("span", { class: "probe-head" }, [
    dateInput(
      probeIso,
      (value) => {
        actions.patch((s) => {
          s.probeDate = value;
        });
      },
      {
        dataset: { focus: "forecast:probe" },
        attrs: { "aria-label": t("sched.pickDate") },
      },
    ),
    h("span", {
      class: "muted",
      text: at === null ? "" : formatDayLong(model.startDay + at, l),
    }),
  ]);

  // **引きに行く表なので畳む。** 上の帯グラフで全体は読めている。
  // ここを常に開いておくと、タブが縦に伸びて「どこを見ればよいか」が
  // 分からなくなる (開いたときの高さは 3220px あった)。
  return subfold(
    {
      id: "fold-forecast-rows",
      title: t("sched.rowHeading"),
      open: state.openPanels["fold-forecast-rows"] ?? false,
      onToggle: (open) => {
        state.openPanels["fold-forecast-rows"] = open;
      },
    },
    [
      h("div", { class: "forecast-table-wrap" }, [
        h("p", { class: "hint", text: t("sched.rowNote") }),
        h("table", { class: "forecast-table" }, [
          h("thead", {}, [
            h("tr", {}, [
              h("th", { text: t("sched.taskCol") }),
              h("th", { class: "num", text: t("summary.progress") }),
              h("th", { class: "num", text: `${t("sched.remainingCol")} (${t("unit.days")})` }),
              h("th", { text: t("summary.finishP50") }),
              h("th", { text: t("summary.finishP80") }),
              h("th", { class: "num" }, [t("sched.probability"), picker]),
            ]),
          ]),
          h(
            "tbody",
            {},
            forecastRows(state, model, at).map((row) =>
              h("tr", { dataset: { strong: String(row.strong), row: row.id ?? "overall" } }, [
                h("td", { class: "name-cell" }, [
                  h("span", { class: "indent", style: { width: `${String(row.depth * 16)}px` } }),
                  row.openable && row.id !== null
                    ? button(
                        row.label,
                        () => {
                          openTaskDetail(actions, row.id ?? "");
                        },
                        { class: "row-open", dataset: { task: row.id } },
                      )
                    : h("span", { text: row.label }),
                ]),
                progressCell(row.progress),
                h("td", {
                  class: "num",
                  text: row.progress === null ? "—" : formatNumber(row.progress.remaining, l, 1),
                }),
                markCell(model, row.marks?.p50),
                markCell(model, row.marks?.p80),
                h("td", { class: "num", dataset: { prob: row.probability.toFixed(4) } }, [
                  h("span", { class: "bar-track inline" }, [
                    h("span", {
                      class: "bar-fill",
                      style: { width: `${String(row.probability * 100)}%` },
                    }),
                  ]),
                  h("span", { class: "bar-value", text: formatPercent(row.probability, l, 0) }),
                ]),
              ]),
            ),
          ),
        ]),
      ]),
    ],
  );
}

/** タスクの詳細を開く。表からもタスク一覧からも同じ道を通る。 */
export function openTaskDetail(actions: AppActions, taskId: string): void {
  actions.patch((s) => {
    s.taskDetailId = taskId;
  });
}

/** ② 完了日の見通し。帯グラフと行ごとの表。 */
export function renderScheduleCard(
  state: AppState,
  actions: AppActions,
  widgets: AppWidgets,
): HTMLElement | null {
  const model = state.schedule;
  if (model === null || model.days === 0) return null;

  const finish = model.overallMarks.p80;
  const summary =
    finish === null
      ? t("sched.notFinishing")
      : `${t("summary.finishP80")}: ${formatDayLong(model.startDay + finish, lang())}`;

  return card(
    t("sched.heading"),
    [
      h("p", { class: "lead", text: summary }),
      finish === null ? h("p", { class: "hint warn", text: t("sched.extendHorizon") }) : null,
      h("p", { class: "hint", text: t("sched.ganttNote") }),
      legend(),
      widgets.scheduleFigure,
      h("p", {
        class: "hint",
        text: `${t("sched.curveNote")} · ${t("sched.today")}: ${
          model.todayIndex === null
            ? "—"
            : formatDayShort(model.startDay + model.todayIndex, lang())
        }`,
      }),
      renderForecastTable(state, actions, model),
    ],
    "card-schedule",
  );
}
