/**
 * プロジェクト一覧。
 *
 * ここだけは「いま開いている見積もり」ではなく、**その外側**を扱う。
 * どのプロジェクトがあり、どれが遅れていて、誰がどの権限で触れるか。
 *
 * 一覧に出るのは**自分が見られるものだけ**。実効的な役割の解決は API が
 * 行うので、画面は返ってきたものを並べるだけでよい。
 *
 * 既定の並びは「手当てが要るものから」。遅れているプロジェクトが下のほうに
 * 埋もれないようにするため。
 */

import type { ApiClient } from "../api/client.ts";
import type { ProjectRole, ProjectSummary } from "../api/types.ts";
import { PROJECT_ROLES } from "../api/types.ts";
import { PROJECT_SORTS, type AppActions, type AppState, type ProjectSort } from "../app.ts";
import { formatDayShort, formatNumber, formatPercent } from "../format.ts";
import { lang, t } from "../i18n.ts";
import { emptyDocument, newId } from "../model/project.ts";
import { slackDays } from "../model/status.ts";
import { renderAccounts } from "./accounts.ts";
import { commentButton } from "./comments.ts";
import { renderConnection } from "./connection.ts";
import { button, card, dateInput, h, iconButton, select, textInput } from "./dom.ts";
import { renderGroups } from "./groups.ts";
import { healthBadge, healthSeverity, needsAttention } from "./health.ts";
import { renderSharing } from "./sharing.ts";

/** 日時を「いつ更新されたか」として短く出す。 */
function formatMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang() === "ja" ? "ja-JP" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/* ===== 絞り込みと並べ替え ===== */

function matches(state: AppState, project: ProjectSummary): boolean {
  const filter = state.projectFilter;
  const text = filter.text.trim().toLowerCase();
  if (text !== "" && !project.name.toLowerCase().includes(text)) return false;
  if (filter.group !== "") {
    // `-` は「どのグループにも属さない」。
    const group = project.groupId ?? "-";
    if (group !== filter.group) return false;
  }
  if (filter.role !== "" && project.role !== filter.role) return false;
  if (filter.health === "attention") return needsAttention(project.health);
  if (filter.health !== "" && project.health !== filter.health) return false;
  return true;
}

