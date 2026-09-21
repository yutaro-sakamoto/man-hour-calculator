/**
 * カレンダータブ。
 *
 * 予定は**月表示の升のなか**に出す。別に一覧を持つと、「9/28 に何がある
 * のか」を知るために 2 か所を見比べることになる。予定を押せばその場で
 * 直せて、空いているところを押せばその日に足せる。
 *
 * 升には稼働量も出る。予定を入れると減る量がその場で見えるので、
 * 「この打ち合わせを動かすとどれくらい楽になるか」が分かる。
 */

import { DAY_FLAG } from "../abi.ts";
import type { AppActions, AppState } from "../app.ts";
import {
  dayFromIso,
  formatDayShort,
  formatMonth,
  formatNumber,
  isoFromDay,
  monthBounds,
  weekdayLabels,
} from "../format.ts";
import { lang, t } from "../i18n.ts";
import { occurrencesOn, shortTime, type Occurrence } from "../model/events.ts";
import { memberLabel } from "../model/members.ts";
import { newId } from "../model/project.ts";
import { isNonWorkingDay } from "../model/schedule.ts";
import type { CalendarEventItem } from "../types.ts";
import { memberSlice } from "../wasm.ts";
import {
  button,
  card,
  checkbox,
  dateInput,
  field,
  h,
  iconButton,
  numberInput,
  select,
  textInput,
} from "./dom.ts";

const REPEAT_CHOICES = [
  { value: "0", label: "cal.repeat.none" },
  { value: "1", label: "cal.repeat.weekly" },
  { value: "2", label: "cal.repeat.biweekly" },
  { value: "4", label: "cal.repeat.fourWeekly" },
] as const;

function renderBasics(state: AppState, actions: AppActions): HTMLElement {
  const calendar = state.document.calendar;
  const setNumber =
    (key: "hoursPerPersonDay" | "horizonDays") =>
    (value: string): void => {
      actions.edit((document) => {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) document.calendar[key] = Math.max(0.1, parsed);
      });
    };

  const totalPerDay =
    state.result === null || state.result.nDays === 0
      ? 0
      : state.result.totalCapacity / state.result.nDays;

  return card(t("cal.basics"), [
    h("div", { class: "controls" }, [
      field(
        t("cal.start"),
        dateInput(calendar.startDate, (value) => {
          actions.mutate((document) => {
            if (value !== null) document.calendar.startDate = value;
          });
        }),
      ),
      field(
        t("cal.today"),
        dateInput(calendar.today, (value) => {
          actions.mutate((document) => {
            if (value !== null) document.calendar.today = value;
          });
        }),
      ),
      field(
        t("cal.horizon"),
        numberInput(calendar.horizonDays, setNumber("horizonDays"), {
          dataset: { focus: "calendar:horizonDays" },
          attrs: { min: 1, max: 1830, step: 30 },
        }),
      ),
      field(
        t("cal.hoursPerPersonDay"),
        numberInput(calendar.hoursPerPersonDay, setNumber("hoursPerPersonDay"), {
          dataset: { focus: "calendar:hoursPerPersonDay" },
          attrs: { min: 0.5, max: 24, step: 0.5 },
        }),
      ),
    ]),
    h("label", { class: "toggle" }, [
      checkbox(calendar.useJapaneseHolidays, (checked) => {
        actions.mutate((document) => {
          document.calendar.useJapaneseHolidays = checked;
        });
      }),
      h("span", { text: t("cal.useHolidays") }),
    ]),
    h("p", {
      class: "status",
      text:
        state.result === null
          ? ""
          : `${t("cal.capacityPerDay", {
              value: formatNumber(totalPerDay, lang(), 2),
            })} · ${t("cal.totalCapacity", {
              value: formatNumber(state.result.totalCapacity, lang(), 1),
            })}`,
    }),
  ]);
}

/* ===== 予定の編集 ===== */

/**
 * 予定を 1 件直す窓。
 *
 * 画面は変更のたびに作り直すので、`<dialog>` の開閉に頼らず、開いているか
 * どうかを状態 (`editingEventId`) で持つ。閉じるのは、背景・×・Esc の 3 つ。
 */
