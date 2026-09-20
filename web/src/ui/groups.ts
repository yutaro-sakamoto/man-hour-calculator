/**
 * グループ。
 *
 * 入れ物は 2 種類あり、役割が違う。
 *
 * - **アカウントのグループ** … 部署やチーム。権限をまとめて配るための束。
 *   人の出入りはここで面倒を見るので、異動のたびに全プロジェクトを
 *   触らなくて済む。
 * - **プロジェクトのグループ** … プロジェクトの入れ物。ここに配った権限は
 *   配下のすべてに継がれる。「この部署の案件はみんな見える」が 1 回で済む。
 */

import type { ProjectRole } from "../api/types.ts";
import {
  PROJECT_ROLES,
  principalGroup,
  principalKey,
  principalUser,
  type Principal,
} from "../api/types.ts";
import type { AppActions, AppState } from "../app.ts";
import { t } from "../i18n.ts";
import { newId } from "../model/project.ts";
import { button, checkbox, foldout, h, iconButton, select, textInput, type Child } from "./dom.ts";
import { principalName } from "./sharing.ts";

const ROLE_CHOICES = (): { value: ProjectRole; label: string }[] =>
  [...PROJECT_ROLES].reverse().map((role) => ({ value: role, label: t(`role.${role}`) }));

/** 一覧を主役にしたいので、管理まわりは畳んでおく。 */
function panel(
  state: AppState,
  id: string,
  title: string,
  hint: string,
  children: Child[],
): HTMLElement {
  return foldout(
    {
      id,
      title,
      open: state.openPanels[id] ?? false,
      onToggle: (open) => {
        // 覚えるだけ。ここで描き直すと開閉のたびに全部が組み直される。
        state.openPanels[id] = open;
      },
    },
    [h("p", { class: "hint", text: hint }), ...children],
  );
}

/* ===== アカウントのグループ ===== */

function renderUserGroups(state: AppState, actions: AppActions): HTMLElement {
  const admin = state.me.systemRole === "admin";
  const reload = async (): Promise<void> => {
    state.userGroups = await state.client.listUserGroups();
    state.projects = await state.client.listProjects();
  };

  return panel(state, "user-groups", t("groups.users"), t("groups.usersHint"), [
    state.userGroups.length === 0
      ? h("p", { class: "empty", text: t("groups.noUserGroups") })
      : h(
          "div",
          { class: "group-list" },
          state.userGroups.map((group) =>
            h("div", { class: "group-card", dataset: { userGroup: group.id } }, [
              h("div", { class: "group-head" }, [
                admin
                  ? textInput(
                      group.name,
                      (value) => {
                        const name = value.trim();
                        if (name === "" || name === group.name) return;
                        actions.run(async () => {
                          await state.client.renameUserGroup(group.id, name);
                          await reload();
                        });
                      },
                      {
                        class: "group-name",
                        dataset: { focus: `userGroup:${group.id}:name` },
                        attrs: { "aria-label": t("groups.name") },
                      },
                    )
                  : h("span", { class: "group-name", text: group.name }),
                h("span", {
                  class: "chip muted",
                  text: t("groups.memberCount", { count: group.members.length }),
                }),
                iconButton(
                  "×",
                  t("groups.remove", { name: group.name }),
                  () => {
                    if (!confirm(t("groups.confirmDelete", { name: group.name }))) return;
                    actions.run(async () => {
                      await state.client.deleteUserGroup(group.id);
                      await reload();
                    });
                  },
                  !admin,
                ),
              ]),
              // メンバーは出し入れするだけなので、チェックで済ませる。
              h(
                "div",
                { class: "member-picks" },
                state.users.map((user) => {
                  const inside = group.members.includes(user.id);
                  return h("label", { class: "member-pick" }, [
                    checkbox(
                      inside,
                      (next) => {
                        actions.run(async () => {
                          if (next) await state.client.addGroupMember(group.id, user.id);
                          else await state.client.removeGroupMember(group.id, user.id);
                          await reload();
                        });
                      },
                      {
                        dataset: { focus: `userGroup:${group.id}:${user.id}` },
                        attrs: { disabled: !admin },
                      },
                    ),
                    h("span", { text: user.name }),
                  ]);
                }),
              ),
            ]),
          ),
        ),
    admin
      ? h("div", { class: "row-actions" }, [
          button(t("groups.addUserGroup"), () => {
            actions.run(async () => {
              await state.client.createUserGroup(newId(), t("groups.newUserGroupName"));
              await reload();
            });
          }),
        ])
      : null,
  ]);
}

/* ===== プロジェクトのグループ ===== */

