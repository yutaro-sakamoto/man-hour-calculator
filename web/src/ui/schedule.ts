/** スケジュールタブ。完了日の帯グラフと、指定日の完了確率。 */

import type { AppActions, AppState, AppWidgets } from "../app.ts";
import { dayFromIso, formatDayLong, formatDayShort, formatPercent, isoFromDay } from "../format.ts";
import { lang, t } from "../i18n.ts";
import type { ScheduleModel } from "../model/schedule.ts";
import { formatNumber } from "../format.ts";
import { card, dateInput, h } from "./dom.ts";

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

/** 人員ごとに「担当ぶんを終える時期」をまとめる。 */
function renderMemberSummary(model: ScheduleModel): HTMLElement | null {
  const working = model.members.filter((member) => member.taskCount > 0);
  if (working.length <= 1) return null;
  const l = lang();

  return card(t("sched.byMember"), [
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
  ]);
}

/** 指定日における各タスクの完了確率。グラフと同じ数字を表でも読めるようにする。 */
function renderProbeTable(state: AppState, actions: AppActions, model: ScheduleModel): HTMLElement {
  const l = lang();
  // 既定は「全体の P50 完了日」。期間の真ん中を出しても、そこはたいてい
  // 全部 100% で何も読み取れない。
  const defaultDay = model.overallMarks.p50 ?? Math.floor(model.displayDays / 2);
  const probeIso = state.probeDate ?? isoFromDay(model.startDay + defaultDay);
  const probeDay = dayFromIso(probeIso);
  const index =
    probeDay === null ? null : Math.max(0, Math.min(model.days - 1, probeDay - model.startDay));

  const rows = [
    ...model.rows.map((row) => ({
      label: row.label,
      depth: row.depth,
      strong: row.isParent,
      probability: index === null ? 0 : (row.probabilities[index] ?? 0),
    })),
    {
      label: t("sched.overall"),
      depth: 0,
      strong: true,
      probability: index === null ? 0 : (model.overall[index] ?? 0),
    },
  ];

  return card(t("sched.pickDate"), [
    h("div", { class: "probe-row" }, [
      dateInput(
        probeIso,
        (value) => {
          actions.patch((s) => {
            s.probeDate = value;
          });
        },
        { attrs: { "aria-label": t("sched.pickDate") } },
      ),
      h("span", {
        class: "muted",
        text: index === null ? "" : formatDayLong(model.startDay + index, l),
      }),
    ]),
    h("table", { class: "probe-table" }, [
      h("thead", {}, [
        h("tr", {}, [
          h("th", { text: t("sched.taskCol") }),
          h("th", { class: "num", text: t("sched.probability") }),
        ]),
      ]),
      h(
        "tbody",
        {},
        rows.map((row) =>
          h("tr", { dataset: { strong: String(row.strong) } }, [
            h("td", {}, [
              h("span", { class: "indent", style: { width: `${String(row.depth * 16)}px` } }),
              row.label,
            ]),
            h("td", { class: "num" }, [
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
  ]);
}

export function renderScheduleTab(
  state: AppState,
  actions: AppActions,
  widgets: AppWidgets,
): HTMLElement {
  const model = state.schedule;
  if (model === null || model.days === 0) {
    return card(t("sched.heading"), [h("p", { class: "empty", text: t("sched.noResult") })]);
  }

  const finish = model.overallMarks.p80;
  const summary =
    finish === null
      ? t("sched.notFinishing")
      : `${t("summary.finishP80")}: ${formatDayLong(model.startDay + finish, lang())}`;

  return h("div", {}, [
    card(t("sched.heading"), [
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
    ]),
    renderMemberSummary(model),
    renderProbeTable(state, actions, model),
  ]);
}
