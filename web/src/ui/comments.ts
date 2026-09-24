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

import { LocalApiClient } from "../api/local.ts";
import {
  MAX_ATTACHMENTS_PER_COMMENT,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type Comment,
} from "../api/types.ts";
import type { AppActions, AppState } from "../app.ts";
import { lang, t } from "../i18n.ts";
import {
  attachmentMarkdown,
  attachmentUrl,
  formatBytes,
  isImage,
  readAttachments,
  type RejectReason,
} from "../model/attachments.ts";
import { renderMarkdown, type AttachmentSource } from "../model/markdown.ts";
import { newId } from "../model/project.ts";
import { button, h, iconButton } from "./dom.ts";

/** 添付を id で引く口。本文のなかの `![](attachment:<id>)` を解く。 */
function sourceOf(attachments: readonly Attachment[]): AttachmentSource {
  return (id) => {
    const found = attachments.find((item) => item.id === id);
    return found === undefined ? null : { url: attachmentUrl(found), filename: found.filename };
  };
}

/**
 * 本文に出てこなかった添付の一覧。
 *
 * 画像は本文のなかに出るので、ここには出さない。二重に出すと、同じものが
 * 上下に並んで何が起きたのか分からなくなる。
 */
function renderAttachmentList(
  body: string,
  attachments: readonly Attachment[],
): HTMLElement | null {
  const left = attachments.filter((item) => !body.includes(`attachment:${item.id}`));
  if (left.length === 0) return null;
  return h(
    "div",
    { class: "attachment-list" },
    left.map((item) =>
      h("a", {
        class: "attachment-chip",
        text: `${item.filename} (${formatBytes(item.size)})`,
        attrs: {
          href: attachmentUrl(item),
          download: item.filename,
          "data-attachment": item.id,
        },
      }),
    ),
  );
}

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
        draft.commentAttachments = [];
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
                // 書き直しでは、いまの添付がそのまま書きかけの添付になる。
                // 送られた一覧が新しい一覧になるので、持ち越さないと消える。
                draft.commentAttachments = [...comment.attachments];
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
    renderMarkdown(comment.body, sourceOf(comment.attachments)),
    renderAttachmentList(comment.body, comment.attachments),
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

  /** 選ばれたファイルを書きかけの添付に足す。断った理由は状態表示に出す。 */
  const attach = (files: readonly File[]): void => {
    if (files.length === 0) return;
    actions.run(async () => {
      const { accepted, rejected } = await readAttachments(
        files,
        state.commentAttachments,
        newId,
        // サーバに繋いでいるときは手元の容量は関係ない。
        state.client.remote ? null : LocalApiClient.remainingBytes(),
      );
      state.commentAttachments = [...state.commentAttachments, ...accepted];
      // 画像だけ本文に差し込む。それ以外はコメントの下に、
      // 押せば落とせるリンクとして出る。
      const marks = accepted
        .map(attachmentMarkdown)
        .filter((mark): mark is string => mark !== null)
        .join("\n");
      if (marks !== "") {
        const body = state.commentDraft;
        state.commentDraft = body === "" ? marks : `${body}\n\n${marks}`;
      }
      if (rejected.length > 0) {
        const first = rejected[0];
        if (first !== undefined) throw new AttachRejected(first.filename, first.reason);
      }
    });
  };

  const fileInput = h("input", {
    class: "attach-input",
    attrs: { type: "file", multiple: true, "aria-label": t("comments.attach") },
    style: { display: "none" },
    on: {
      change: (event) => {
        const input = event.target as HTMLInputElement;
        const files = Array.from(input.files ?? []);
        input.value = "";
        attach(files);
      },
    },
  });

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
      // 画面の写真は、たいてい貼り付けで渡ってくる。
      paste: (event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        attach(files);
      },
      dragover: (event) => {
        event.preventDefault();
      },
      drop: (event) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        attach(files);
      },
    },
  });
  area.value = draft;

  const submit = (): void => {
    const body = state.commentDraft.trim();
    if (open === null) return;
    // 添付だけを送ることはできない。黙って何も起きないと、押したのに
    // 反応が無いようにしか見えないので、理由を出す。
    if (body === "") {
      actions.run(() => Promise.reject(new Error(t("comments.needBody"))));
      return;
    }
    actions.run(async () => {
      const attachments = state.commentAttachments;
      if (editing === null) {
        await state.client.postComment(open.id, newId(), body, taskId ?? undefined, attachments);
      } else {
        await state.client.editComment(editing, body, attachments);
      }
      await reload();
      state.commentDraft = "";
      state.commentAttachments = [];
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
            : renderMarkdown(draft, sourceOf(state.commentAttachments)),
        ])
      : area,
    fileInput,
    // 付けたものを一覧にする。外すと本文の差し込みも一緒に消す
    // (本文に綴りだけ残ると、出どころの無い壊れた印になる)。
    state.commentAttachments.length === 0
      ? null
      : h(
          "div",
          { class: "attachment-drafts" },
          state.commentAttachments.map((item) =>
            h("span", { class: "chip", dataset: { draftAttachment: item.id } }, [
              isImage(item)
                ? h("img", {
                    class: "attachment-thumb",
                    attrs: { src: attachmentUrl(item), alt: item.filename },
                  })
                : null,
              `${item.filename} (${formatBytes(item.size)})`,
              iconButton("×", t("comments.detach", { name: item.filename }), () => {
                actions.patch((d) => {
                  d.commentAttachments = d.commentAttachments.filter(
                    (other) => other.id !== item.id,
                  );
                  d.commentDraft = d.commentDraft
                    .split("\n")
                    .filter((line) => !line.includes(`attachment:${item.id}`))
                    .join("\n")
                    .trim();
                });
              }),
            ]),
          ),
        ),
    h("div", { class: "row-actions" }, [
      button(
        t("comments.attach"),
        () => {
          fileInput.click();
        },
        {
          dataset: { action: "attach" },
          attrs: {
            disabled: state.commentAttachments.length >= MAX_ATTACHMENTS_PER_COMMENT,
          },
          title: t("comments.attachHint", {
            count: MAX_ATTACHMENTS_PER_COMMENT,
            size: formatBytes(MAX_ATTACHMENT_BYTES),
          }),
        },
      ),
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
              d.commentAttachments = [];
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
      draft.commentAttachments = [];
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

  // 開いた直後は書く欄に合わせる (書けないときは閉じるボタン)。ほかの窓
  // (タスクの詳細・予定) と同じ。これが無いと、フォーカスが窓の後ろに残り、
  // Esc で閉じられず、キーボードと読み上げの利用者は窓の中に入れなかった
  // (モンキーテストで見つかった)。すでに窓のなかを触っているときは奪わない。
  queueMicrotask(() => {
    if (panel.contains(document.activeElement)) return;
    (
      panel.querySelector<HTMLElement>(".comment-input") ??
      panel.querySelector<HTMLElement>("button")
    )?.focus();
  });

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

/**
 * 付けられなかったことを伝えるための失敗。
 *
 * `actions.run` が受け取って状態表示に出す。ここで `alert` を出さないのは、
 * 残りの添付は受け付けているため (全部が駄目だったとは限らない)。
 */
class AttachRejected extends Error {
  constructor(filename: string, reason: RejectReason) {
    super(t(`comments.reject.${reason}`, { name: filename }));
  }
}
