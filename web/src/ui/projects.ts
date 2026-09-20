/**
 * プロジェクトタブ。
 *
 * ここだけは「いま開いている見積もり」ではなく、**その外側**を扱う。
 * どのプロジェクトがあり、誰がどの権限で触れて、どのアカウントで操作しているか。
 * サーバに繋いだときに効いてくるのはこの層の設定。
 */

import type { ApiClient } from "../api/client.ts";
import type { Principal, ProjectRole, ProjectSummary, SystemRole, User } from "../api/types.ts";
import { PROJECT_ROLES, principalKey, principalUser } from "../api/types.ts";
import { canManage, type AppActions, type AppState } from "../app.ts";
import { lang, t } from "../i18n.ts";
import { LocalApiClient } from "../api/local.ts";
import { emptyDocument, newId } from "../model/project.ts";
import { button, card, h, iconButton, select, textInput } from "./dom.ts";

const ROLE_CHOICES = (): { value: ProjectRole; label: string }[] =>
  [...PROJECT_ROLES].reverse().map((role) => ({ value: role, label: t(`role.${role}`) }));

const SYSTEM_ROLE_CHOICES = (): { value: SystemRole; label: string }[] =>
  (["member", "admin"] as const).map((role) => ({
    value: role,
    label: t(`systemRole.${role}`),
  }));

function formatMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang() === "ja" ? "ja-JP" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function userName(state: AppState, id: string): string {
  return state.users.find((user) => user.id === id)?.name ?? id;
}

/** 権限を配った相手の表示名。グループは名前を持っていないので id を出す。 */
function principalName(state: AppState, principal: Principal): string {
  return principal.kind === "user" ? userName(state, principal.id) : principal.id;
}

/* ===== プロジェクト一覧 ===== */

