/** タスクタブ。階層・優先度・グループ・実績の入力と、表示の絞り込み。 */

import type { AppActions, AppState } from "../app.ts";
import { formatDayShort, formatNumber } from "../format.ts";
import { lang, t } from "../i18n.ts";
import { createTask } from "../model/project.ts";
import {
  collectGroups,
  indentTask,
  insertAfterSubtree,
  moveSubtree,
  outdentTask,
  removeSubtree,
  subtreeRange,
  type TreeRow,
} from "../model/tree.ts";
import { memberLabel, UNASSIGNED_ID } from "../model/members.ts";
import { PRIORITIES, type ColumnMode, type Priority, type Task, type TaskState } from "../types.ts";
import {
  button,
  card,
  checkbox,
  dateInput,
  h,
  headerRow,
  iconButton,
  numberInput,
  select,
  textInput,
} from "./dom.ts";
import { commentButton } from "./comments.ts";

const STATE_ORDER: readonly TaskState[] = ["notStarted", "inProgress", "done"];

function stateOf(state: AppState, row: TreeRow): TaskState {
  if (row.leafIndex === null) return "notStarted";
  const code = state.result?.states[row.leafIndex] ?? 0;
  return STATE_ORDER[code] ?? "notStarted";
}

/** 行そのものが絞り込みに一致するか。 */
function matches(state: AppState, row: TreeRow): boolean {
  const { filter } = state;
  const task = row.task;
  if (filter.text !== "" && !task.name.toLowerCase().includes(filter.text.toLowerCase())) {
    return false;
  }
  if (
    filter.group !== "" &&
    task.group.trim() !== (filter.group === "\u0000" ? "" : filter.group)
  ) {
    return false;
  }
  if (filter.priority !== "" && task.priority !== filter.priority) return false;
  if (filter.state !== "" && stateOf(state, row) !== filter.state) return false;
  if (filter.assignee !== "") {
    const wanted = filter.assignee === UNASSIGNED_ID ? null : filter.assignee;
    if (task.assigneeId !== wanted) return false;
  }
  return true;
}

/**
 * 表示する行を選ぶ。
 *
 * 一致した行の**祖先も残す**。階層の文脈が切れると、どこにぶら下がっている
 * タスクなのか分からなくなるため。
 */
function visibleRows(state: AppState): TreeRow[] {
  const isFiltering =
    state.filter.text !== "" ||
    state.filter.group !== "" ||
    state.filter.priority !== "" ||
    state.filter.state !== "" ||
    state.filter.assignee !== "";
  if (!isFiltering) return state.rows;

  const keep = new Set<string>();
  const byId = new Map(state.rows.map((row) => [row.task.id, row]));
  for (const row of state.rows) {
    if (!matches(state, row)) continue;
    keep.add(row.task.id);
    let parentId = row.task.parentId;
    while (parentId !== null) {
      keep.add(parentId);
      parentId = byId.get(parentId)?.task.parentId ?? null;
    }
  }
  return state.rows.filter((row) => keep.has(row.task.id));
}

function priorityChoices(): { value: Priority; label: string }[] {
  return PRIORITIES.map((value) => ({ value, label: t(`priority.${value}`) }));
}

function columnsFor(mode: ColumnMode): { estimate: boolean; actual: boolean } {
  return { estimate: mode !== "actual", actual: mode !== "estimate" };
}

