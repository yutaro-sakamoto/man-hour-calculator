/**
 * タスク 1 件の詳細。見通しの表からも、タスク一覧からも開く。
 *
 * **モーダルにする。** 見通しの表は真上の帯グラフと 1 行ずつ対応しているので、
 * 行の場所で開くと並びがずれて、タブをまとめて得たものを壊してしまう。
 *
 * canvas は置かない。窓は毎回組み直すので、使い回しの canvas は入れられない
 * (確率の線は `sparkline.ts` の SVG)。
 */

import type { AppActions, AppState } from "../app.ts";
import { canWrite } from "../app.ts";
import { formatDayShort, formatNumber, formatPercent } from "../format.ts";
import { lang, t } from "../i18n.ts";
import { progressOfSubtree, type Progress } from "../model/progress.ts";
import { collectGroups, type TreeRow } from "../model/tree.ts";
import type { ScheduleRow } from "../model/schedule.ts";
import type { TaskState } from "../types.ts";
import { commentButton } from "./comments.ts";
import { button, checkbox, field, h, iconButton } from "./dom.ts";
import { sparkline } from "./sparkline.ts";
import {
  assigneeField,
  endField,
  estimateField,
  groupField,
  groupOptions,
  nameField,
  priorityField,
  progressField,
  startField,
  taskWriter,
  type FieldOptions,
} from "./taskFields.ts";

const STATE_ORDER: readonly TaskState[] = ["notStarted", "inProgress", "done"];

/** 読むだけの 1 項目。 */
function readout(label: string, value: string, key: string): HTMLElement {
  return h("div", { class: "detail-readout", dataset: { key, value } }, [
    h("span", { class: "field-label", text: label }),
    h("strong", { text: value }),
  ]);
}

function stateOf(state: AppState, row: TreeRow): TaskState {
  if (row.leafIndex === null) return "notStarted";
  return STATE_ORDER[state.result?.states[row.leafIndex] ?? 0] ?? "notStarted";
}

/** 残りの見積もり。`effective` は消化ぶんを含む総工数なので、引いて出す。 */
function remainingEstimate(
  state: AppState,
  leafIndex: number,
): { min: number; likely: number; max: number } | null {
  const result = state.result;
  if (result === null) return null;
  const spent = result.spent[leafIndex] ?? 0;
  const at = leafIndex * 3;
  const pick = (offset: number): number =>
    Math.max(0, (result.effective[at + offset] ?? 0) - spent);
  return { min: pick(0), likely: pick(1), max: pick(2) };
}

/** 完了予測と確率の線。親でも葉でも同じものを出す。 */
function forecastSection(
  state: AppState,
  row: TreeRow,
  scheduleRow: ScheduleRow | undefined,
  progress: Progress,
): HTMLElement {
  const l = lang();
  const schedule = state.schedule;
  const result = state.result;
  const day = (mark: number | null | undefined): string =>
    mark === null || mark === undefined || schedule === null
      ? t("sched.notFinishing")
      : formatDayShort(schedule.startDay + mark, l);

  const remaining = row.leafIndex === null ? null : remainingEstimate(state, row.leafIndex);
  const share =
    row.leafIndex === null || result === null ? null : (result.sensitivity[row.leafIndex] ?? 0);

  return h("section", { class: "detail-section", dataset: { section: "forecast" } }, [
    h("h3", { class: "section-title", text: t("detail.forecast") }),
    h("div", { class: "detail-readouts" }, [
      readout(t("summary.finishP50"), day(scheduleRow?.marks.p50), "finishP50"),
      readout(t("summary.finishP80"), day(scheduleRow?.marks.p80), "finishP80"),
      readout(t("summary.progress"), formatPercent(progress.ratio, l, 0), "progress"),
      readout(
        `${t("progress.spent")} (${t("unit.days")})`,
        formatNumber(progress.spent, l, 1),
        "spent",
      ),
      readout(
        `${t("progress.remaining")} (${t("unit.days")})`,
        formatNumber(progress.remaining, l, 1),
        "remaining",
      ),
      row.hasChildren
        ? readout(
            t("progress.done"),
            t("progress.doneOf", { done: progress.doneCount, count: progress.leafCount }),
            "done",
          )
        : null,
      remaining === null
        ? null
        : readout(
            `${t("detail.remainingEstimate")} (${t("unit.days")})`,
            `${formatNumber(remaining.min, l, 1)} – ${formatNumber(remaining.likely, l, 1)} – ${formatNumber(remaining.max, l, 1)}`,
            "remainingEstimate",
          ),
      share === null ? null : readout(t("sens.share"), formatPercent(share, l, 1), "share"),
    ]),
    scheduleRow === undefined || schedule === null
      ? null
      : h("div", { class: "detail-spark" }, [
          sparkline({
            values: scheduleRow.probabilities,
            marks: [scheduleRow.marks.p50, scheduleRow.marks.p80],
            label: t("detail.curveLabel", { name: row.task.name }),
          }),
          h("p", { class: "hint", text: t("detail.curveNote") }),
        ]),
  ]);
}