function renderProjectRow(
  state: AppState,
  actions: AppActions,
  project: ProjectSummary,
): HTMLTableRowElement {
  const open = state.open?.id === project.id;
  const client: ApiClient = state.client;
  const manage = project.role === "owner" || state.me.systemRole === "admin";

  return h("tr", { dataset: { project: project.id, open: String(open) } }, [
    h("td", {}, [
      manage
        ? textInput(
            project.name,
            (value) => {
              const name = value.trim();
              if (name === "" || name === project.name) return;
              actions.run(async () => {
                await client.updateProject(project.id, { name });
                state.projects = await client.listProjects();
                if (state.open?.id === project.id) state.open.name = name;
              });
            },
            {
              dataset: { focus: `project:${project.id}:name` },
              attrs: { "aria-label": t("projects.name") },
            },
          )
        : h("span", { text: project.name }),
    ]),
    h("td", { text: t(`role.${project.role}`) }),
    h("td", { text: project.ownerNames.join("、") || "—" }),
    h("td", { class: "num", text: String(project.taskCount) }),
    h("td", { class: "num", text: String(project.memberCount) }),
    h("td", { text: formatMoment(project.updatedAt) }),
    h("td", { class: "actions" }, [
      open
        ? h("span", { class: "chip", text: t("projects.opened") })
        : button(t("projects.open"), () => {
            actions.run(async () => {
              await actions.openProject(project.id);
            });
          }),
      button(t("projects.duplicate"), () => {
        actions.run(async () => {
          const copy = await client.duplicateProject(
            project.id,
            newId(),
            t("projects.copyOf", { name: project.name }),
          );
          state.projects = await client.listProjects();
          await actions.openProject(copy.id);
        });
      }),
      iconButton(
        "×",
        t("projects.delete"),
        () => {
          if (!confirm(t("projects.confirmDelete", { name: project.name }))) return;
          actions.run(async () => {
            await client.deleteProject(project.id);
            state.projects = await client.listProjects();
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
  ]);
}

function renderProjectList(state: AppState, actions: AppActions): HTMLElement {
  return card(t("projects.heading"), [
    h("p", { class: "hint", text: t("projects.hint") }),
    state.projects.length === 0
      ? h("p", { class: "empty", text: t("projects.empty") })
      : h("div", { class: "table-scroll" }, [
          h("table", {}, [
            h("thead", {}, [
              h("tr", {}, [
                h("th", { text: t("projects.name") }),
                h("th", { text: t("projects.myRole") }),
                h("th", { text: t("projects.owner") }),
                h("th", { class: "num", text: t("projects.tasks") }),
                h("th", { class: "num", text: t("projects.members") }),
                h("th", { text: t("projects.updated") }),
                h("th", { text: t("col.actions") }),
              ]),
            ]),
            h(
              "tbody",
              {},
              state.projects.map((project) => renderProjectRow(state, actions, project)),
            ),
          ]),
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

/* ===== 共有 ===== */

function renderSharing(state: AppState, actions: AppActions): HTMLElement {
  const open = state.open;
  if (open === null) {
    return card(t("share.heading"), [h("p", { class: "empty", text: t("share.needProject") })]);
  }
  const manage = canManage(state) || state.me.systemRole === "admin";
  const shared = new Set(open.access.map((entry) => principalKey(entry.principal)));
  const candidates = state.users.filter(
    (user) => !shared.has(principalKey(principalUser(user.id))),
  );

  const refresh = async (): Promise<void> => {
    const access = await state.client.listAccess(open.id);
    if (state.open) state.open.access = access;
    state.projects = await state.client.listProjects();
  };

  return card(t("share.heading"), [
    h("p", { class: "hint", text: t("share.hint") }),
    state.client.remote ? null : h("p", { class: "hint", text: t("share.localHint") }),
    open.access.length === 0
      ? h("p", { class: "empty", text: t("share.notShared") })
      : h("table", { class: "share-table" }, [
          h("thead", {}, [
            h("tr", {}, [
              h("th", { text: t("share.user") }),
              h("th", { text: t("share.role") }),
              h("th", { text: t("col.actions") }),
            ]),
          ]),
          h(
            "tbody",
            {},
            open.access.map((entry) =>
              h("tr", { dataset: { principal: principalKey(entry.principal) } }, [
                h("td", {}, [
                  principalName(state, entry.principal),
                  entry.principal.kind === "group"
                    ? h("span", { class: "muted", text: ` ${t("share.group")}` })
                    : null,
                  entry.principal.kind === "user" && entry.principal.id === state.me.id
                    ? h("span", { class: "muted", text: ` ${t("accounts.you")}` })
                    : null,
                ]),
                h("td", {}, [
                  select(
                    entry.role,
                    ROLE_CHOICES(),
                    (role) => {
                      actions.run(async () => {
                        await state.client.setAccess(open.id, entry.principal, role);
                        await refresh();
                      });
                    },
                    {
                      dataset: { focus: `access:${principalKey(entry.principal)}` },
                      attrs: { disabled: !manage, "aria-label": t("share.role") },
                    },
                  ),
                ]),
                h("td", { class: "actions" }, [
                  iconButton(
                    "×",
                    t("share.remove", { name: principalName(state, entry.principal) }),
                    () => {
                      actions.run(async () => {
                        await state.client.removeAccess(open.id, entry.principal);
                        await refresh();
                      });
                    },
                    !manage,
                  ),
                ]),
              ]),
            ),
          ),
        ]),
    manage && candidates.length > 0
      ? h("div", { class: "row-actions" }, [
          (() => {
            let pick = candidates[0]?.id ?? "";
            let role: ProjectRole = "editor";
            const userSelect = select(
              pick,
              candidates.map((user) => ({ value: user.id, label: user.name })),
              (value) => {
                pick = value;
              },
              { attrs: { "aria-label": t("share.user") } },
            );
            const roleSelect = select(
              role,
              ROLE_CHOICES(),
              (value) => {
                role = value;
              },
              { attrs: { "aria-label": t("share.role") } },
            );
            return h("div", { class: "inline-row" }, [
              userSelect,
              roleSelect,
              button(
                t("share.add"),
                () => {
                  actions.run(async () => {
                    await state.client.setAccess(open.id, principalUser(pick), role);
                    await refresh();
                  });
                },
                { class: "primary" },
              ),
            ]);
          })(),
        ])
      : null,
  ]);
}

/* ===== アカウント ===== */

function renderAccountRow(state: AppState, actions: AppActions, user: User): HTMLTableRowElement {
  const admin = state.me.systemRole === "admin";
  const isMe = user.id === state.me.id;

  return h("tr", { dataset: { account: user.id } }, [
    h("td", {}, [
      admin || isMe
        ? textInput(
            user.name,
            (value) => {
              const name = value.trim();
              if (name === "" || name === user.name) return;
              actions.run(async () => {
                await state.client.updateUser(user.id, { name });
                state.users = await state.client.listUsers();
                if (isMe) state.me = await state.client.me();
              });
            },
            {
              dataset: { focus: `account:${user.id}:name` },
              attrs: { "aria-label": t("accounts.name") },
            },
          )
        : h("span", { text: user.name }),
      isMe ? h("span", { class: "muted", text: ` ${t("accounts.you")}` }) : null,
    ]),
    h("td", {}, [
      select(
        user.systemRole,
        SYSTEM_ROLE_CHOICES(),
        (systemRole) => {
          actions.run(async () => {
            await state.client.updateUser(user.id, { systemRole });
            state.users = await state.client.listUsers();
            if (isMe) state.me = await state.client.me();
          });
        },
        {
          dataset: { focus: `account:${user.id}:role` },
          attrs: { disabled: !admin, "aria-label": t("accounts.systemRole") },
        },
      ),
    ]),
    h("td", { class: "actions" }, [
      iconButton(
        "×",
        t("accounts.remove", { name: user.name }),
        () => {
          actions.run(async () => {
            await state.client.deleteUser(user.id);
            state.users = await state.client.listUsers();
            state.projects = await state.client.listProjects();
          });
        },
        !admin || isMe,
      ),
    ]),
  ]);
}

function renderAccounts(state: AppState, actions: AppActions): HTMLElement {
  const admin = state.me.systemRole === "admin";
  const local = state.client instanceof LocalApiClient ? state.client : null;

  return card(t("accounts.heading"), [
    h("p", { class: "hint", text: t("accounts.hint") }),
    h("table", { class: "account-table" }, [
      h("thead", {}, [
        h("tr", {}, [
          h("th", { text: t("accounts.name") }),
          h("th", { text: t("accounts.systemRole") }),
          h("th", { text: t("col.actions") }),
        ]),
      ]),
      h(
        "tbody",
        {},
        state.users.map((user) => renderAccountRow(state, actions, user)),
      ),
    ]),
    admin
      ? h("div", { class: "row-actions" }, [
          button(t("accounts.add"), () => {
            actions.run(async () => {
              await state.client.createUser({
                id: newId(),
                name: t("accounts.name"),
                systemRole: "member",
              });
              state.users = await state.client.listUsers();
            });
          }),
        ])
      : null,
    // ローカルにはログインが無い。権限の効き方を確かめられるようにしておく。
    local === null
      ? null
      : h("div", { class: "act-as" }, [
          h("span", { class: "field-label", text: t("accounts.actAs") }),
          h("div", { class: "inline-row" }, [
            select(
              state.me.id,
              state.users.map((user) => ({
                value: user.id,
                label: `${user.name} (${t(`systemRole.${user.systemRole}`)})`,
              })),
              (value) => {
                actions.run(async () => {
                  local.actAs(value);
                  state.me = await state.client.me();
                  state.projects = await state.client.listProjects();
                  const still = state.projects.find((item) => item.id === state.open?.id);
                  if (still) await actions.openProject(still.id);
                  else if (state.projects[0]) await actions.openProject(state.projects[0].id);
                  else state.open = null;
                });
              },
              { attrs: { "aria-label": t("accounts.actAs") } },
            ),
          ]),
          h("p", { class: "hint", text: t("accounts.actAsHint") }),
        ]),
  ]);
}

export function renderProjectsTab(state: AppState, actions: AppActions): HTMLElement {
  return h("div", {}, [
    renderProjectList(state, actions),
    renderSharing(state, actions),
    renderAccounts(state, actions),
  ]);
}
