/** カレンダータブ。期間の設定・予定・月表示。 */

import { DAY_FLAG } from "../abi.ts";
import type { AppActions, AppState } from "../app.ts";
import {
  dayFromIso,
  formatMonth,
  formatNumber,
  isoFromDay,
  monthBounds,
  weekdayLabels,
} from "../format.ts";
import { lang, t } from "../i18n.ts";
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
      actions.mutate((document) => {
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
          attrs: { min: 1, max: 1830, step: 30 },
        }),
      ),
      field(
        t("cal.hoursPerPersonDay"),
        numberInput(calendar.hoursPerPersonDay, setNumber("hoursPerPersonDay"), {
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

function renderEvent(
  state: AppState,
  actions: AppActions,
  event: CalendarEventItem,
  index: number,
): HTMLElement {
  const patch = (change: Partial<CalendarEventItem>): void => {
    actions.mutate((document) => {
      const target = document.calendar.events[index];
      if (target) Object.assign(target, change);
    });
  };
  const allDay = event.startTime === null || event.endTime === null;
  const members = state.document.calendar.members;

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

  return h("div", { class: "event-card" }, [
    h("div", { class: "event-head" }, [
      textInput(
        event.name,
        (value) => {
          patch({ name: value });
        },
        {
          class: "event-name",
          dataset: { focus: `event:${event.id}:name` },
          attrs: { placeholder: t("cal.eventName"), "aria-label": t("cal.eventName") },
        },
      ),
      iconButton("×", t("cal.removeEvent"), () => {
        actions.mutate((document) => {
          document.calendar.events.splice(index, 1);
        });
      }),
    ]),
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
  ]);
}

function renderEvents(state: AppState, actions: AppActions): HTMLElement {
  const events = state.document.calendar.events;
  return card(t("cal.events"), [
    h("p", { class: "hint", text: t("cal.eventHint") }),
    events.length === 0
      ? h("p", { class: "empty", text: t("cal.noEvents") })
      : h(
          "div",
          { class: "event-list" },
          events.map((event, index) => renderEvent(state, actions, event, index)),
        ),
    h("div", { class: "row-actions" }, [
      button(
        t("cal.addEvent"),
        () => {
          actions.mutate((document) => {
            const today = document.calendar.today;
            document.calendar.events.push({
              id: newId(),
              name: "",
              startDate: today,
              endDate: today,
              startTime: "10:00",
              endTime: "11:00",
              repeatWeeks: 0,
              until: null,
              memberIds: document.calendar.members.map((member) => member.id),
            });
          });
        },
        { class: "primary" },
      ),
    ]),
  ]);
}

function renderMonth(state: AppState, actions: AppActions): HTMLElement {
  const { year, month } = state.calendarMonth;
  const { first, length } = monthBounds(year, month);
  const result = state.result;
  const labels = weekdayLabels(lang());
  const leading = (((first + 4) % 7) + 7) % 7;
  const viewing = state.calendarMember;

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

  const cells: HTMLElement[] = [];
  for (let i = 0; i < leading; i++) cells.push(h("div", { class: "day empty" }));

  for (let offset = 0; offset < length; offset++) {
    const day = first + offset;
    const index = result === null ? -1 : day - result.calendarStartDay;
    const inRange = result !== null && index >= 0 && index < result.nDays;
    const { capacity, flags } = dayInfo(index);
    const iso = isoFromDay(day);
    const classes = ["day"];
    if (!inRange) classes.push("outside");
    else if (isNonWorkingDay(flags)) classes.push("off");
    if ((flags & DAY_FLAG.holiday) !== 0) classes.push("holiday");
    if ((flags & DAY_FLAG.event) !== 0) classes.push("has-event");
    if ((flags & DAY_FLAG.forcedWorkday) !== 0) classes.push("forced");
    if (state.document.calendar.today === iso) classes.push("today");

    cells.push(
      h(
        "button",
        {
          class: classes.join(" "),
          attrs: {
            type: "button",
            "aria-label": t("cal.dayCapacity", {
              date: iso,
              value: formatNumber(capacity, lang(), 2),
            }),
          },
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
        },
        [
          h("span", { class: "day-number", text: String(offset + 1) }),
          h("span", {
            class: "day-capacity",
            text: inRange && capacity > 0 ? formatNumber(capacity, lang(), 1) : "",
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
        h("i", { class: "swatch event" }),
        t("cal.legendEvent"),
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
    renderEvents(state, actions),
    renderMonth(state, actions),
  ]);
}