function renderFilterBar(state: AppState, actions: AppActions, shown: number): HTMLElement {
  const groups = collectGroups(state.document.tasks);
  const clear = (): void => {
    actions.patch((s) => {
      s.filter = { text: "", group: "", priority: "", state: "", assignee: "" };
    });
  };

  return h("div", { class: "filter-bar" }, [
    h("input", {
      class: "filter-text",
      dataset: { focus: "filter:text" },
      attrs: {
        type: "search",
        value: state.filter.text,
        placeholder: t("filter.text"),
        "aria-label": t("filter.text"),
      },
      on: {
        input: (event) => {
          const value = (event.target as HTMLInputElement).value;
          actions.patch((s) => {
            s.filter.text = value;
          });
        },
      },
    }),
    select(
      state.filter.group,
      [
        { value: "", label: `${t("filter.group")}: ${t("filter.all")}` },
        { value: "\u0000", label: t("filter.none") },
        ...groups.map((group) => ({ value: group, label: group })),
      ],
      (value) => {
        actions.patch((s) => {
          s.filter.group = value;
        });
      },
      { attrs: { "aria-label": t("filter.group") } },
    ),
    select<Priority | "">(
      state.filter.priority,
      [{ value: "", label: `${t("filter.priority")}: ${t("filter.all")}` }, ...priorityChoices()],
      (value) => {
        actions.patch((s) => {
          s.filter.priority = value;
        });
      },
      { attrs: { "aria-label": t("filter.priority") } },
    ),
    select<TaskState | "">(
      state.filter.state,
      [
        { value: "", label: `${t("filter.state")}: ${t("filter.all")}` },
        ...STATE_ORDER.map((value) => ({ value, label: t(`state.${value}`) })),
      ],
      (value) => {
        actions.patch((s) => {
          s.filter.state = value;
        });
      },
      { attrs: { "aria-label": t("filter.state") } },
    ),
    select(
      state.filter.assignee,
      [
        { value: "", label: `${t("filter.assignee")}: ${t("filter.all")}` },
        ...state.document.calendar.members.map((member, index) => ({
          value: member.id,
          label: memberLabel(member, index),
        })),
        { value: UNASSIGNED_ID, label: t("members.unassigned") },
      ],
      (value) => {
        actions.patch((s) => {
          s.filter.assignee = value;
        });
      },
      { attrs: { "aria-label": t("filter.assignee") } },
    ),
    button(t("filter.clear"), clear, { class: "ghost" }),
    h("span", {
      class: "filter-count",
      text: t("filter.showing", { shown, total: state.rows.length }),
    }),
    h("div", { class: "segmented", attrs: { role: "group", "aria-label": t("columns.all") } }, [
      ...(["estimate", "actual", "all"] as const).map((mode) =>
        button(
          t(`columns.${mode}`),
          () => {
            actions.patch((s) => {
              s.columnMode = mode;
            });
          },
          { attrs: { "aria-pressed": state.columnMode === mode } },
        ),
      ),
    ]),
  ]);
}

