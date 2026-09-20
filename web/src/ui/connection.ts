/**
 * サーバへの接続先。
 *
 * 入れればサーバに繋ぎ、外せば同じ HTML の WASM に戻る。どちらでも
 * 画面から見える口は同じなので、行き来しても使い勝手は変わらない。
 *
 * トークンはこの端末にしか残らない。共有端末で使ったら「切断」で消すこと。
 */

import type { AppActions, AppState } from "../app.ts";
import { t } from "../i18n.ts";
import { loadConnection, normalizeBaseUrl } from "../model/connection.ts";
import { button, field, foldout, h, textInput } from "./dom.ts";

export function renderConnection(state: AppState, actions: AppActions): HTMLElement {
  const saved = loadConnection();
  let url = saved?.baseUrl ?? "";
  let token = saved?.token ?? "";

  const urlInput = textInput(
    url,
    (value) => {
      url = value;
    },
    {
      dataset: { focus: "connection:url" },
      attrs: { placeholder: "http://mhc.example.internal:8080", "aria-label": t("conn.url") },
    },
  );
  const tokenInput = h("input", {
    attrs: { type: "password", value: token, autocomplete: "off", "aria-label": t("conn.token") },
    dataset: { focus: "connection:token" },
    on: {
      input: (event) => {
        token = (event.target as HTMLInputElement).value;
      },
    },
  });

  return foldout(
    {
      id: "connection",
      title: t("conn.heading"),
      open: state.openPanels.connection ?? false,
      onToggle: (open) => {
        state.openPanels.connection = open;
      },
      badge: h("span", {
        class: `chip${state.client.remote ? "" : " muted"}`,
        text: state.client.remote
          ? t("api.connectedTo", { target: state.client.label })
          : t("api.local"),
      }),
    },
    [
      h("p", { class: "hint", text: t("conn.hint") }),
      field(t("conn.url"), urlInput),
      field(t("conn.token"), tokenInput, t("conn.tokenHint")),
      h("div", { class: "row-actions" }, [
        button(
          t("conn.connect"),
          () => {
            const baseUrl = normalizeBaseUrl(url);
            if (baseUrl === null) {
              actions.patch((draft) => {
                draft.status = { text: t("conn.badUrl"), tone: "error" };
              });
              return;
            }
            actions.run(async () => {
              await actions.connect({ baseUrl, token: token.trim() });
            });
          },
          { class: "primary", dataset: { action: "connect" } },
        ),
        button(
          t("conn.disconnect"),
          () => {
            actions.run(async () => {
              await actions.connect(null);
            });
          },
          { attrs: { disabled: !state.client.remote }, dataset: { action: "disconnect" } },
        ),
      ]),
    ],
  );
}
