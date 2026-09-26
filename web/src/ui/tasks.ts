/**
 * タスクタブ。一覧・絞り込み・並べ替えと階層。
 *
 * 一覧は**読むだけ**にして、名前・見積もり・実績の書き換えは行を押して開く
 * 詳細の窓 (`taskDetail.ts`) に集めてある。
 */

import type { AppActions, AppState } from "../app.ts";
import type { ProjectDocument } from "../api/types.ts";
import { formatDayShort, formatNumber, formatPercent } from "../format.ts";
import { lang, t } from "../i18n.ts";
import { progressOfSubtree, stateOfProgress } from "../model/progress.ts";
import { createTask, sampleDocument } from "../model/project.ts";
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
import type { Priority, Task, TaskState } from "../types.ts";
import { button, card, checkbox, h, headerRow, iconButton, openLink, select } from "./dom.ts";
import { commentButton } from "./comments.ts";
import { priorityChoices } from "./taskFields.ts";

const STATE_ORDER: readonly TaskState[] = ["notStarted", "inProgress", "done"];

function stateOf(state: AppState, row: TreeRow): TaskState {
  if (row.hasChildren && state.result !== null) {
    return stateOfProgress(progressOfSubtree(state.result, state.rows, row.index));
  }
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
  ]);
}

/** 詳細を開く。一覧は読むだけにして、書き換えは詳細の窓でまとめて行う。 */
function openDetail(actions: AppActions, taskId: string): void {
  actions.patch((s) => {
    s.taskDetailId = taskId;
  });
}

/** タスクを足して、そのまま詳細を開く。名前をすぐ書けるように。 */
function addTask(
  actions: AppActions,
  insert: (document: ProjectDocument, task: Task) => void,
  task: Task,
): void {
  actions.mutate((document) => {
    insert(document, task);
  });
  openDetail(actions, task.id);
}

/** 見積もりを 1 欄にまとめる。親は配下の合計、葉は書いたとおり。 */
function estimateText(row: TreeRow): string {
  const l = lang();
  if (row.hasChildren || row.valid) {
    const { min, likely, max } = row.rollup;
    return `${formatNumber(min, l)} – ${formatNumber(likely, l)} – ${formatNumber(max, l)}`;
  }
  // 数になっていない書きかけは、そのまま見せる。0 に丸めると直す手がかりが消える。
  const task = row.task;
  return [task.min, task.likely, task.max]
    .map((value) => (value.trim() === "" ? "?" : value))
    .join(" – ");
}

function progressCell(state: AppState, row: TreeRow): HTMLElement {
  // 計算に入っていない行 (使用を外した行・不正な行) には進捗が無い。
  const progress =
    state.result === null || !row.active
      ? null
      : (state.schedule?.rows.find((item) => item.id === row.task.id)?.progress ?? null);
  if (progress === null || progress.leafCount === 0) {
    return h("td", { class: "num" }, [h("span", { class: "muted", text: "—" })]);
  }
  return h("td", { class: "num progress-cell", dataset: { progress: progress.ratio.toFixed(4) } }, [
    h("span", { class: "bar-track mini" }, [
      h("span", { class: "bar-fill", style: { width: `${String(progress.ratio * 100)}%` } }),
    ]),
    h("span", { class: "bar-value", text: formatPercent(progress.ratio, lang(), 0) }),
  ]);
}

function assigneeText(state: AppState, row: TreeRow): string {
  if (row.hasChildren) return "—";
  const id = row.task.assigneeId;
  if (id === null) return t("members.unassigned");
  const members = state.document.calendar.members;
  const at = members.findIndex((member) => member.id === id);
  const member = members[at];
  return member === undefined ? t("members.unassigned") : memberLabel(member, at);
}

/**
 * 一覧の 1 行。**読むだけ。** 書き換えは行を押して開く詳細の窓で行う。
 *
 * 1 行に 15 の入力欄を並べていたころは、横に長すぎて完了予測が画面の外に
 * 出ていた。一覧に残すのは「どれを開くか」を決めるのに要るものと、
 * 並べ替え・階層・使用の切り替えのように**一覧でしかできない操作**だけ。
 */
