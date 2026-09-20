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

/** その日にこの予定が発生するか。`day` は 1970-01-01 からの日数。 */
export function occursOn(event: CalendarEventItem, day: number): boolean {
  const start = dayFromIso(event.startDate);
  const end = dayFromIso(event.endDate);
  if (start === null || end === null || day < start) return false;
  if (event.repeatWeeks === 0) return day <= end;

  const period = 7 * event.repeatWeeks;
  const span = end - start;
  const until = dayFromIso(event.until);
  // 期間より長い予定も扱えるよう、直近の 2 回ぶんを見る。
  const latest = Math.floor((day - start) / period);
  for (let back = 0; back <= 1; back++) {
    const index = latest - back;
    if (index < 0) continue;
    const from = start + period * index;
    if (until !== null && from > until) continue;
    if (day >= from && day <= from + span) return true;
  }
  return false;
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
    if (!occursOn(event, day)) continue;
    const start = dayFromIso(event.startDate);
    const end = dayFromIso(event.endDate);
    if (start === null || end === null) continue;
    const span = end - start;
    // 繰り返す予定は、その回の初日からの位置で見る。
    const offset = event.repeatWeeks === 0 ? day - start : (day - start) % (7 * event.repeatWeeks);
    out.push({
      event,
      index,
      allDay: event.startTime === null || event.endTime === null,
      starts: offset === 0,
      ends: offset === span,
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