function renderEditor(state: AppState, actions: AppActions): HTMLElement | null {
  const editingId = state.editingEventId;
  if (editingId === null) return null;
  const index = state.document.calendar.events.findIndex((item) => item.id === editingId);
  const event = state.document.calendar.events[index];
  // 消された直後などは、黙って閉じる。
  if (event === undefined) return null;

  const close = (): void => {
    actions.patch((draft) => {
      draft.editingEventId = null;
      draft.editingEventDay = null;
    });
  };
  const patch = (change: Partial<CalendarEventItem>): void => {
    actions.mutate((document) => {
      const target = document.calendar.events[index];
      if (target) Object.assign(target, change);
    });
  };
  const allDay = event.startTime === null || event.endTime === null;
  const members = state.document.calendar.members;
  const title = event.name.trim() === "" ? t("cal.untitledEvent") : event.name;
  // 押した回の初日。ここからしか「どの回か」は決まらない。
  const skipDay = state.editingEventDay;
  const alreadySkipped = skipDay !== null && event.excludedDates.includes(skipDay);

  const timeInput = (value: string, which: "startTime" | "endTime") =>
    h("input", {
      dataset: { focus: `event:${event.id}:${which}` },
      attrs: {
        type: "time",
        step: 300,
        value,
        "aria-label": `${t("cal.eventTime")} ${which === "startTime" ? "1" : "2"}`,
      },
      on: {
        change: (domEvent) => {
          patch({ [which]: (domEvent.target as HTMLInputElement).value });
        },
      },
    });

  const nameInput = textInput(
    event.name,
    (value) => {
      patch({ name: value });
    },
    {
      class: "event-name",
      dataset: { focus: `event:${event.id}:name` },
      attrs: { placeholder: t("cal.eventName"), "aria-label": t("cal.eventName") },
    },
  );

  const panel = h(
    "div",
    {
      class: "event-card modal-card",
      dataset: { event: event.id },
      attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("cal.editEvent") },
    },
    [
      h("div", { class: "event-head" }, [nameInput, iconButton("×", t("cal.closeEditor"), close)]),
      h("div", { class: "controls" }, [
        field(
          t("cal.eventFrom"),
          dateInput(event.startDate, (value) => {
            if (value === null) return;
            patch({ startDate: value, endDate: value > event.endDate ? value : event.endDate });
          }),
        ),
        field(
          t("cal.eventTo"),
          dateInput(event.endDate, (value) => {
            if (value !== null) patch({ endDate: value });
          }),
        ),
        h("label", { class: "field" }, [
          h("span", { class: "field-label", text: t("cal.eventTime") }),
          h("div", { class: "time-range" }, [
            h("label", { class: "toggle compact" }, [
              checkbox(allDay, (checked) => {
                patch(
                  checked
                    ? { startTime: null, endTime: null }
                    : { startTime: "10:00", endTime: "11:00" },
                );
              }),
              h("span", { text: t("cal.allDay") }),
            ]),
            allDay ? null : timeInput(event.startTime ?? "10:00", "startTime"),
            allDay ? null : h("span", { class: "muted", text: "–" }),
            allDay ? null : timeInput(event.endTime ?? "11:00", "endTime"),
          ]),
        ]),
        field(
          t("cal.repeat"),
          select(
            String(event.repeatWeeks),
            REPEAT_CHOICES.map((choice) => ({ value: choice.value, label: t(choice.label) })),
            (value) => {
              patch({ repeatWeeks: Number(value) });
            },
          ),
        ),
        event.repeatWeeks === 0
          ? null
          : field(
              t("cal.until"),
              dateInput(event.until, (value) => {
                patch({ until: value });
              }),
            ),
      ]),
      h("div", { class: "participants" }, [
        h("span", { class: "field-label", text: t("cal.participants") }),
        members.length === 0
          ? h("span", { class: "muted", text: t("cal.allMembers") })
          : h(
              "div",
              { class: "participant-list" },
              members.map((member, memberIndex) =>
                h("label", { class: "toggle compact" }, [
                  checkbox(event.memberIds.includes(member.id), (checked) => {
                    const next = checked
                      ? [...event.memberIds, member.id]
                      : event.memberIds.filter((id) => id !== member.id);
                    patch({ memberIds: next });
                  }),
                  h("span", { text: memberLabel(member, memberIndex) }),
                ]),
              ),
            ),
        event.memberIds.length === 0
          ? h("span", { class: "chip muted", text: t("cal.allMembers") })
          : null,
      ]),
      // 休みにした回。黙って消えるだけだと戻せないので、一覧にして返せるようにする。
      event.excludedDates.length === 0
        ? null
        : h("div", { class: "skipped-list" }, [
            h("span", { class: "field-label", text: t("cal.skippedHeading") }),
            h(
              "div",
              { class: "inline-row" },
              event.excludedDates.map((iso) =>
                h("span", { class: "chip", dataset: { skipped: iso } }, [
                  formatDayShort(dayFromIso(iso) ?? 0, lang()),
                  iconButton("↺", t("cal.restoreOccurrence", { date: iso }), () => {
                    patch({
                      excludedDates: event.excludedDates.filter((day) => day !== iso),
                    });
                  }),
                ]),
              ),
            ),
          ]),
      h("div", { class: "row-actions" }, [
        // 繰り返す予定は、1 回だけ休みにするのと全部消すのを分ける。
        // 「今週だけ休み」に全消しを使わせてはいけない。
        event.repeatWeeks !== 0 && skipDay !== null && !alreadySkipped
          ? button(
              t("cal.skipOccurrence"),
              () => {
                patch({ excludedDates: [...event.excludedDates, skipDay].sort() });
                close();
              },
              { dataset: { action: "skip-occurrence" } },
            )
          : null,
        button(
          event.repeatWeeks === 0 ? t("cal.removeEvent") : t("cal.removeAllOccurrences"),
          () => {
            if (!confirm(t("cal.confirmRemoveEvent", { name: title }))) return;
            actions.mutate((document) => {
              document.calendar.events.splice(index, 1);
            });
            close();
          },
          { dataset: { action: "remove-event" } },
        ),
        button(t("cal.doneEditing"), close, { class: "primary" }),
      ]),
    ],
  );

  // 開いた直後は名前に合わせる。すでに窓のなかを触っているときは奪わない
  // (描き直しのたびに入力欄から飛ばされてしまうため)。
  queueMicrotask(() => {
    if (!panel.contains(document.activeElement)) nameInput.focus();
  });

  return h(
    "div",
    {
      class: "modal-backdrop",
      on: {
        click: (domEvent) => {
          if (domEvent.target === domEvent.currentTarget) close();
        },
        keydown: (domEvent) => {
          if (domEvent.key === "Escape") close();
        },
      },
    },
    [panel],
  );
}