/** 空の値を最後に回して比べる (期限が無いものを先頭に出さない)。 */
function compareOptional(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function sorted(projects: ProjectSummary[], order: ProjectSort): ProjectSummary[] {
  const list = [...projects];
  switch (order) {
    case "attention":
      // 重いものから。同じ重さなら、期限が近いほうを先に。
      list.sort(
        (a, b) =>
          healthSeverity(a.health) - healthSeverity(b.health) ||
          compareOptional(a.dueDate, b.dueDate) ||
          a.name.localeCompare(b.name),
      );
      break;
    case "due":
      list.sort((a, b) => compareOptional(a.dueDate, b.dueDate) || a.name.localeCompare(b.name));
      break;
    case "updated":
      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      break;
    case "name":
      list.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }
  return list;
}

function filterBar(state: AppState, actions: AppActions, shown: number): HTMLElement {
  const filter = state.projectFilter;
  const groupChoices = [
    { value: "", label: t("projects.allGroups") },
    ...state.projectGroups.map((group) => ({ value: group.id, label: group.name })),
    { value: "-", label: t("projects.noGroup") },
  ];
  const healthChoices = [
    { value: "", label: t("projects.allHealth") },
    { value: "attention", label: t("projects.needsAttention") },
    ...(
      [
        "late",
        "behindPace",
        "atRisk",
        "unknown",
        "inProgress",
        "onTrack",
        "done",
        "noTasks",
      ] as const
    ).map((health) => ({ value: health, label: t(`health.${health}`) })),
  ];
  const roleChoices = [
    { value: "", label: t("projects.allRoles") },
    ...[...PROJECT_ROLES].reverse().map((role) => ({ value: role, label: t(`role.${role}`) })),
  ];

  return h("div", { class: "filter-bar" }, [
    textInput(
      filter.text,
      (value) => {
        actions.patch((draft) => {
          draft.projectFilter.text = value;
        });
      },
      {
        class: "filter-text",
        dataset: { focus: "projects:filter:text" },
        attrs: {
          type: "search",
          placeholder: t("projects.search"),
          "aria-label": t("projects.search"),
        },
      },
    ),
    select(
      filter.group,
      groupChoices,
      (value) => {
        actions.patch((draft) => {
          draft.projectFilter.group = value;
        });
      },
      { dataset: { focus: "projects:filter:group" }, attrs: { "aria-label": t("projects.group") } },
    ),
    select(
      filter.health,
      healthChoices,
      (value) => {
        actions.patch((draft) => {
          draft.projectFilter.health = value as AppState["projectFilter"]["health"];
        });
      },
      {
        dataset: { focus: "projects:filter:health" },
        attrs: { "aria-label": t("projects.status") },
      },
    ),
    select(
      filter.role,
      roleChoices,
      (value) => {
        actions.patch((draft) => {
          draft.projectFilter.role = value as ProjectRole | "";
        });
      },
      { dataset: { focus: "projects:filter:role" }, attrs: { "aria-label": t("projects.myRole") } },
    ),
    select(
      state.projectSort,
      PROJECT_SORTS.map((order) => ({ value: order, label: t(`projects.sort.${order}`) })),
      (value) => {
        actions.patch((draft) => {
          draft.projectSort = value;
        });
      },
      { dataset: { focus: "projects:sort" }, attrs: { "aria-label": t("projects.sortBy") } },
    ),
    h("span", {
      class: "filter-count",
      dataset: { shown: String(shown), total: String(state.projects.length) },
      text: t("projects.count", { shown, total: state.projects.length }),
    }),
  ]);
}

/* ===== 1 行 ===== */

/**
 * 完了見込みと、期限までの余裕。
 *
 * 余裕は完了日の下に小さく添える。列を 1 つ増やすより、「いつ終わるか」と
 * 「間に合うか」が並んでいるほうが読みやすい。
 */
function finishCell(project: ProjectSummary): HTMLElement {
  const finish = project.status?.finishP80 ?? null;
  const slack = slackDays(project);
  return h("td", { class: "finish" }, [
    h("div", { class: "stack" }, [
      finish === null
        ? h("span", { class: "muted", text: "—" })
        : h("span", { text: formatDayShort(finish, lang()) }),
      slack === null
        ? null
        : h("span", {
            class: `stack-sub${slack < 0 ? " short" : ""}`,
            dataset: { slack: String(slack) },
            title:
              slack < 0
                ? t("projects.slackShort", { days: -slack })
                : t("projects.slackSpare", { days: slack }),
            text: t("projects.slackDays", { days: slack }),
          }),
    ]),
  ]);
}

function progressCell(project: ProjectSummary): HTMLElement {
  const status = project.status;
  if (status === null) return h("td", { class: "muted", text: "—" });
  const ratio = Math.min(1, Math.max(0, status.progress));
  return h("td", { class: "progress-cell" }, [
    h(
      "div",
      {
        class: "progress-track",
        attrs: {
          role: "img",
          "aria-label": `${t("projects.progress")} ${formatPercent(ratio, lang(), 0)}`,
        },
      },
      [h("div", { class: "progress-fill", style: { width: `${String(ratio * 100)}%` } })],
    ),
    h("span", { class: "progress-text", text: formatPercent(ratio, lang(), 0) }),
  ]);
}

function renderRow(
  state: AppState,
  actions: AppActions,
  project: ProjectSummary,
): HTMLTableRowElement {
  const open = state.open?.id === project.id;
  const client: ApiClient = state.client;
  const manage = project.role === "owner" || state.me.systemRole === "admin";
  const status = project.status;

  const reload = async (): Promise<void> => {
    state.projects = await client.listProjects();
  };

  const rename = (value: string): void => {
    const name = value.trim();
    if (name === "" || name === project.name) return;
    actions.run(async () => {
      await client.updateProject(project.id, { name });
      await reload();
      if (state.open?.id === project.id) state.open.name = name;
    });
  };

  return h(
    "tr",
    {
      class: needsAttention(project.health) ? "attention" : "",
      dataset: {
        project: project.id,
        open: String(open),
        health: project.health,
        attention: String(needsAttention(project.health)),
      },
    },
    [
      h("td", {}, [healthBadge(project.health)]),
      // 名前と「いつ更新されたか」は 1 つの話。2 行にして列を増やさない。
      h("td", { class: "name-cell" }, [
        h("div", { class: "stack" }, [
          manage
            ? textInput(project.name, rename, {
                dataset: { focus: `project:${project.id}:name` },
                attrs: { "aria-label": t("projects.name") },
              })
            : h("span", { text: project.name }),
          h("span", {
            class: "stack-sub",
            text: t("projects.updatedAt", { at: formatMoment(project.updatedAt) }),
          }),
        ]),
      ]),
      h("td", {}, [
        manage
          ? select(
              project.groupId ?? "",
              [
                { value: "", label: t("projects.noGroup") },
                ...state.projectGroups.map((group) => ({ value: group.id, label: group.name })),
              ],
              (value) => {
                actions.run(async () => {
                  await client.updateProject(
                    project.id,
                    value === "" ? { clearGroup: true } : { groupId: value },
                  );
                  await reload();
                });
              },
              {
                dataset: { focus: `project:${project.id}:group` },
                attrs: { "aria-label": t("projects.group") },
              },
            )
          : h("span", {
              class: project.groupName === null ? "muted" : "",
              text: project.groupName ?? "—",
            }),
      ]),
      h("td", {}, [
        manage
          ? dateInput(
              project.dueDate,
              (value) => {
                actions.run(async () => {
                  await client.updateProject(
                    project.id,
                    value === null ? { clearDueDate: true } : { dueDate: value },
                  );
                  await reload();
                });
              },
              {
                dataset: { focus: `project:${project.id}:due` },
                attrs: { "aria-label": t("projects.due") },
              },
            )
          : h("span", {
              class: project.dueDate === null ? "muted" : "",
              text: project.dueDate ?? "—",
            }),
      ]),
      finishCell(project),
      progressCell(project),
      h("td", { class: "num" }, [
        status === null
          ? h("span", { class: "muted", text: "—" })
          : h("span", { text: formatNumber(status.effortP80, lang()) }),
      ]),
      // 所有者と自分の権限は「誰のものか」という 1 つの話なので、まとめる。
      h("td", {}, [
        h("div", { class: "stack" }, [
          h("span", { text: project.ownerNames.join("、") || "—" }),
          h("span", { class: "stack-sub", text: t(`role.${project.role}`) }),
        ]),
      ]),
      h("td", { class: "actions" }, [
        open
          ? h("span", { class: "chip", text: t("projects.opened") })
          : button(t("projects.open"), () => {
              actions.run(async () => {
                await actions.openProject(project.id);
              });
            }),
        // 主な操作は「開く」。複製は短い言葉、削除は記号にして幅を詰める。
        // 複製に記号を当てないのは、どの環境でも確実に出る形が無いため
        // (豆腐になると何のボタンか分からなくなる)。
        button(
          t("projects.duplicateShort"),
          () => {
            actions.run(async () => {
              const copy = await client.duplicateProject(
                project.id,
                newId(),
                t("projects.copyOf", { name: project.name }),
              );
              await reload();
              await actions.openProject(copy.id);
            });
          },
          { class: "icon-text", title: t("projects.duplicate", { name: project.name }) },
        ),
        iconButton(
          "×",
          t("projects.delete", { name: project.name }),
          () => {
            if (!confirm(t("projects.confirmDelete", { name: project.name }))) return;
            actions.run(async () => {
              await client.deleteProject(project.id);
              await reload();
              const next = state.projects[0];
              if (state.open?.id === project.id) {
                if (next) await actions.openProject(next.id);
                else state.open = null;
              }
            });
          },
          !manage,
        ),
      ]),
    ],
  );
}

/* ===== 一覧 ===== */

const COLUMNS = (): { label: string; class?: string }[] => [
  { label: t("projects.status") },
  { label: t("projects.name") },
  { label: t("projects.group") },
  { label: t("projects.due") },
  { label: t("projects.finishP80") },
  { label: t("projects.progress") },
  { label: `${t("projects.effortP80")} (${t("unit.days")})`, class: "num" },
  { label: t("projects.owner") },
  { label: t("col.actions") },
];

function renderProjectList(state: AppState, actions: AppActions): HTMLElement {
  const shown = sorted(
    state.projects.filter((project) => matches(state, project)),
    state.projectSort,
  );
  const stale = state.projects.filter(
    (project) => project.health === "unknown" && project.role !== "viewer",
  );

  return card(t("projects.heading"), [
    h("p", { class: "hint", text: t("projects.hint") }),
    filterBar(state, actions, shown.length),
    state.projects.length === 0
      ? h("p", { class: "empty", text: t("projects.empty") })
      : shown.length === 0
        ? h("p", { class: "empty", text: t("projects.noMatch") })
        : h("div", { class: "table-scroll" }, [
            h("table", { class: "project-table" }, [
              h("thead", {}, [
                h(
                  "tr",
                  {},
                  COLUMNS().map((column) =>
                    h("th", { text: column.label, class: column.class ?? "" }),
                  ),
                ),
              ]),
              h(
                "tbody",
                {},
                shown.map((project) => renderRow(state, actions, project)),
              ),
            ]),
          ]),
    // 控えが内容と対応していないものは、数字を見せずに「再計算が必要」と出す。
    // 古い数字を新しい内容のものとして見せないため。
    stale.length === 0
      ? null
      : h("p", { class: "hint warn", id: "stale-note" }, [
          `${t("projects.staleNote", { count: stale.length })} `,
          button(
            t("projects.recomputeAll"),
            () => {
              actions.run(async () => {
                await actions.recomputeStatuses(stale.map((project) => project.id));
              });
            },
            { dataset: { action: "recompute-all" } },
          ),
        ]),
    h("div", { class: "row-actions" }, [
      button(
        t("projects.new"),
        () => {
          actions.run(async () => {
            const created = await state.client.createProject(
              newId(),
              t("projects.newName"),
              emptyDocument(),
            );
            await actions.openProject(created.id);
          });
        },
        { class: "primary" },
      ),
    ]),
  ]);
}

export function renderProjectsTab(state: AppState, actions: AppActions): HTMLElement {
  return h("div", {}, [
    renderProjectList(state, actions),
    // 開いているプロジェクトへのコメント。タスク宛ては一覧の行から開く。
    state.open === null
      ? null
      : card(t("comments.heading"), [
          h("p", { class: "hint", text: t("comments.viewerCanPost") }),
          h("div", { class: "row-actions" }, [
            commentButton(state, actions, null, t("comments.projectButton")),
          ]),
        ]),
    renderSharing(state, actions),
    // 一覧を主役にしたいので、管理まわりは畳んでおく。
    renderGroups(state, actions),
    renderAccounts(state, actions),
    renderConnection(state, actions),
  ]);
}