function renderRow(
  state: AppState,
  actions: AppActions,
  row: TreeRow,
  position: { first: boolean; last: boolean },
): HTMLTableRowElement {
  const task = row.task;
  const columns = columnsFor(state.columnMode);
  const label = task.name.trim() === "" ? t("tasks.untitled") : task.name;
  const index = row.index;
  const setTask = (change: Partial<Task>): void => {
    actions.mutate((document) => {
      const target = document.tasks[index];
      if (target) Object.assign(target, change);
    });
  };

  const cells: HTMLElement[] = [];

  cells.push(
    h("td", {}, [
      checkbox(
        task.enabled,
        (checked) => {
          setTask({ enabled: checked });
        },
        {
          dataset: { focus: `${task.id}:use` },
          attrs: { "aria-label": `${label} — ${t("col.use")}` },
        },
      ),
    ]),
  );

  cells.push(
    h("td", { class: "name-cell" }, [
      h("div", { class: "name-inner" }, [
        h("span", { class: "indent", style: { width: `${String(row.depth * 16)}px` } }),
        h("span", { class: "twisty", text: row.hasChildren ? "▾" : "" }),
        textInput(
          task.name,
          (value) => {
            setTask({ name: value });
          },
          {
            dataset: { focus: `${task.id}:name` },
            attrs: { placeholder: t("col.name"), "aria-label": t("col.name") },
          },
        ),
      ]),
    ]),
  );

  if (columns.estimate) {
    cells.push(
      h("td", {}, [
        select(
          task.priority,
          priorityChoices(),
          (value) => {
            setTask({ priority: value });
          },
          {
            class: `priority priority-${task.priority}`,
            dataset: { focus: `${task.id}:priority` },
            attrs: { "aria-label": t("col.priority") },
          },
        ),
      ]),
      h("td", {}, [
        textInput(
          task.group,
          (value) => {
            setTask({ group: value });
          },
          {
            class: "group",
            dataset: { focus: `${task.id}:group` },
            attrs: { "aria-label": t("col.group"), list: "group-options" },
          },
        ),
      ]),
    );

    for (const key of ["min", "likely", "max"] as const) {
      cells.push(
        h("td", { class: "num" }, [
          row.hasChildren
            ? h("span", {
                class: "rollup",
                text: formatNumber(row.rollup[key], lang()),
                title: t("tasks.rollupHint"),
              })
            : numberInput(
                task[key],
                (value) => {
                  setTask({ [key]: value });
                },
                {
                  dataset: { focus: `${task.id}:${key}` },
                  attrs: {
                    min: 0,
                    step: 0.5,
                    "aria-label": `${label} — ${t(`col.${key}`)}`,
                    "aria-invalid": row.active && !row.valid,
                  },
                },
              ),
        ]),
      );
    }
  }

  if (columns.actual) {
    const leafIndex = row.leafIndex;
    const state_ = stateOf(state, row);
    cells.push(
      h("td", {}, [
        row.hasChildren
          ? h("span", { class: "muted", text: "—" })
          : dateInput(
              task.startDate,
              (value) => {
                setTask({ startDate: value });
              },
              {
                dataset: { focus: `${task.id}:start` },
                attrs: { "aria-label": `${label} — ${t("col.start")}` },
              },
            ),
      ]),
      h("td", { class: "num" }, [
        row.hasChildren
          ? h("span", { class: "muted", text: "—" })
          : numberInput(
              task.progress,
              (value) => {
                setTask({ progress: Math.min(100, Math.max(0, Number(value) || 0)) });
              },
              {
                dataset: { focus: `${task.id}:progress` },
                attrs: {
                  min: 0,
                  max: 100,
                  step: 5,
                  "aria-label": `${label} — ${t("col.progress")}`,
                },
              },
            ),
      ]),
      h("td", {}, [
        row.hasChildren
          ? h("span", { class: "muted", text: "—" })
          : dateInput(
              task.endDate,
              (value) => {
                setTask({ endDate: value });
              },
              {
                dataset: { focus: `${task.id}:end` },
                attrs: { "aria-label": `${label} — ${t("col.end")}` },
              },
            ),
      ]),
      h("td", { class: "num" }, [
        h("span", {
          class: "muted",
          text:
            leafIndex === null ? "—" : formatNumber(state.result?.spent[leafIndex] ?? 0, lang(), 1),
        }),
      ]),
      h("td", {}, [h("span", { class: `pill pill-${state_}`, text: t(`state.${state_}`) })]),
    );
  }

  // 担当者は常に見せる。誰の列に積まれるかで日付が変わるため。
  cells.push(
    h("td", {}, [
      row.hasChildren
        ? h("span", { class: "muted", text: "—" })
        : select(
            task.assigneeId ?? "",
            [
              { value: "", label: t("members.unassigned") },
              ...state.document.calendar.members.map((member, memberIndex) => ({
                value: member.id,
                label: memberLabel(member, memberIndex),
              })),
            ],
            (value) => {
              setTask({ assigneeId: value === "" ? null : value });
            },
            {
              class: "assignee",
              dataset: { focus: `${task.id}:assignee` },
              attrs: { "aria-label": `${label} — ${t("col.assignee")}` },
            },
          ),
    ]),
  );

  // 完了予測は常に見せる。これがこのアプリの答えそのもの。
  const scheduleRow = state.schedule?.rows.find((r) => r.id === task.id);
  const finishDay = scheduleRow?.marks.p80 ?? null;
  cells.push(
    h("td", { class: "num finish" }, [
      h("span", {
        text:
          state.schedule === null || scheduleRow === undefined
            ? "—"
            : finishDay === null
              ? t("sched.notFinishing")
              : formatDayShort(state.schedule.startDay + finishDay, lang()),
        class: finishDay === null && scheduleRow !== undefined ? "warn" : "",
      }),
    ]),
  );

  cells.push(
    h("td", { class: "actions" }, [
      iconButton(
        "↑",
        t("tasks.up"),
        () => {
          actions.mutate((document) => {
            document.tasks = moveSubtree(document.tasks, index, -1);
          });
        },
        position.first,
      ),
      iconButton(
        "↓",
        t("tasks.down"),
        () => {
          actions.mutate((document) => {
            document.tasks = moveSubtree(document.tasks, index, 1);
          });
        },
        position.last,
      ),
      iconButton("→", t("tasks.indent"), () => {
        actions.mutate((document) => {
          document.tasks = indentTask(document.tasks, index);
        });
      }),
      iconButton(
        "←",
        t("tasks.outdent"),
        () => {
          actions.mutate((document) => {
            document.tasks = outdentTask(document.tasks, index);
          });
        },
        task.parentId === null,
      ),
      iconButton("+", t("tasks.addChild"), () => {
        actions.mutate((document) => {
          document.tasks = insertAfterSubtree(
            document.tasks,
            index,
            createTask({ parentId: task.id, group: task.group }),
          );
        });
      }),
      // 並べ替えや階層とは別の話なので、削除の手前にまとめて置く。
      commentButton(state, actions, row.task.id, t("comments.taskButton")),
      iconButton("×", t("tasks.removeRow", { name: label }), () => {
        // 配下ごと消えるときだけ問う。1 行ずつ消していく作業で毎回問われるのは
        // 邪魔なだけで、取り返しがつかないのは部分木が消えるときだけ。
        const [start, end] = subtreeRange(state.document.tasks, index);
        const count = end - start;
        if (count > 1 && !confirm(t("tasks.confirmRemoveSubtree", { name: label, count }))) return;
        actions.mutate((document) => {
          document.tasks = removeSubtree(document.tasks, index);
        });
      }),
    ]),
  );

  return h(
    "tr",
    {
      dataset: {
        invalid: String(row.active && !row.valid && !row.hasChildren),
        parent: String(row.hasChildren),
        inactive: String(!row.active),
      },
    },
    cells,
  );
}

