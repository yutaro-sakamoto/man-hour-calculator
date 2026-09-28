/**
 * タスク 1 件を書き換えるための、共用の入力欄。
 *
 * タスク一覧の行と詳細の窓で**同じ書き込み口**を使う。2 か所に同じ
 * `Object.assign` を書くと、片方だけ丸め方や下限が変わって静かにずれる。
 */

import type { AppActions, AppState } from "../app.ts";
import { t } from "../i18n.ts";
import { memberLabel } from "../model/members.ts";
import { PRIORITIES, type Priority, type Task } from "../types.ts";
import { formatNumber, parseEffort } from "../format.ts";
import { lang } from "../i18n.ts";
import { button, dateInput, h, numberInput, select, textInput } from "./dom.ts";

/** タスクを書き換える口。添字ではなく id で引く (並べ替えでずれるため)。 */
export type SetTask = (change: Partial<Task>) => void;

export function taskWriter(actions: AppActions, taskId: string): SetTask {
  return (change) => {
    // `edit` はその場で描き直さない。1 打鍵ごとに入力欄を作り直すと、
    // 数値の欄はキャレットを失う (`AppActions.edit` を参照)。
    actions.edit((document) => {
      const target = document.tasks.find((task) => task.id === taskId);
      if (target) Object.assign(target, change);
    });
  };
}

export function priorityChoices(): { value: Priority; label: string }[] {
  return PRIORITIES.map((value) => ({ value, label: t(`priority.${value}`) }));
}

/** 担当者の選択肢。未割当を先頭に置く。 */
export function assigneeChoices(state: AppState): { value: string; label: string }[] {
  return [
    { value: "", label: t("members.unassigned") },
    ...state.document.calendar.members.map((member, index) => ({
      value: member.id,
      label: memberLabel(member, index),
    })),
  ];
}

/**
 * 入力欄をひとそろい。
 *
 * `focusPrefix` で `data-focus` の名前空間を分ける。一覧と詳細で同じ鍵を
 * 使うと、詳細で入力している最中に後ろの表へカーソルが飛ぶ
 * (`restoreFocus` は最初に一致した要素を拾うため)。
 */
export interface FieldOptions {
  focusPrefix: string;
  label: string;
}

export function nameField(task: Task, set: SetTask, options: FieldOptions): HTMLElement {
  return textInput(
    task.name,
    (value) => {
      set({ name: value });
    },
    {
      dataset: { focus: `${options.focusPrefix}:name` },
      attrs: { placeholder: t("col.name"), "aria-label": t("col.name") },
    },
  );
}

export function priorityField(task: Task, set: SetTask, options: FieldOptions): HTMLElement {
  return select(
    task.priority,
    priorityChoices(),
    (value) => {
      set({ priority: value });
    },
    {
      class: `priority priority-${task.priority}`,
      dataset: { focus: `${options.focusPrefix}:priority` },
      attrs: { "aria-label": t("col.priority") },
    },
  );
}

export function groupField(task: Task, set: SetTask, options: FieldOptions): HTMLElement {
  return textInput(
    task.group,
    (value) => {
      set({ group: value });
    },
    {
      class: "group",
      dataset: { focus: `${options.focusPrefix}:group` },
      attrs: { "aria-label": t("col.group"), list: "group-options" },
    },
  );
}

export function estimateField(
  task: Task,
  key: "min" | "likely" | "max",
  set: SetTask,
  options: FieldOptions & { invalid?: boolean },
): HTMLElement {
  return numberInput(
    task[key],
    (value) => {
      set({ [key]: value });
    },
    {
      dataset: { focus: `${options.focusPrefix}:${key}` },
      attrs: {
        min: 0,
        step: 0.5,
        "aria-label": `${options.label} — ${t(`col.${key}`)}`,
        "aria-invalid": options.invalid ?? false,
      },
    },
  );
}

export function startField(task: Task, set: SetTask, options: FieldOptions): HTMLElement {
  return dateInput(
    task.startDate,
    (value) => {
      set({ startDate: value });
    },
    {
      dataset: { focus: `${options.focusPrefix}:start` },
      attrs: { "aria-label": `${options.label} — ${t("col.start")}` },
    },
  );
}

export function endField(task: Task, set: SetTask, options: FieldOptions): HTMLElement {
  return dateInput(
    task.endDate,
    (value) => {
      set({ endDate: value });
    },
    {
      dataset: { focus: `${options.focusPrefix}:end` },
      attrs: { "aria-label": `${options.label} — ${t("col.end")}` },
    },
  );
}