/** 書き換えられる欄。親では見積もりと実績が読むだけになる。 */
function editSection(state: AppState, actions: AppActions, row: TreeRow): HTMLElement {
  const task = row.task;
  const set = taskWriter(actions, task.id);
  const options: FieldOptions = {
    focusPrefix: `detail:${task.id}`,
    label: task.name.trim() === "" ? t("tasks.untitled") : task.name,
  };
  const l = lang();
  const rolled = (key: "min" | "likely" | "max"): HTMLElement =>
    h("span", {
      class: "rollup",
      text: formatNumber(row.rollup[key], l),
      title: t("tasks.rollupHint"),
    });

  return h("section", { class: "detail-section", dataset: { section: "edit" } }, [
    h("h3", { class: "section-title", text: t("detail.edit") }),
    h("div", { class: "detail-fields" }, [
      h("label", { class: "toggle" }, [
        checkbox(
          task.enabled,
          (checked) => {
            set({ enabled: checked });
          },
          {
            dataset: { focus: `${options.focusPrefix}:use` },
            attrs: { "aria-label": t("col.use") },
          },
        ),
        h("span", { text: t("col.use") }),
      ]),
      field(t("col.name"), nameField(task, set, options)),
      field(t("col.priority"), priorityField(task, set, options)),
      field(t("col.group"), groupField(task, set, options)),
      ...(["min", "likely", "max"] as const).map((key) =>
        field(
          t(`col.${key}`),
          row.hasChildren
            ? rolled(key)
            : estimateField(task, key, set, {
                ...options,
                invalid: row.active && !row.valid,
              }),
        ),
      ),
      field(
        t("col.assignee"),
        row.hasChildren
          ? h("span", { class: "muted", text: t("detail.fromChildren") })
          : assigneeField(state, task, set, options),
      ),
      field(
        t("col.start"),
        row.hasChildren
          ? h("span", { class: "muted", text: t("detail.fromChildren") })
          : startField(task, set, options),
      ),
      field(
        t("col.progress"),
        row.hasChildren
          ? h("span", { class: "muted", text: t("detail.fromChildren") })
          : progressField(task, set, options),
      ),
      field(
        t("col.end"),
        row.hasChildren
          ? h("span", { class: "muted", text: t("detail.fromChildren") })
          : endField(task, set, options),
      ),
    ]),
    row.hasChildren ? h("p", { class: "hint", text: t("detail.parentNote") }) : null,
    groupOptions(collectGroups(state.document.tasks)),
  ]);
}

/** 直接の子。押すと窓がその子に移る (掘り下げになる)。 */
function childrenSection(state: AppState, actions: AppActions, row: TreeRow): HTMLElement | null {
  const children = state.rows.filter((item) => item.task.parentId === row.task.id);
  if (children.length === 0) return null;

  return h("section", { class: "detail-section", dataset: { section: "children" } }, [
    h("h3", { class: "section-title", text: t("detail.children") }),
    h(
      "div",
      { class: "detail-children" },
      children.map((child) =>
        button(
          child.task.name.trim() === "" ? t("tasks.untitled") : child.task.name,
          () => {
            actions.patch((s) => {
              s.taskDetailId = child.task.id;
            });
          },
          { class: "row-open", dataset: { task: child.task.id } },
        ),
      ),
    ),
  ]);
}

export function renderTaskDetailModal(state: AppState, actions: AppActions): HTMLElement | null {
  const taskId = state.taskDetailId;
  if (taskId === null) return null;
  const at = state.rows.findIndex((row) => row.task.id === taskId);
  const row = state.rows[at];
  // 開いたまま消えたタスク。窓だけ残しても中身が無いので、黙って閉じる。
  if (row === undefined) return null;

  const close = (): void => {
    actions.patch((s) => {
      s.taskDetailId = null;
    });
  };
  const move = (step: -1 | 1): void => {
    const next = state.rows[at + step];
    if (next === undefined) return;
    actions.patch((s) => {
      s.taskDetailId = next.task.id;
    });
  };

  const label = row.task.name.trim() === "" ? t("tasks.untitled") : row.task.name;
  const taskState = stateOf(state, row);
  const progress =
    state.result === null
      ? { spent: 0, remaining: 0, total: 0, ratio: 0, doneCount: 0, leafCount: 0 }
      : progressOfSubtree(state.result, state.rows, at);
  const scheduleRow = state.schedule?.rows.find((item) => item.id === row.task.id);

  const body = h("div", { class: "detail-body" }, [
    forecastSection(state, row, scheduleRow, progress),
    editSection(state, actions, row),
    childrenSection(state, actions, row),
  ]);

  const panel = h(
    "div",
    {
      class: "modal-card detail-card",
      dataset: { task: row.task.id },
      attrs: { role: "dialog", "aria-modal": "true", "aria-label": label },
    },
    [
      h("div", { class: "event-head" }, [
        h("strong", { class: "detail-heading", text: label }),
        h("span", { class: `pill pill-${taskState}`, text: t(`state.${taskState}`) }),
        row.hasChildren ? h("span", { class: "chip muted", text: t("detail.group") }) : null,
        h("span", { class: "spacer" }),
        commentButton(state, actions, row.task.id, t("comments.taskButton")),
        iconButton(
          "←",
          t("detail.previous"),
          () => {
            move(-1);
          },
          at === 0,
        ),
        iconButton(
          "→",
          t("detail.next"),
          () => {
            move(1);
          },
          at >= state.rows.length - 1,
        ),
        iconButton("×", t("detail.close"), close),
      ]),
      // 窓はタブの中身の外にあるので、`render()` の読み取り専用の囲いが効かない。
      // ここで自前で止める。
      canWrite(state)
        ? body
        : h("fieldset", { class: "readonly", attrs: { disabled: true } }, [body]),
    ],
  );

  // 開いた直後だけ名前に合わせる。すでに窓のなかを触っているときは奪わない。
  queueMicrotask(() => {
    if (panel.contains(document.activeElement)) return;
    panel
      .querySelector<HTMLInputElement>(`[data-focus="detail:${CSS.escape(row.task.id)}:name"]`)
      ?.focus();
  });

  return h(
    "div",
    {
      class: "modal-backdrop",
      on: {
        click: (event) => {
          if (event.target === event.currentTarget) close();
        },
        keydown: (event) => {
          if (event.key === "Escape") close();
        },
      },
    },
    [panel],
  );
}