export function renderTasksTab(state: AppState, actions: AppActions): HTMLElement {
  const shown = visibleRows(state);
  const columns = columnsFor(state.columnMode);
  const groups = collectGroups(state.document.tasks);

  const header: { label: string; class?: string }[] = [
    { label: t("col.use") },
    { label: t("col.name") },
  ];
  if (columns.estimate) {
    header.push(
      { label: t("col.priority") },
      { label: t("col.group") },
      { label: t("col.min"), class: "num" },
      { label: t("col.likely"), class: "num" },
      { label: t("col.max"), class: "num" },
    );
  }
  if (columns.actual) {
    header.push(
      { label: t("col.start") },
      { label: t("col.progress"), class: "num" },
      { label: t("col.end") },
      { label: t("col.spent"), class: "num" },
      { label: t("col.state") },
    );
  }
  header.push(
    { label: t("col.assignee") },
    { label: t("col.finish"), class: "num" },
    { label: t("col.actions") },
  );

  const totals = state.rows.filter((row) => row.leafIndex !== null);
  const sum = (key: "min" | "likely" | "max"): number =>
    totals.reduce((acc, row) => acc + row.rollup[key], 0);

  return card(null, [
    renderFilterBar(state, actions, shown.length),
    h("p", { class: "hint", text: t("filter.viewOnly") }),
    h("div", { class: "table-scroll" }, [
      h("table", { class: "task-table" }, [
        h("thead", {}, [headerRow(header)]),
        h(
          "tbody",
          {},
          shown.map((row, i) =>
            renderRow(state, actions, row, { first: i === 0, last: i === shown.length - 1 }),
          ),
        ),
      ]),
    ]),
    h(
      "datalist",
      { id: "group-options" },
      groups.map((group) => h("option", { attrs: { value: group } })),
    ),
    state.rows.length === 0
      ? h("p", { class: "empty", text: t("tasks.empty") })
      : shown.length === 0
        ? h("p", { class: "empty", text: t("tasks.noMatch") })
        : null,
    h("div", { class: "row-actions" }, [
      button(
        t("tasks.add"),
        () => {
          actions.mutate((document) => {
            document.tasks.push(createTask());
          });
        },
        { id: "add-row", class: "primary" },
      ),
      button(t("tasks.enableShown"), () => {
        const ids = new Set(shown.map((row) => row.task.id));
        actions.mutate((document) => {
          for (const task of document.tasks) if (ids.has(task.id)) task.enabled = true;
        });
      }),
      button(t("tasks.disableShown"), () => {
        const ids = new Set(shown.map((row) => row.task.id));
        actions.mutate((document) => {
          for (const task of document.tasks) if (ids.has(task.id)) task.enabled = false;
        });
      }),
    ]),
    h("p", { class: "hint", text: t("tasks.orderHint") }),
    h("p", { class: "hint", text: t("tasks.assignHint") }),
    h("p", {
      class: "status",
      text: t("tasks.totals", {
        count: totals.length,
        min: formatNumber(sum("min"), lang()),
        likely: formatNumber(sum("likely"), lang()),
        max: formatNumber(sum("max"), lang()),
        unit: t("unit.days"),
      }),
    }),
  ]);
}