/* ===== 月表示 ===== */

/** 升のなかに出す予定 1 件。押すと編集できる。 */
function renderChip(actions: AppActions, occurrence: Occurrence): HTMLElement {
  const { event, allDay, starts, ends, firstDay } = occurrence;
  const name = event.name.trim() === "" ? t("cal.untitledEvent") : event.name;
  const classes = ["event-chip"];
  if (allDay) classes.push("all-day");
  if (!starts) classes.push("continues-from");
  if (!ends) classes.push("continues-to");

  return h(
    "button",
    {
      class: classes.join(" "),
      dataset: { event: event.id },
      attrs: { type: "button", title: `${shortTime(event)} ${name}`.trim() },
      on: {
        click: (domEvent) => {
          // 升そのものの「空いているところ」判定に巻き込まれないようにする。
          domEvent.stopPropagation();
          actions.patch((draft) => {
            draft.editingEventId = event.id;
            // どの回を押したかは、この升でしか分からない。
            draft.editingEventDay = isoFromDay(firstDay);
          });
        },
      },
    },
    [
      allDay || !starts ? null : h("span", { class: "chip-time", text: shortTime(event) }),
      h("span", { class: "chip-name", text: name }),
    ],
  );
}

/** 升に入れる予定の数。これを超えたら「+n 件」にまとめる。 */
const CHIPS_PER_DAY = 3;

