/** 日付と数値の変換・書式。 */

import type { IsoDate } from "./types.ts";

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` を 1970-01-01 からの日数にする。不正な文字列は `null`。 */
export function dayFromIso(iso: IsoDate | null | undefined): number | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, day);
  if (Number.isNaN(utc)) return null;
  // 2 月 31 日のような存在しない日付を弾く (Date は繰り上げてしまう)。
  const back = new Date(utc);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1) return null;
  return Math.round(utc / MS_PER_DAY);
}

/** 日数を `YYYY-MM-DD` にする。 */
export function isoFromDay(day: number): IsoDate {
  const date = new Date(Math.round(day) * MS_PER_DAY);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
}

/** 今日 (実行環境のローカル日付) を `YYYY-MM-DD` で返す。 */
export function todayIso(): IsoDate {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  const day = dayFromIso(iso);
  return day === null ? iso : isoFromDay(day + days);
}

/** 曜日 (0 = 日曜)。 */
export function weekdayOfDay(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** `iso` 以降で最初に来る指定曜日 (0 = 日曜)。 */
export function nextWeekday(iso: IsoDate, weekday: number): IsoDate {
  const day = dayFromIso(iso);
  if (day === null) return iso;
  const shift = (((weekday - weekdayOfDay(day)) % 7) + 7) % 7;
  return isoFromDay(day + shift);
}

export function weekdayOfIso(iso: IsoDate): number | null {
  const day = dayFromIso(iso);
  return day === null ? null : weekdayOfDay(day);
}

/** 月初の日数と、その月の日数。 */
export function monthBounds(year: number, month: number): { first: number; length: number } {
  const first = Math.round(Date.UTC(year, month - 1, 1) / MS_PER_DAY);
  const next = Math.round(Date.UTC(month === 12 ? year + 1 : year, month % 12, 1) / MS_PER_DAY);
  return { first, length: next - first };
}

/** `HH:MM` を 0 時からの分に直す。不正な文字列は `null`。 */
export function minutesFromTime(time: string | null | undefined): number | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total > 24 * 60 ? null : total;
}

/** 0 時からの分を `HH:MM` に直す。 */
export function timeFromMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const hours = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** 分数を「7時間30分」のような表記にする。 */
export function formatDuration(minutes: number, lang: Lang): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (lang === "ja") {
    if (hours === 0) return `${String(rest)}分`;
    return rest === 0 ? `${String(hours)}時間` : `${String(hours)}時間${String(rest)}分`;
  }
  if (hours === 0) return `${String(rest)}m`;
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
}

export type Lang = "ja" | "en";

const locale = (lang: Lang): string => (lang === "ja" ? "ja-JP" : "en-US");

export function formatNumber(value: number, lang: Lang, digits?: number): string {
  if (!Number.isFinite(value)) return "–";
  const fractionDigits = digits ?? (Math.abs(value) >= 100 ? 0 : 1);
  return new Intl.NumberFormat(locale(lang), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatPercent(fraction: number, lang: Lang, digits = 1): string {
  if (!Number.isFinite(fraction)) return "–";
  return `${formatNumber(fraction * 100, lang, digits)}%`;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `11/5(木)` / `Nov 5 (Thu)` のような短い表記。 */
export function formatDayShort(day: number, lang: Lang): string {
  const date = new Date(Math.round(day) * MS_PER_DAY);
  const weekday = weekdayOfDay(day);
  if (lang === "ja") {
    return `${date.getUTCMonth() + 1}/${date.getUTCDate()}(${WEEKDAY_JA[weekday] ?? ""})`;
  }
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  return `${month} ${date.getUTCDate()} (${WEEKDAY_EN[weekday] ?? ""})`;
}

/** 年を含む表記。 */
export function formatDayLong(day: number, lang: Lang): string {
  const date = new Date(Math.round(day) * MS_PER_DAY);
  if (lang === "ja") {
    return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** 月の見出し。 */
export function formatMonth(year: number, month: number, lang: Lang): string {
  if (lang === "ja") return `${year}年${month}月`;
  const date = new Date(Date.UTC(year, month - 1, 1));
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date);
}

/** 軸に並べる短い月表記。年が変わるところだけ年を添える。 */
export function formatMonthShort(year: number, month: number, lang: Lang): string {
  if (lang === "ja") return month === 1 ? `${String(year)}年1月` : `${String(month)}月`;
  const date = new Date(Date.UTC(year, month - 1, 1));
  const name = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  return month === 1 ? `${name} ${String(year)}` : name;
}

export function weekdayLabels(lang: Lang): readonly string[] {
  return lang === "ja" ? WEEKDAY_JA : WEEKDAY_EN;
}
