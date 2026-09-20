/** カレンダータブ。稼働条件・予定・月表示。 */

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
import { newId } from "../model/project.ts";
import { isNonWorkingDay } from "../model/schedule.ts";
import type { CalendarEventItem } from "../types.ts";
import {
  button,
  card,
  checkbox,
  dateInput,
  field,
  h,
  iconButton,
  numberInput,
  textInput,
} from "./dom.ts";

function renderBasics(state: AppState, actions: AppActions): HTMLElement {
  const calendar = state.project.calendar;
  const labels = weekdayLabels(lang());
  const setNumber =
    (key: "hoursPerDay" | "hoursPerPersonDay" | "teamSize" | "horizonDays") => (value: string) => {
      actions.mutate((project) => {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) project.calendar[key] = Math.max(0, parsed);
      });
    };

  return card(t("cal.basics"), [
    h("div", { class: "controls" }, [
      field(
        t("cal.start"),
        dateInput(calendar.startDate, (value) => {
          actions.mutate((project) => {
            if (value !== null) project.calendar.startDate = value;
          });
        }),
      ),
      field(
        t("cal.today"),
        dateInput(calendar.today, (value) => {
          actions.mutate((project) => {
            if (value !== null) project.calendar.today = value;
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
        t("cal.teamSize"),
        numberInput(calendar.teamSize, setNumber("teamSize"), {
          attrs: { min: 0, step: 0.5 },
        }),
      ),
      field(
        t("cal.hoursPerDay"),
        numberInput(calendar.hoursPerDay, setNumber("hoursPerDay"), {
          attrs: { min: 0, max: 24, step: 0.5 },
        }),
      ),
      field(
        t("cal.hoursPerPersonDay"),
        numberInput(calendar.hoursPerPersonDay, setNumber("hoursPerPersonDay"), {
          attrs: { min: 0.5, max: 24, step: 0.5 },
        }),
      ),
    ]),
    h("div", { class: "weekdays" }, [
      h("span", { class: "field-label", text: t("cal.workdays") }),
      ...labels.map((label, index) =>
        h("label", { class: "weekday" }, [
          checkbox(calendar.workdays[index] ?? false, (checked) => {
            actions.mutate((project) => {
              project.calendar.workdays[index] = checked;
            });
          }),
          h("span", { text: label }),
        ]),
      ),
    ]),
    h("label", { class: "toggle" }, [
      checkbox(calendar.useJapaneseHolidays, (checked) => {
        actions.mutate((project) => {
          project.calendar.useJapaneseHolidays = checked;
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
              value: formatNumber(state.result.baseCapacity, lang(), 2),
            })} · ${t("cal.totalCapacity", {
              value: formatNumber(state.result.totalCapacity, lang(), 1),
            })}`,
    }),
  ]);
}

function renderEvent(
  event: CalendarEventItem,
  index: number,
  actions: AppActions,
): HTMLTableRowElement {
  const patch = (change: Partial<CalendarEventItem>): void => {
    actions.mutate((project) => {
      const target = project.calendar.events[index];
      if (target) Object.assign(target, change);
    });
  };
  const allDay = event.hours === null;

  return h("tr", {}, [
    h("td", {}, [
      textInput(
        event.name,
        (value) => {
          patch({ name: value });
        },
        {
          dataset: { focus: `event:${event.id}:name` },
          attrs: { placeholder: t("cal.eventName"), "aria-label": t("cal.eventName") },
        },
      ),
    ]),
    h("td", {}, [
      dateInput(
        event.startDate,
        (value) => {
          if (value !== null)
            patch({ startDate: value, endDate: value > event.endDate ? value : event.endDate });
        },
        { attrs: { "aria-label": t("cal.eventFrom") } },
      ),
    ]),
    h("td", {}, [
      dateInput(
        event.endDate,
        (value) => {
          if (value !== null) patch({ endDate: value });
        },
        { attrs: { "aria-label": t("cal.eventTo") } },
      ),
    ]),
    h("td", {}, [
      h("label", { class: "toggle" }, [
        checkbox(allDay, (checked) => {
          patch({ hours: checked ? null : 2 });
        }),
        h("span", { text: t("cal.allDay") }),
      ]),
    ]),
    h("td", { class: "num" }, [
      allDay
        ? h("span", { class: "muted", text: "—" })
        : numberInput(
            event.hours ?? 0,
            (value) => {
              patch({ hours: Math.max(0, Number(value) || 0) });
            },
            { attrs: { min: 0, max: 24, step: 0.5, "aria-label": t("cal.eventHours") } },
          ),
    ]),
    h("td", { class: "actions" }, [
      iconButton("×", t("cal.removeEvent"), () => {
        actions.mutate((project) => {
          project.calendar.events.splice(index, 1);
        });
      }),
    ]),
  ]);
}

function renderEvents(state: AppState, actions: AppActions): HTMLElement {
  const events = state.project.calendar.events;
  return card(t("cal.events"), [
    events.length === 0
      ? h("p", { class: "empty", text: t("cal.noEvents") })
      : h("div", { class: "table-scroll" }, [
          h("table", {}, [
            h("thead", {}, [
              h("tr", {}, [
                h("th", { text: t("cal.eventName") }),
                h("th", { text: t("cal.eventFrom") }),
                h("th", { text: t("cal.eventTo") }),
                h("th", { text: t("cal.allDay") }),
                h("th", { text: t("cal.hoursUnit"), class: "num" }),
                h("th", { text: t("col.actions") }),
              ]),
            ]),
            h(
              "tbody",
              {},
              events.map((event, index) => renderEvent(event, index, actions)),
            ),
          ]),
        ]),
    h("div", { class: "row-actions" }, [
      button(
        t("cal.addEvent"),
        () => {
          actions.mutate((project) => {
            const today = project.calendar.today;
            project.calendar.events.push({
              id: newId(),
              name: "",
              startDate: today,
              endDate: today,
              hours: null,
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

  const cells: HTMLElement[] = [];
  for (let i = 0; i < leading; i++) cells.push(h("div", { class: "day empty" }));

  for (let offset = 0; offset < length; offset++) {
    const day = first + offset;
    const index = result === null ? -1 : day - result.calendarStartDay;
    const inRange = result !== null && index >= 0 && index < result.capacity.length;
    const flags = inRange ? (result.dayFlags[index] ?? 0) : 0;
    const capacity = inRange ? (result.capacity[index] ?? 0) : 0;
    const iso = isoFromDay(day);
    const classes = ["day"];
    if (!inRange) classes.push("outside");
    else if (isNonWorkingDay(flags)) classes.push("off");
    if ((flags & DAY_FLAG.holiday) !== 0) classes.push("holiday");
    if ((flags & DAY_FLAG.event) !== 0) classes.push("has-event");
    if ((flags & DAY_FLAG.forcedWorkday) !== 0) classes.push("forced");
    if (state.project.calendar.today === iso) classes.push("today");

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
              actions.mutate((project) => {
                const list = project.calendar.forcedWorkdays;
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
          const today = dayFromIso(state.project.calendar.today);
          if (today === null) return;
          const date = new Date(today * 86_400_000);
          actions.patch((s) => {
            s.calendarMonth = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
          });
        },
        { class: "ghost" },
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