function renderRow(
  state: AppState,
  actions: AppActions,
  row: TreeRow,
  position: { first: boolean; last: boolean },
): HTMLTableRowElement {
  const task = row.task;
  const label = task.name.trim() === "" ? t("tasks.untitled") : task.name;
  const index = row.index;
  const state_ = stateOf(state, row);

  const cells: HTMLElement[] = [];

  cells.push(
    h("td", {}, [
      checkbox(
        task.enabled,
        (checked) => {
          actions.mutate((document) => {
            const target = document.tasks.find((item) => item.id === task.id);
            if (target) target.enabled = checked;
          });
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
        openLink(
          label,
          () => {
            openDetail(actions, task.id);
          },
          {
            class: `row-open${task.name.trim() === "" ? " untitled" : ""}`,
            title: t("detail.open", { name: label }),
            dataset: { task: task.id, focus: `${task.id}:open` },
          },
        ),
        task.group.trim() === "" ? null : h("span", { class: "chip muted", text: task.group }),
        task.priority === "high"
          ? h("span", { class: "chip priority-high", text: t("priority.high") })
          : null,
      ]),
    ]),
  );

  cells.push(
    h("td", {}, [h("span", { class: `pill pill-${state_}`, text: t(`state.${state_}`) })]),
    progressCell(state, row),
    h("td", { class: "num estimate" }, [
      row.hasChildren
        ? h("span", { class: "rollup", text: estimateText(row), title: t("tasks.rollupHint") })
        : h("span", { text: estimateText(row) }),
    ]),
    h("td", {}, [
      h("span", { class: row.hasChildren ? "muted" : "", text: assigneeText(state, row) }),
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
        addTask(
          actions,
          (document, child) => {
            document.tasks = insertAfterSubtree(document.tasks, index, child);
          },
          createTask({ parentId: task.id, group: task.group }),
        );
      }),
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
      class: "task-row",
      dataset: {
        task: task.id,
        invalid: String(row.active && !row.valid && !row.hasChildren),
        parent: String(row.hasChildren),
        inactive: String(!row.active),
      },
      on: {
        // 行のどこを押しても開く。名前の字だけが的だと、狭くて押しにくい。
        // 行のなかの操作部品 (チェック・並べ替えなど) はそれぞれの役目を優先する。
        click: (event) => {
          const target = event.target as Element | null;
          if (target?.closest("a, button, input, select, label, textarea") != null) return;
          openDetail(actions, task.id);
        },
      },
    },
    cells,
  );
}

export function renderTasksTab(state: AppState, actions: AppActions): HTMLElement {
  const shown = visibleRows(state);

  const header: { label: string; class?: string }[] = [
    { label: t("col.use") },
    { label: t("col.name") },
    { label: t("col.state") },
    { label: t("col.progress"), class: "num" },
    { label: t("tasks.estimateCol"), class: "num" },
    { label: t("col.assignee") },
    { label: t("col.finish"), class: "num" },
    { label: t("col.actions") },
  ];

  const totals = state.rows.filter((row) => row.leafIndex !== null);
  const sum = (key: "min" | "likely" | "max"): number =>
    totals.reduce((acc, row) => acc + row.rollup[key], 0);

  const empty = state.rows.length === 0;
  // **絞る対象が 2 件に満たないなら、絞り込みは出さない。**
  // 検索・グループ・優先度・状態・担当の 5 つが並ぶと、初めての人は
  // 「まずここを埋めるのか」と読む。1 件の表を絞っても得るものは無い。
  // プロジェクト一覧も同じ規則 (`ui/projects.ts`)。
  const worthFiltering = state.rows.length >= 2;

  return card(null, [
    worthFiltering ? renderFilterBar(state, actions, shown.length) : null,
    worthFiltering ? h("p", { class: "hint", text: t("filter.viewOnly") }) : null,
    // 行が 1 つも無いときは表ごと出さない。列の見出しだけが並んでも、
    // 読み取れるものが無い。
    empty
      ? null
      : h("div", { class: "table-scroll" }, [
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
    empty
      ? h("p", { class: "empty", text: t("tasks.empty") })
      : shown.length === 0
        ? h("p", { class: "empty", text: t("tasks.noMatch") })
        : null,
    h("div", { class: "row-actions" }, [
      button(
        t("tasks.add"),
        () => {
          addTask(
            actions,
            (document, task) => {
              document.tasks.push(task);
            },
            createTask(),
          );
        },
        { id: "add-row", class: "primary" },
      ),
      // **案内が指す操作を、実際に押せるようにする。** ここに置くまで、
      // 空の表は「サンプルを読み込む」と案内しておきながら、その名前の
      // ものが画面のどこにも無かった (見本は初回の起動時にしか作られない)。
      empty
        ? button(t("tasks.loadSample"), () => {
            actions.mutate((document) => {
              const sample = sampleDocument();
              document.tasks = sample.tasks;
              document.calendar.members = sample.calendar.members;
              document.calendar.events = sample.calendar.events;
            });
          })
        : null,
      empty
        ? null
        : button(t("tasks.enableShown"), () => {
            const ids = new Set(shown.map((row) => row.task.id));
            actions.mutate((document) => {
              for (const task of document.tasks) if (ids.has(task.id)) task.enabled = true;
            });
          }),
      empty
        ? null
        : button(t("tasks.disableShown"), () => {
            const ids = new Set(shown.map((row) => row.task.id));
            actions.mutate((document) => {
              for (const task of document.tasks) if (ids.has(task.id)) task.enabled = false;
            });
          }),
    ]),
    empty ? null : h("p", { class: "hint", text: t("tasks.openHint") }),
    empty ? null : h("p", { class: "hint", text: t("tasks.orderHint") }),
    empty ? null : h("p", { class: "hint", text: t("tasks.assignHint") }),
    empty
      ? null
      : h("p", {
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
