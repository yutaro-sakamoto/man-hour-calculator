/** 人員タブ。人と、その人が働ける時間帯を編集する。 */

import type { AppActions, AppState } from "../app.ts";
import { formatDuration, weekdayLabels } from "../format.ts";
import { lang, t } from "../i18n.ts";
import { memberLabel, weeklyMinutes } from "../model/members.ts";
import { createMember } from "../model/project.ts";
import type { Member, WorkWindow } from "../types.ts";
import { button, card, checkbox, h, iconButton, numberInput, textInput } from "./dom.ts";

const OFF: WorkWindow = { start: "00:00", end: "00:00" };
const DEFAULT_WINDOW: WorkWindow = { start: "09:00", end: "18:00" };

function isWorking(window: WorkWindow): boolean {
  return window.start !== window.end;
}

/** 曜日 1 つぶんの入力 (稼働チェック + 開始 + 終了)。 */
function weekdayCell(
  member: Member,
  index: number,
  weekday: number,
  label: string,
  actions: AppActions,
): HTMLElement {
  const window = member.workdays[weekday] ?? OFF;
  const patch = (next: WorkWindow): void => {
    actions.mutate((document) => {
      const target = document.calendar.members[index];
      if (target) target.workdays[weekday] = next;
    });
  };
  const timeInput = (value: string, onChange: (value: string) => void, which: string) =>
    h("input", {
      dataset: { focus: `${member.id}:${String(weekday)}:${which}` },
      attrs: {
        type: "time",
        // 5 分単位で指定できるようにする。
        step: 300,
        value,
        disabled: !isWorking(window),
        "aria-label": `${memberLabel(member, index)} ${label} ${which}`,
      },
      on: {
        change: (event) => {
          onChange((event.target as HTMLInputElement).value);
        },
      },
    });

  return h("div", { class: `weekday-cell${isWorking(window) ? "" : " off"}` }, [
    h("label", { class: "weekday-head" }, [
      checkbox(
        isWorking(window),
        (checked) => {
          patch(checked ? DEFAULT_WINDOW : OFF);
        },
        {
          dataset: { focus: `${member.id}:${String(weekday)}:on` },
          attrs: { "aria-label": `${memberLabel(member, index)} ${label}` },
        },
      ),
      h("span", { text: label }),
    ]),
    timeInput(
      window.start,
      (value) => {
        patch({ start: value, end: window.end });
      },
      "start",
    ),
    timeInput(
      window.end,
      (value) => {
        patch({ start: window.start, end: value });
      },
      "end",
    ),
  ]);
}

function renderMember(
  state: AppState,
  actions: AppActions,
  member: Member,
  index: number,
): HTMLElement {
  const labels = weekdayLabels(lang());
  const name = memberLabel(member, index);
  const assigned = state.document.tasks.filter((task) => task.assigneeId === member.id).length;
  const weekly = weeklyMinutes(member);

  return h("div", { class: "member-card", dataset: { member: member.id } }, [
    h("div", { class: "member-head" }, [
      textInput(
        member.name,
        (value) => {
          actions.mutate((document) => {
            const target = document.calendar.members[index];
            if (target) target.name = value;
          });
        },
        {
          class: "member-name",
          dataset: { focus: `${member.id}:name` },
          attrs: { placeholder: t("members.name"), "aria-label": t("members.name") },
        },
      ),
      h("label", { class: "inline-field" }, [
        h("span", { text: t("members.break") }),
        numberInput(
          member.breakMinutes,
          (value) => {
            actions.mutate((document) => {
              const target = document.calendar.members[index];
              if (target) target.breakMinutes = Math.max(0, Number(value) || 0);
            });
          },
          {
            dataset: { focus: `${member.id}:break` },
            attrs: { min: 0, max: 480, step: 5, "aria-label": t("members.break") },
          },
        ),
      ]),
      h("span", {
        class: `chip${weekly === 0 ? " warn" : ""}`,
        text: t("members.weekly", { value: formatDuration(weekly, lang()) }),
      }),
      h("span", { class: "chip muted", text: t("members.tasks", { count: assigned }) }),
      iconButton("×", t("members.remove", { name }), () => {
        // 担当していたタスクは未割当に戻り、予定の参加者からも外れる。
        if (!confirm(t("members.confirmDelete", { name, count: assigned }))) return;
        actions.mutate((document) => {
          document.calendar.members.splice(index, 1);
          // 担当が消えたタスクは未割当に戻す。
          for (const task of document.tasks) {
            if (task.assigneeId === member.id) task.assigneeId = null;
          }
          for (const event of document.calendar.events) {
            event.memberIds = event.memberIds.filter((id) => id !== member.id);
          }
        });
      }),
    ]),
    h(
      "div",
      { class: "weekday-grid" },
      labels.map((label, weekday) => weekdayCell(member, index, weekday, label, actions)),
    ),
  ]);
}

export function renderMembersTab(state: AppState, actions: AppActions): HTMLElement {
  const members = state.document.calendar.members;
  const someoneIdle = members.some((member) => weeklyMinutes(member) === 0);

  return card(t("members.heading"), [
    h("p", { class: "hint", text: t("members.hint") }),
    members.length === 0
      ? h("p", { class: "empty", text: t("members.empty") })
      : h(
          "div",
          { class: "member-list" },
          members.map((member, index) => renderMember(state, actions, member, index)),
        ),
    someoneIdle ? h("p", { class: "hint warn", text: t("members.noCapacity") }) : null,
    h("div", { class: "row-actions" }, [
      button(
        t("members.add"),
        () => {
          actions.mutate((document) => {
            const first = document.calendar.members[0];
            document.calendar.members.push(
              createMember(
                "",
                first
                  ? {
                      workdays: first.workdays.map((w) => ({ ...w })),
                      breakMinutes: first.breakMinutes,
                    }
                  : {},
              ),
            );
          });
        },
        { class: "primary" },
      ),
    ]),
    h("p", { class: "hint", text: t("members.unassignedHint") }),
  ]);
}
