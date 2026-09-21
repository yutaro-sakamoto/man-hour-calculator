/**
 * アカウントの管理。
 *
 * 「人」が 2 種類あるうちの、**操作する主体**のほう。工数を消化する
 * 人員 (`Member`) とは別で、1 対 1 とは限らない。
 */

import type { SystemRole, User } from "../api/types.ts";
import type { AppActions, AppState } from "../app.ts";
import { LocalApiClient } from "../api/local.ts";
import { t } from "../i18n.ts";
import { newId } from "../model/project.ts";
import { button, card, committedTextInput, h, iconButton, select } from "./dom.ts";

const SYSTEM_ROLE_CHOICES = (): { value: SystemRole; label: string }[] =>
  (["member", "admin"] as const).map((role) => ({
    value: role,
    label: t(`systemRole.${role}`),
  }));

function renderAccountRow(state: AppState, actions: AppActions, user: User): HTMLTableRowElement {
  const admin = state.me.systemRole === "admin";
  const isMe = user.id === state.me.id;

  return h("tr", { dataset: { account: user.id } }, [
    h("td", {}, [
      admin || isMe
        ? committedTextInput(
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
          // 権限もグループ所属も一緒に消える。取り消せないので先に問う。
          if (!confirm(t("accounts.confirmDelete", { name: user.name }))) return;
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

export function renderAccounts(state: AppState, actions: AppActions): HTMLElement {
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