function renderProjectGroups(state: AppState, actions: AppActions): HTMLElement {
  const reload = async (): Promise<void> => {
    state.projectGroups = await state.client.listProjectGroups();
    state.projects = await state.client.listProjects();
  };

  /** そのグループを管理できるか。所有者、または管理者。 */
  const canManage = (access: { principal: Principal; role: ProjectRole }[]): boolean => {
    if (state.me.systemRole === "admin") return true;
    return access.some(
      (entry) =>
        entry.role === "owner" &&
        (entry.principal.kind === "user"
          ? entry.principal.id === state.me.id
          : (state.userGroups
              .find((group) => group.id === entry.principal.id)
              ?.members.includes(state.me.id) ?? false)),
    );
  };

  return panel(state, "project-groups", t("groups.projects"), t("groups.projectsHint"), [
    state.projectGroups.length === 0
      ? h("p", { class: "empty", text: t("groups.noProjectGroups") })
      : h(
          "div",
          { class: "group-list" },
          state.projectGroups.map((group) => {
            const manage = canManage(group.access);
            const inside = state.projects.filter((project) => project.groupId === group.id);
            const taken = new Set(group.access.map((entry) => principalKey(entry.principal)));
            const choices: { principal: Principal; label: string }[] = [
              ...state.users
                .map((user) => ({ principal: principalUser(user.id), label: user.name }))
                .filter((choice) => !taken.has(principalKey(choice.principal))),
              ...state.userGroups
                .map((team) => ({
                  principal: principalGroup(team.id),
                  label: `${team.name} ${t("share.groupSuffix")}`,
                }))
                .filter((choice) => !taken.has(principalKey(choice.principal))),
            ];
            const firstChoice = choices[0];
            let pick = firstChoice === undefined ? "" : principalKey(firstChoice.principal);
            let role: ProjectRole = "viewer";

            return h("div", { class: "group-card", dataset: { projectGroup: group.id } }, [
              h("div", { class: "group-head" }, [
                manage
                  ? textInput(
                      group.name,
                      (value) => {
                        const name = value.trim();
                        if (name === "" || name === group.name) return;
                        actions.run(async () => {
                          await state.client.renameProjectGroup(group.id, name);
                          await reload();
                        });
                      },
                      {
                        class: "group-name",
                        dataset: { focus: `projectGroup:${group.id}:name` },
                        attrs: { "aria-label": t("groups.name") },
                      },
                    )
                  : h("span", { class: "group-name", text: group.name }),
                h("span", {
                  class: "chip muted",
                  text: t("groups.projectCount", { count: inside.length }),
                }),
                iconButton(
                  "×",
                  t("groups.remove", { name: group.name }),
                  () => {
                    if (!confirm(t("groups.confirmDeleteProjectGroup", { name: group.name })))
                      return;
                    actions.run(async () => {
                      await state.client.deleteProjectGroup(group.id);
                      await reload();
                    });
                  },
                  !manage,
                ),
              ]),
              h("table", { class: "share-table" }, [
                h("tbody", {}, [
                  ...group.access.map((entry) =>
                    h("tr", { dataset: { principal: principalKey(entry.principal) } }, [
                      h("td", {}, [
                        principalName(state, entry.principal),
                        entry.principal.kind === "group"
                          ? h("span", { class: "muted", text: ` ${t("share.groupSuffix")}` })
                          : null,
                      ]),
                      h("td", {}, [
                        select(
                          entry.role,
                          ROLE_CHOICES(),
                          (next) => {
                            actions.run(async () => {
                              await state.client.setGroupAccess(group.id, entry.principal, next);
                              await reload();
                            });
                          },
                          {
                            dataset: {
                              focus: `projectGroup:${group.id}:${principalKey(entry.principal)}`,
                            },
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
                              await state.client.removeGroupAccess(group.id, entry.principal);
                              await reload();
                            });
                          },
                          !manage,
                        ),
                      ]),
                    ]),
                  ),
                ]),
              ]),
              manage && choices.length > 0
                ? h("div", { class: "inline-row", dataset: { add: "group-access" } }, [
                    select(
                      pick,
                      choices.map((choice) => ({
                        value: principalKey(choice.principal),
                        label: choice.label,
                      })),
                      (value) => {
                        pick = value;
                      },
                      { attrs: { "aria-label": t("share.who") } },
                    ),
                    select(
                      role,
                      ROLE_CHOICES(),
                      (value) => {
                        role = value;
                      },
                      { attrs: { "aria-label": t("share.role") } },
                    ),
                    button(t("share.add"), () => {
                      const chosen = choices.find(
                        (choice) => principalKey(choice.principal) === pick,
                      )?.principal;
                      if (chosen === undefined) return;
                      actions.run(async () => {
                        await state.client.setGroupAccess(group.id, chosen, role);
                        await reload();
                      });
                    }),
                  ])
                : null,
            ]);
          }),
        ),
    h("div", { class: "row-actions" }, [
      button(t("groups.addProjectGroup"), () => {
        actions.run(async () => {
          await state.client.createProjectGroup(newId(), t("groups.newProjectGroupName"));
          await reload();
        });
      }),
    ]),
  ]);
}

export function renderGroups(state: AppState, actions: AppActions): HTMLElement {
  return h("div", {}, [renderUserGroups(state, actions), renderProjectGroups(state, actions)]);
}
