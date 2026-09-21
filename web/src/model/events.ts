/**
 * 予定がどの日に現れるか。
 *
 * 判定の規則は `crates/core/src/calendar.rs` の `Event::occurs_on` と
 * **同じもの**。画面はカレンダーに並べるため、Rust は稼働時間を削るために
 * 使う。ずれると「画面には出ているのに工数が減らない」という食い違いが
 * 起きるので、同じ筋書きを両側のテストで固定してある。
 */

import { dayFromIso } from "../format.ts";
import type { CalendarEventItem } from "../types.ts";

/** 休みにした回の初日の集合。読めない日付は無視する。 */
function excludedDays(event: CalendarEventItem): Set<number> {
  const out = new Set<number>();
  for (const iso of event.excludedDates) {
    const day = dayFromIso(iso);
    if (day !== null) out.add(day);
  }
  return out;
}

/** その日にこの予定が発生するか。`day` は 1970-01-01 からの日数。 */
export function occursOn(event: CalendarEventItem, day: number): boolean {
  return occurrenceStart(event, day) !== null;
}

/**
 * その日を覆っている回の**初日**。覆う回が無ければ `null`。
 *
 * 1 回の長さが繰り返しの周期より長いと、同じ日を複数の回が覆いうる。
 * **候補を全部見る。** 直近の 2 回だけを見ていたころは、長い予定の後半が
 * 「起きない」ことになり、その日の稼働が削られないまま残った。
 *
 * `crates/core/src/calendar.rs` の `occurrence_start` と同じ規則。
 */
export function occurrenceStart(event: CalendarEventItem, day: number): number | null {
  const start = dayFromIso(event.startDate);
  const end = dayFromIso(event.endDate);
  if (start === null || end === null || day < start) return null;

  const skipped = excludedDays(event);
  const span = end - start;
  if (event.repeatWeeks === 0) {
    return day <= end && !skipped.has(start) ? start : null;
  }

  const period = 7 * event.repeatWeeks;
  const until = dayFromIso(event.until);
  // `day` を覆えるのは、初日が `day - span` 以上 `day` 以下の回だけ。
  const latest = Math.floor((day - start) / period);
  const earliest = Math.ceil(Math.max(0, day - start - span) / period);
  // **新しい回から**見る。重なっているときに「いまの回」を指したい。
  for (let index = latest; index >= earliest; index--) {
    const from = start + period * index;
    if (until !== null && from > until) continue;
    // 休みにするのは回の初日で指定する。その回はまるごと消える。
    if (skipped.has(from)) continue;
    if (day >= from && day <= from + span) return from;
  }
  return null;
}

/** カレンダーの升に並べる 1 件ぶん。 */
export interface Occurrence {
  event: CalendarEventItem;
  /** `document.calendar.events` での位置。編集のときに使う。 */
  index: number;
  /** 終日か (時刻の指定が無い)。 */
  allDay: boolean;
  /** その日が、この回の初日か。 */
  starts: boolean;
  /** その日が、この回の最終日か。 */
  ends: boolean;
  /**
   * この回の初日 (1970-01-01 からの日数)。
   *
   * 「この回だけ休みにする」はこの日で指定する。
   */
  firstDay: number;
}

/** 分に直す。読めなければ `null`。 */
function minutesOf(time: string | null): number | null {
  if (time === null) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * その日に起きる予定を、並べる順に返す。
 *
 * 終日を先に、次に開始の早い順。同じ時刻なら名前順で、**順番が入力の
 * たびに入れ替わらない**ようにしてある。
 */
export function occurrencesOn(events: readonly CalendarEventItem[], day: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const [index, event] of events.entries()) {
    // **実際に覆っている回**を聞く。周期の格子から割り出すと、長い予定では
    // 休みにしたはずの回を指してしまい、「この回だけ休みにする」が
    // 効かなくなる。
    const firstDay = occurrenceStart(event, day);
    if (firstDay === null) continue;
    const start = dayFromIso(event.startDate);
    const end = dayFromIso(event.endDate);
    if (start === null || end === null) continue;
    const span = end - start;
    const offset = day - firstDay;
    out.push({
      event,
      index,
      allDay: event.startTime === null || event.endTime === null,
      starts: offset === 0,
      ends: offset === span,
      firstDay,
    });
  }

  out.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const at = minutesOf(a.event.startTime) ?? 0;
    const bt = minutesOf(b.event.startTime) ?? 0;
    return at - bt || a.event.name.localeCompare(b.event.name) || a.index - b.index;
  });
  return out;
}

/** 升に出す短い時刻。終日なら空。 */
export function shortTime(event: CalendarEventItem): string {
  const start = event.startTime;
  if (start === null) return "";
  // 先頭の 0 は落とす。狭い升では 1 文字が効く。
  return start.replace(/^0/, "");
}