/** 進捗率は 0〜100。ここで挟むので、0〜1 と取り違えようがない。 */
export function progressField(task: Task, set: SetTask, options: FieldOptions): HTMLElement {
  return numberInput(
    task.progress,
    (value) => {
      set({ progress: Math.min(100, Math.max(0, Number(value) || 0)) });
    },
    {
      dataset: { focus: `${options.focusPrefix}:progress` },
      attrs: {
        min: 0,
        max: 100,
        step: 5,
        "aria-label": `${options.label} — ${t("col.progress")}`,
      },
    },
  );
}

/**
 * 実績工数の欄。人日 (`3.5`) でも時間 (`28h`) でも書ける。
 *
 * 書いたままの文字で持つ (`Task.spent`)。読めない形なら赤くするだけで、
 * 計算は止めない — 見積もりと違い、無くても推し量れるものなので。
 */
export function spentField(
  task: Task,
  set: SetTask,
  options: FieldOptions & { hoursPerDay: number },
): HTMLElement {
  const parsed = parseEffort(task.spent, options.hoursPerDay);
  return textInput(
    task.spent,
    (value) => {
      set({ spent: value });
    },
    {
      class: "num",
      dataset: { focus: `${options.focusPrefix}:spent` },
      attrs: {
        inputmode: "decimal",
        placeholder: "3.5 / 28h",
        "aria-label": `${options.label} — ${t("col.spent")}`,
        "aria-invalid": parsed !== null && Number.isNaN(parsed),
      },
    },
  );
}

/**
 * 今週の作業時間を、これまでの実績工数に足し込む。
 *
 * 日報は「今週 6 時間」の形で届く。合計を暗算して書き直させると、
 * 足し忘れ・二重に足すが起きる。時間で書かれた実績には時間で足す
 * (`28h` + 6 → `34h`)。人日で書かれていれば人日に直して足す。
 */
export function addHoursField(
  state: AppState,
  task: Task,
  actions: AppActions,
  options: FieldOptions & { hoursPerDay: number },
): HTMLElement {
  const hours = h("input", {
    class: "num",
    dataset: { focus: `${options.focusPrefix}:addHours` },
    attrs: {
      type: "number",
      min: 0,
      step: 0.5,
      value: state.hoursDraft?.taskId === task.id ? state.hoursDraft.value : "",
      "aria-label": `${options.label} — ${t("detail.addHours")}`,
    },
    on: {
      input: (event) => {
        // 描き直さない。キャレットを失わないように、値だけ持っておく。
        state.hoursDraft = { taskId: task.id, value: (event.target as HTMLInputElement).value };
      },
      keydown: (event) => {
        if (event.key === "Enter") add();
      },
    },
  });
  function add(): void {
    const extra = state.hoursDraft?.taskId === task.id ? Number(state.hoursDraft.value) : 0;
    if (!(extra > 0) || !(options.hoursPerDay > 0)) return;
    state.hoursDraft = null;
    actions.mutate((document) => {
      const target = document.tasks.find((item) => item.id === task.id);
      if (target) target.spent = addHours(target.spent, extra, options.hoursPerDay);
    });
  }
  return h("span", { class: "inline-add" }, [
    hours,
    button(t("detail.addHoursButton"), add, { class: "small" }),
  ]);
}

/** `addHoursField` の足し算。読めない実績には足さずに、足す分だけにする。 */
export function addHours(current: string, hours: number, hoursPerDay: number): string {
  const inHours = /(h|hr|hrs|時間)\s*$/i.test(current.normalize("NFKC").trim());
  const days = parseEffort(current, hoursPerDay);
  const base = days !== null && Number.isFinite(days) ? days : 0;
  if (inHours) return `${formatPlain(base * hoursPerDay + hours)}h`;
  return formatPlain(base + hours / hoursPerDay);
}

/** 桁区切りを付けない、小数 2 桁までの数。欄に書き戻すため。 */
function formatPlain(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 実績工数の読み取り表示 (人日)。 */
export function spentReadout(task: Task, hoursPerDay: number): string | null {
  const days = parseEffort(task.spent, hoursPerDay);
  return days === null || Number.isNaN(days) ? null : formatNumber(days, lang(), 1);
}

export function assigneeField(
  state: AppState,
  task: Task,
  set: SetTask,
  options: FieldOptions,
): HTMLElement {
  return select(
    task.assigneeId ?? "",
    assigneeChoices(state),
    (value) => {
      set({ assigneeId: value === "" ? null : value });
    },
    {
      class: "assignee",
      dataset: { focus: `${options.focusPrefix}:assignee` },
      attrs: { "aria-label": `${options.label} — ${t("col.assignee")}` },
    },
  );
}

/** グループ名の候補。詳細の窓でも一覧と同じ候補が出るように。 */
export function groupOptions(names: readonly string[]): HTMLElement {
  return h(
    "datalist",
    { id: "group-options" },
    names.map((name) => h("option", { attrs: { value: name } })),
  );
}
