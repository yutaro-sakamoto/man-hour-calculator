/**
 * いま開いているプロジェクトの共有。
 *
 * 配る相手はアカウントでもグループでもよい。グループに配っておくと、
 * 人の出入りのたびに全プロジェクトを触らなくて済む。
 */

import type { Principal, ProjectRole } from "../api/types.ts";
import {
  PROJECT_ROLES,
  principalKey,
  principalGroup,
  principalUser,
  samePrincipal,
} from "../api/types.ts";
import { canManage, type AppActions, type AppState } from "../app.ts";
import { t } from "../i18n.ts";
import { button, foldout, h, iconButton, select, type Child } from "./dom.ts";

const ROLE_CHOICES = (): { value: ProjectRole; label: string }[] =>
  [...PROJECT_ROLES].reverse().map((role) => ({ value: role, label: t(`role.${role}`) }));

/** 配った相手の表示名。 */
export function principalName(state: AppState, principal: Principal): string {
  if (principal.kind === "user") {
    return state.users.find((user) => user.id === principal.id)?.name ?? principal.id;
  }
  return state.userGroups.find((group) => group.id === principal.id)?.name ?? principal.id;
}

/** まだ配っていない相手 (アカウントとグループ)。 */
function candidates(
  state: AppState,
  already: Principal[],
): { principal: Principal; label: string }[] {
  const taken = new Set(already.map(principalKey));
  const list: { principal: Principal; label: string }[] = [];
  for (const user of state.users) {
    const principal = principalUser(user.id);
    if (!taken.has(principalKey(principal))) list.push({ principal, label: user.name });
  }
  for (const group of state.userGroups) {
    const principal = principalGroup(group.id);
    if (!taken.has(principalKey(principal))) {
      list.push({ principal, label: `${group.name} ${t("share.groupSuffix")}` });
    }
  }
  return list;
}

/**
 * 「共有」は畳んでおく。
 *
 * 既にグループと接続先は畳んであった (「一覧を主役にしたいので、管理まわりは
 * 畳んでおく」) のに、共有とアカウントだけ開いたままだった。**ローカルでは
 * ログインが無いので、ここで決めた権限はサーバに繋ぐまで効かない** —
 * その断りを、この節自身が本文で書いている。初めて開いた人がいちばん先に
 * 読むものが、いまは効かない機能の説明になっていた。
 */
function sharingPanel(state: AppState, children: Child[]): HTMLElement {
  return foldout(
    {
      id: "panel-sharing",
      title: t("share.heading"),
      open: state.openPanels["panel-sharing"] ?? false,
      onToggle: (open) => {
        state.openPanels["panel-sharing"] = open;
      },
    },
    children,
  );
}

export function renderSharing(state: AppState, actions: AppActions): HTMLElement {
  const open = state.open;
  if (open === null) {
    return sharingPanel(state, [h("p", { class: "empty", text: t("share.needProject") })]);
  }
  const manage = canManage(state) || state.me.systemRole === "admin";
  const choices = candidates(
    state,
    open.access.map((entry) => entry.principal),
  );

  const refresh = async (): Promise<void> => {
    const access = await state.client.listAccess(open.id);
    if (state.open) state.open.access = access;
    state.projects = await state.client.listProjects();
  };

  return sharingPanel(state, [
    h("p", { class: "hint", text: t("share.hint") }),
    state.client.remote ? null : h("p", { class: "hint", text: t("share.localHint") }),
    open.access.length === 0
      ? h("p", { class: "empty", text: t("share.notShared") })
      : h("table", { class: "share-table" }, [
          h("thead", {}, [
            h("tr", {}, [
              h("th", { text: t("share.who") }),
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
                    ? h("span", { class: "muted", text: ` ${t("share.groupSuffix")}` })
                    : null,
                  samePrincipal(entry.principal, principalUser(state.me.id))
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
    manage && choices.length > 0
      ? h("div", { class: "row-actions" }, [
          (() => {
            const first = choices[0];
            let pick = first === undefined ? "" : principalKey(first.principal);
            let role: ProjectRole = "editor";
            const whoSelect = select(
              pick,
              choices.map((choice) => ({
                value: principalKey(choice.principal),
                label: choice.label,
              })),
              (value) => {
                pick = value;
              },
              { attrs: { "aria-label": t("share.who") }, dataset: { focus: "share:who" } },
            );
            const roleSelect = select(
              role,
              ROLE_CHOICES(),
              (value) => {
                role = value;
              },
              { attrs: { "aria-label": t("share.role") } },
            );
            return h("div", { class: "inline-row", dataset: { add: "share" } }, [
              whoSelect,
              roleSelect,
              button(
                t("share.add"),
                () => {
                  const chosen = choices.find(
                    (choice) => principalKey(choice.principal) === pick,
                  )?.principal;
                  if (chosen === undefined) return;
                  actions.run(async () => {
                    await state.client.setAccess(open.id, chosen, role);
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
