/**
 * コメント欄。
 *
 * プロジェクト宛てと、タスク 1 件宛ての 2 通りがあるが、見た目も操作も
 * 同じなので窓は 1 つにしてある。開くときに宛先を決めるだけ。
 *
 * 本文は Markdown。**組み立てるのは画面側**で、保存されているのは文字列。
 * 他人が書いた文字列なので、HTML は一切組み立てずに DOM として並べる
 * (`web/src/model/markdown.ts` を参照)。
 */

import type { Comment } from "../api/types.ts";
import type { AppActions, AppState } from "../app.ts";
import { lang, t } from "../i18n.ts";
import { renderMarkdown } from "../model/markdown.ts";
import { newId } from "../model/project.ts";
import { button, h, iconButton } from "./dom.ts";

/** その宛先に付いているコメントの数。 */
export function commentCount(state: AppState, taskId: string | null): number {
  return state.comments.filter((comment) => (comment.taskId ?? null) === taskId).length;
}

/** コメント欄を開くボタン。件数も出す。 */
export function commentButton(
  state: AppState,
  actions: AppActions,
  taskId: string | null,
  label: string,
): HTMLElement {
  const count = commentCount(state, taskId);
  return button(
    count === 0 ? label : `${label} ${String(count)}`,
    () => {
      actions.patch((draft) => {
        draft.commentScope = { taskId };
        draft.commentDraft = "";
        draft.commentPreview = false;
        draft.editingCommentId = null;
      });
    },
    {
      class: `comment-open${count > 0 ? " has-comments" : ""}`,
      title: t("comments.open"),
      dataset: { comments: String(count) },
    },
  );
}

function formatMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(lang() === "ja" ? "ja-JP" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function authorName(state: AppState, id: string): string {
  return state.users.find((user) => user.id === id)?.name ?? id;
}

/** コメント 1 件。 */
function renderComment(state: AppState, actions: AppActions, comment: Comment): HTMLElement {
  const mine = comment.author === state.me.id;
  // 消せるのは本人か、プロジェクトの所有者。
  const canRemove = mine || state.open?.role === "owner" || state.me.systemRole === "admin";

  const reload = async (): Promise<void> => {
    const open = state.open;
    if (open === null) return;
    state.comments = await state.client.listComments(open.id);
  };

  return h("article", { class: "comment", dataset: { comment: comment.id } }, [
    h("header", { class: "comment-head" }, [
      h("strong", { class: "comment-author", text: authorName(state, comment.author) }),
      h("span", { class: "comment-time", text: formatMoment(comment.createdAt) }),
      comment.updatedAt === null
        ? null
        : h("span", { class: "comment-edited", text: t("comments.edited") }),
      h("span", { class: "spacer" }),
      mine
        ? button(
            t("comments.edit"),
            () => {
              actions.patch((draft) => {
                draft.editingCommentId = comment.id;
                draft.commentDraft = comment.body;
                draft.commentPreview = false;
              });
            },
            { class: "icon-text" },
          )
        : null,
      canRemove
        ? iconButton("×", t("comments.remove"), () => {
            if (!confirm(t("comments.confirmDelete"))) return;
            actions.run(async () => {
              await state.client.deleteComment(comment.id);
              await reload();
            });
          })
        : null,
    ]),
    renderMarkdown(comment.body),
  ]);
}

/** 書き込む欄。書き直しているときは、そのコメントの内容が入っている。 */
function renderComposer(state: AppState, actions: AppActions, taskId: string | null): HTMLElement {
  const open = state.open;
  const editing = state.editingCommentId;
  const draft = state.commentDraft;

  const reload = async (): Promise<void> => {
    if (open === null) return;
    state.comments = await state.client.listComments(open.id);
  };

  const area = h("textarea", {
    class: "comment-input",
    dataset: { focus: "comment:draft" },
    attrs: {
      rows: 4,
      placeholder: t("comments.placeholder"),
      "aria-label": t("comments.body"),
    },
    on: {
      input: (event) => {
        // ここでは描き直さない。1 文字ごとに組み直すと重いし、
        // 入力欄の位置も乱れる。値は状態に控えるだけにする。
        state.commentDraft = (event.target as HTMLTextAreaElement).value;
      },
    },
  });
  area.value = draft;

  const submit = (): void => {
    const body = state.commentDraft.trim();
    if (body === "" || open === null) return;
    actions.run(async () => {
      if (editing === null) {
        await state.client.postComment(open.id, newId(), body, taskId ?? undefined);
      } else {
        await state.client.editComment(editing, body);
      }
      await reload();
      state.commentDraft = "";
      state.editingCommentId = null;
      state.commentPreview = false;
    });
  };

  return h("div", { class: "comment-composer" }, [
    h("div", { class: "composer-tabs", attrs: { role: "group" } }, [
      button(
        t("comments.write"),
        () => {
          actions.patch((d) => {
            d.commentPreview = false;
          });
        },
        { attrs: { "aria-pressed": !state.commentPreview } },
      ),
      button(
        t("comments.preview"),
        () => {
          actions.patch((d) => {
            d.commentPreview = true;
          });
        },
        { attrs: { "aria-pressed": state.commentPreview } },
      ),
      h("span", { class: "spacer" }),
      h("span", { class: "hint", text: t("comments.markdownHint") }),
    ]),
    state.commentPreview
      ? h("div", { class: "comment-preview" }, [
          draft.trim() === ""
            ? h("p", { class: "empty", text: t("comments.nothingToPreview") })
            : renderMarkdown(draft),
        ])
      : area,
    h("div", { class: "row-actions" }, [
      button(editing === null ? t("comments.post") : t("comments.update"), submit, {
        class: "primary",
        dataset: { action: "post-comment" },
      }),
      editing === null
        ? null
        : button(t("comments.cancelEdit"), () => {
            actions.patch((d) => {
              d.editingCommentId = null;
              d.commentDraft = "";
            });
          }),
    ]),
  ]);
}

/** コメントの窓。開いていなければ `null`。 */
export function renderCommentsModal(state: AppState, actions: AppActions): HTMLElement | null {
  const scope = state.commentScope;
  const open = state.open;
  if (scope === null || open === null) return null;

  const taskId = scope.taskId;
  const shown = state.comments.filter((comment) => (comment.taskId ?? null) === taskId);
  const heading =
    taskId === null
      ? t("comments.forProject", { name: open.name })
      : t("comments.forTask", {
          name:
            state.document.tasks.find((item) => item.id === taskId)?.name ?? t("tasks.untitled"),
        });

  const close = (): void => {
    actions.patch((draft) => {
      draft.commentScope = null;
      draft.editingCommentId = null;
      draft.commentDraft = "";
    });
  };

  const panel = h(
    "div",
    {
      class: "modal-card comments-card",
      attrs: { role: "dialog", "aria-modal": "true", "aria-label": heading },
    },
    [
      h("div", { class: "event-head" }, [
        h("strong", { class: "comments-heading", text: heading }),
        iconButton("×", t("comments.close"), close),
      ]),
      shown.length === 0
        ? h("p", { class: "empty", text: t("comments.none") })
        : h(
            "div",
            { class: "comment-list" },
            shown.map((comment) => renderComment(state, actions, comment)),
          ),
      renderComposer(state, actions, taskId),
    ],
  );

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