function renderMonth(state: AppState, actions: AppActions): HTMLElement {
  const { year, month } = state.calendarMonth;
  const { first, length } = monthBounds(year, month);
  const result = state.result;
  const labels = weekdayLabels(lang());
  const leading = (((first + 4) % 7) + 7) % 7;
  const viewing = state.calendarMember;
  const events = state.document.calendar.events;

  /** 表示中の人員 (または全員) のその日の工数とフラグ。 */
  const dayInfo = (index: number): { capacity: number; flags: number } => {
    if (result === null || index < 0 || index >= result.nDays) return { capacity: 0, flags: 0 };
    if (viewing !== null) {
      return {
        capacity: memberSlice(result, result.capacity, viewing)[index] ?? 0,
        flags: memberSlice(result, result.dayFlags, viewing)[index] ?? 0,
      };
    }
    let capacity = 0;
    let flags = 0;
    let allOff = true;
    for (let member = 0; member < result.nMembers; member++) {
      const memberFlags = memberSlice(result, result.dayFlags, member)[index] ?? 0;
      capacity += memberSlice(result, result.capacity, member)[index] ?? 0;
      flags |= memberFlags;
      if (!isNonWorkingDay(memberFlags)) allOff = false;
    }
    return { capacity, flags: allOff ? flags | DAY_FLAG.weekend : flags & ~DAY_FLAG.weekend };
  };

  /** その日に新しい予定を足して、そのまま編集に入る。 */
  const addOn = (iso: string): void => {
    const id = newId();
    actions.mutate((document) => {
      document.calendar.events.push({
        id,
        name: t("cal.newEventName"),
        startDate: iso,
        endDate: iso,
        startTime: "10:00",
        endTime: "11:00",
        repeatWeeks: 0,
        until: null,
        memberIds: document.calendar.members.map((member) => member.id),
        excludedDates: [],
      });
    });
    actions.patch((draft) => {
      draft.editingEventId = id;
      draft.editingEventDay = iso;
    });
  };

  const cells: HTMLElement[] = [];
  for (let i = 0; i < leading; i++) cells.push(h("div", { class: "day empty" }));

  for (let offset = 0; offset < length; offset++) {
    const day = first + offset;
    const index = result === null ? -1 : day - result.calendarStartDay;
    const inRange = result !== null && index >= 0 && index < result.nDays;
    const { capacity, flags } = dayInfo(index);
    const iso = isoFromDay(day);
    const onDay = occurrencesOn(events, day);
    const expanded = state.expandedDay === iso;
    const shown = expanded ? onDay : onDay.slice(0, CHIPS_PER_DAY);
    const hidden = onDay.length - shown.length;

    const classes = ["day"];
    if (!inRange) classes.push("outside");
    else if (isNonWorkingDay(flags)) classes.push("off");
    if ((flags & DAY_FLAG.holiday) !== 0) classes.push("holiday");
    if ((flags & DAY_FLAG.forcedWorkday) !== 0) classes.push("forced");
    if (state.document.calendar.today === iso) classes.push("today");

    cells.push(
      h(
        "div",
        {
          class: classes.join(" "),
          dataset: { day: iso, events: String(onDay.length) },
          attrs: {
            "aria-label": t("cal.dayCapacity", {
              date: iso,
              value: formatNumber(capacity, lang(), 2),
            }),
          },
        },
        [
          h("div", { class: "day-head" }, [
            // 数字を押すと、休日でもその日は稼働する扱いにできる。
            // 空いているところは「予定を足す」に使うので、切り替えはここに置く。
            h("button", {
              class: "day-number",
              text: String(offset + 1),
              title: t("cal.toggleForced", { date: iso }),
              attrs: { type: "button", "aria-label": t("cal.toggleForced", { date: iso }) },
              on: {
                click: () => {
                  actions.mutate((document) => {
                    const list = document.calendar.forcedWorkdays;
                    const at = list.indexOf(iso);
                    if (at >= 0) list.splice(at, 1);
                    else list.push(iso);
                  });
                },
              },
            }),
            h("span", {
              class: "day-capacity",
              text: inRange && capacity > 0 ? formatNumber(capacity, lang(), 1) : "",
            }),
          ]),
          h(
            "div",
            { class: "day-events" },
            shown.map((occurrence) => renderChip(actions, occurrence)),
          ),
          hidden > 0
            ? h("button", {
                class: "day-more",
                text: t("cal.moreEvents", { count: hidden }),
                attrs: { type: "button" },
                on: {
                  click: (domEvent) => {
                    domEvent.stopPropagation();
                    actions.patch((draft) => {
                      draft.expandedDay = iso;
                    });
                  },
                },
              })
            : null,
          expanded && onDay.length > CHIPS_PER_DAY
            ? h("button", {
                class: "day-more",
                text: t("cal.fewerEvents"),
                attrs: { type: "button" },
                on: {
                  click: (domEvent) => {
                    domEvent.stopPropagation();
                    actions.patch((draft) => {
                      draft.expandedDay = null;
                    });
                  },
                },
              })
            : null,
          // 残りの余白。押すとその日に予定を足す。
          h("button", {
            class: "day-add",
            title: t("cal.addEventOn", { date: iso }),
            attrs: { type: "button", "aria-label": t("cal.addEventOn", { date: iso }) },
            on: {
              click: () => {
                addOn(iso);
              },
            },
          }),
        ],
      ),
    );
  }

  const shift = (delta: number): void => {
    actions.patch((s) => {
      const next = month + delta;
      s.calendarMonth =
        next < 1
          ? { year: year - 1, month: 12 }
          : next > 12
            ? { year: year + 1, month: 1 }
            : { year, month: next };
      // 別の月に移ったら、開きっぱなしの升は畳む。
      s.expandedDay = null;
    });
  };

  return card(t("cal.monthView"), [
    h("div", { class: "month-head" }, [
      iconButton("‹", t("cal.prevMonth"), () => {
        shift(-1);
      }),
      h("strong", { text: formatMonth(year, month, lang()) }),
      iconButton("›", t("cal.nextMonth"), () => {
        shift(1);
      }),
      button(
        t("cal.thisMonth"),
        () => {
          const today = dayFromIso(state.document.calendar.today);
          if (today === null) return;
          const date = new Date(today * 86_400_000);
          actions.patch((s) => {
            s.calendarMonth = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
          });
        },
        { class: "ghost" },
      ),
      select(
        viewing === null ? "" : String(viewing),
        [
          { value: "", label: t("cal.allMembers") },
          ...state.members.all.map((member, index) => ({
            value: String(index),
            label: memberLabel(member, index),
          })),
        ],
        (value) => {
          actions.patch((s) => {
            s.calendarMember = value === "" ? null : Number(value);
          });
        },
        { attrs: { "aria-label": t("cal.memberView") } },
      ),
    ]),
    h("div", { class: "month-grid" }, [
      ...labels.map((label) => h("div", { class: "weekday-head", text: label })),
      ...cells,
    ]),
    h("div", { class: "legend" }, [
      h("span", { class: "legend-item" }, [
        h("i", { class: "swatch workday" }),
        t("cal.legendWorkday"),
      ]),
      h("span", { class: "legend-item" }, [
        h("i", { class: "swatch off" }),
        t("cal.legendWeekend"),
      ]),
      h("span", { class: "legend-item" }, [
        h("i", { class: "swatch holiday" }),
        t("cal.legendHoliday"),
      ]),
      h("span", { class: "legend-item" }, [
        h("i", { class: "swatch forced" }),
        t("cal.legendForced"),
      ]),
    ]),
    h("p", { class: "hint", text: t("cal.clickHint") }),
  ]);
}

export function renderCalendarTab(state: AppState, actions: AppActions): HTMLElement {
  return h("div", {}, [
    renderBasics(state, actions),
    renderMonth(state, actions),
    renderEditor(state, actions),
  ]);
}
