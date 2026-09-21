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
  // サーバが配っている画面なら、その出どころを既定にする。いま自分が開いて
  // いる場所を打ち直させるのは無駄だし、同一オリジンなら確実に通る。
  const servedFrom =
    location.protocol === "http:" || location.protocol === "https:" ? location.origin : "";
  // 書きかけは状態に置く。クロージャに置くと、関係のない再描画
  // (自動保存の完了、プロジェクトを開く) で消える。
  const draft = state.connectionDraft ?? {
    baseUrl: saved?.baseUrl ?? servedFrom,
    token: saved?.token ?? "",
  };
  // **いまの書きかけ**に重ねる。描画時の値に重ねると、片方を打ち直した
  // ときにもう片方が古い値へ巻き戻る。
  const keep = (change: Partial<typeof draft>): void => {
    state.connectionDraft = { ...(state.connectionDraft ?? draft), ...change };
  };

  const urlInput = textInput(
    draft.baseUrl,
    (value) => {
      keep({ baseUrl: value });
    },
    {
      dataset: { focus: "connection:url" },
      attrs: { placeholder: "http://mhc.example.internal:8080", "aria-label": t("conn.url") },
    },
  );
  const tokenInput = h("input", {
    attrs: {
      type: "password",
      value: draft.token,
      autocomplete: "off",
      "aria-label": t("conn.token"),
    },
    dataset: { focus: "connection:token" },
    on: {
      input: (event) => {
        keep({ token: (event.target as HTMLInputElement).value });
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
            // 書きかけは状態から読む。押した時点の中身が要る。
            const current = state.connectionDraft ?? draft;
            const baseUrl = normalizeBaseUrl(current.baseUrl);
            if (baseUrl === null) {
              // 描き直しても書きかけは消えない (`connectionDraft`)。
              actions.patch((s2) => {
                s2.status = { text: t("conn.badUrl"), tone: "error" };
              });
              return;
            }
            actions.run(async () => {
              await actions.connect({ baseUrl, token: current.token.trim() });
              // 繋ぎ終えたら書きかけは捨てる。保存された値が正本。
              state.connectionDraft = null;
            });
          },
          { class: "primary", dataset: { action: "connect" } },
        ),
        button(
          t("conn.disconnect"),
          () => {
            actions.run(async () => {
              await actions.connect(null);
              state.connectionDraft = null;
            });
          },
          { attrs: { disabled: !state.client.remote }, dataset: { action: "disconnect" } },
        ),
      ]),
    ],
  );
}
