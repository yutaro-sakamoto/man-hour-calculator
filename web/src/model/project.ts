/** プロジェクト (保存・読み込みの単位) の生成と検証。 */

import { nextWeekday, todayIso } from "../format.ts";
import type { ProjectDocument } from "../api/types.ts";
import type {
  CalendarEventItem,
  CalendarSettings,
  ComputeSettings,
  Member,
  Priority,
  Task,
  WorkWindow,
} from "../types.ts";
import { PRIORITIES } from "../types.ts";

export const SCHEMA = "man-hour-calculator";
export const SCHEMA_VERSION = 1;

let counter = 0;

/** 衝突しない id。`crypto.randomUUID` が無い環境でも動くようにする。 */
export function newId(): string {
  counter += 1;
  const random = globalThis.crypto as Crypto | undefined;
  if (random && typeof random.randomUUID === "function") return random.randomUUID();
  return `id-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: newId(),
    name: "",
    parentId: null,
    group: "",
    priority: "normal",
    enabled: true,
    min: "1",
    likely: "2",
    max: "4",
    startDate: null,
    progress: 0,
    endDate: null,
    assigneeId: null,
    ...overrides,
  };
}

/** 稼働しない曜日を表す時間帯。 */
const OFF: WorkWindow = { start: "00:00", end: "00:00" };

/** 月〜金 9:00〜18:00、休憩 60 分 (= 1 日 8 時間)。 */
export function createMember(name: string, overrides: Partial<Member> = {}): Member {
  const weekday: WorkWindow = { start: "09:00", end: "18:00" };
  return {
    id: newId(),
    name,
    workdays: [OFF, weekday, weekday, weekday, weekday, weekday, OFF],
    breakMinutes: 60,
    ...overrides,
  };
}

export function defaultCalendar(): CalendarSettings {
  const today = todayIso();
  return {
    startDate: today,
    hoursPerPersonDay: 8,
    useJapaneseHolidays: true,
    horizonDays: 365,
    members: [],
    events: [],
    forcedWorkdays: [],
    today,
  };
}

export function defaultSettings(): ComputeSettings {
  return {
    engine: 0,
    dist: 0,
    lambda: 4,
    iterations: 100_000,
    seed: 20_250_920,
    bins: 48,
    gridPoints: 2_048,
  };
}

export function emptyDocument(): ProjectDocument {
  return {
    tasks: [],
    calendar: defaultCalendar(),
    settings: defaultSettings(),
  };
}

/** ファイルに書き出すときの包み。中身は API の `document` と同じ。 */
export interface ProjectFile {
  schema: typeof SCHEMA;
  version: typeof SCHEMA_VERSION;
  savedAt: string;
  name: string;
  document: ProjectDocument;
}

export function toFile(name: string, document: ProjectDocument): ProjectFile {
  return {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    name,
    document,
  };
}

/** 機能をひととおり触れる見本データ。 */
export function sampleDocument(lang: "ja" | "en"): ProjectDocument {
  const label = (ja: string, en: string): string => (lang === "ja" ? ja : en);
  const project = emptyDocument();

  const alice = createMember(label("佐藤", "Alice"));
  const bob = createMember(label("鈴木", "Bob"), {
    // 時短勤務の例。9:00〜15:00 から休憩 45 分。
    workdays: [OFF, ...Array.from({ length: 5 }, () => ({ start: "09:00", end: "15:00" })), OFF],
    breakMinutes: 45,
  });
  project.calendar.members = [alice, bob];
  // 予定は稼働日に置く。開始日が日曜だと毎週の定例が 1 度も当たらない。
  const firstMonday = nextWeekday(project.calendar.startDate, 1);
  project.calendar.events = [
    {
      id: newId(),
      name: label("全体定例", "Team sync"),
      startDate: firstMonday,
      endDate: firstMonday,
      startTime: "10:00",
      endTime: "10:45",
      repeatWeeks: 1,
      until: null,
      memberIds: [alice.id, bob.id],
      excludedDates: [],
    },
    {
      id: newId(),
      name: label("隔週の振り返り", "Biweekly retro"),
      startDate: nextWeekday(project.calendar.startDate, 5),
      endDate: nextWeekday(project.calendar.startDate, 5),
      startTime: "16:00",
      endTime: "17:00",
      repeatWeeks: 2,
      until: null,
      memberIds: [alice.id, bob.id],
      excludedDates: [],
    },
  ];

  const design = createTask({
    name: label("設計フェーズ", "Design phase"),
    group: label("設計", "Design"),
    priority: "high",
  });
  const build = createTask({
    name: label("実装フェーズ", "Build phase"),
    group: label("実装", "Build"),
  });

  project.tasks = [
    design,
    createTask({
      name: label("要件定義", "Requirements"),
      parentId: design.id,
      group: label("設計", "Design"),
      priority: "high",
      min: "5",
      likely: "8",
      max: "20",
      assigneeId: alice.id,
    }),
    createTask({
      name: label("基本設計", "Architecture"),
      parentId: design.id,
      group: label("設計", "Design"),
      min: "3",
      likely: "5",
      max: "12",
      assigneeId: bob.id,
    }),
    build,
    createTask({
      name: label("API 実装", "API implementation"),
      parentId: build.id,
      group: label("実装", "Build"),
      priority: "high",
      min: "2",
      likely: "3",
      max: "5",
      assigneeId: alice.id,
    }),
    createTask({
      name: label("画面実装", "UI implementation"),
      parentId: build.id,
      group: label("実装", "Build"),
      min: "10",
      likely: "15",
      max: "40",
      assigneeId: bob.id,
    }),
    createTask({
      name: label("バッチ実装", "Batch jobs"),
      parentId: build.id,
      group: label("実装", "Build"),
      priority: "low",
      min: "2",
      likely: "4",
      max: "9",
      assigneeId: alice.id,
    }),
    createTask({
      name: label("テストとリリース", "Test and release"),
      group: label("QA", "QA"),
      min: "3",
      likely: "6",
      max: "14",
      assigneeId: alice.id,
    }),
  ];
  return project;
}

/** 見本データの既定の名前。 */
export function sampleName(lang: "ja" | "en"): string {
  return lang === "ja" ? "サンプル案件" : "Sample project";
}

/* ===== 読み込んだ JSON の検証 ================================
   外から来たファイルは何が入っているか分からないので、
   1 項目ずつ型を確かめ、駄目なものは既定値に落とす。         */

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asIsoDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function asPriority(value: unknown): Priority {
  return PRIORITIES.includes(value as Priority) ? (value as Priority) : "normal";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumericString(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return value;
  }
  return fallback;
}

function asTimeOfDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

function normalizeMember(raw: unknown): Member {
  const record = asRecord(raw);
  const base = createMember(asString(record.name));
  const windows = record.workdays;
  return {
    id: asString(record.id) || base.id,
    name: base.name,
    workdays: base.workdays.map((fallback, index) => {
      const entry = Array.isArray(windows) ? asRecord(windows[index]) : {};
      return {
        start: asTimeOfDay(entry.start) ?? fallback.start,
        end: asTimeOfDay(entry.end) ?? fallback.end,
      };
    }),
    breakMinutes: Math.min(1440, Math.max(0, asNumber(record.breakMinutes, base.breakMinutes))),
  };
}

function normalizeTask(raw: unknown, knownIds: Set<string>, memberIds: Set<string>): Task {
  const record = asRecord(raw);
  const id = asString(record.id) || newId();
  const parentId = asString(record.parentId);
  return {
    id,
    name: asString(record.name),
    // 親が見つからないものはトップレベルに置き直す (循環と孤児を防ぐ)。
    parentId: parentId !== "" && parentId !== id && knownIds.has(parentId) ? parentId : null,
    group: asString(record.group),
    priority: asPriority(record.priority),
    enabled: asBoolean(record.enabled, true),
    min: asNumericString(record.min, "0"),
    likely: asNumericString(record.likely, "0"),
    max: asNumericString(record.max, "0"),
    startDate: asIsoDate(record.startDate),
    progress: Math.min(100, Math.max(0, asNumber(record.progress, 0))),
    endDate: asIsoDate(record.endDate),
    assigneeId: memberIds.has(asString(record.assigneeId)) ? asString(record.assigneeId) : null,
  };
}

function normalizeEvent(raw: unknown, memberIds: Set<string>): CalendarEventItem | null {
  const record = asRecord(raw);
  const startDate = asIsoDate(record.startDate);
  if (startDate === null) return null;
  const members = record.memberIds;
  const startTime = asTimeOfDay(record.startTime);
  const endTime = asTimeOfDay(record.endTime);
  return {
    id: asString(record.id) || newId(),
    name: asString(record.name),
    startDate,
    endDate: asIsoDate(record.endDate) ?? startDate,
    // 片方しか無い時刻指定は終日として扱う (稼働時間をまるごと潰す)。
    startTime: endTime === null ? null : startTime,
    endTime: startTime === null ? null : endTime,
    repeatWeeks: Math.min(52, Math.max(0, Math.round(asNumber(record.repeatWeeks, 0)))),
    until: asIsoDate(record.until),
    memberIds: Array.isArray(members)
      ? members.map((id) => asString(id)).filter((id) => memberIds.has(id))
      : [],
    excludedDates: normalizeExcludedDates(record.excludedDates),
  };
}

/** 休みにした回の初日。読めないものは落とし、重複は畳んで古い順に並べる。 */
function normalizeExcludedDates(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const value of raw) {
    const iso = asIsoDate(value);
    if (iso !== null) out.add(iso);
  }
  return [...out].sort();
}

function normalizeCalendar(raw: unknown): CalendarSettings {
  const record = asRecord(raw);
  const base = defaultCalendar();
  const rawMembers = Array.isArray(record.members) ? record.members : [];
  const members = rawMembers.map(normalizeMember);
  const memberIds = new Set(members.map((member) => member.id));
  const events = record.events;
  const forced = record.forcedWorkdays;
  return {
    startDate: asIsoDate(record.startDate) ?? base.startDate,
    hoursPerPersonDay: Math.max(0.1, asNumber(record.hoursPerPersonDay, base.hoursPerPersonDay)),
    useJapaneseHolidays: asBoolean(record.useJapaneseHolidays, base.useJapaneseHolidays),
    horizonDays: Math.min(1830, Math.max(1, asNumber(record.horizonDays, base.horizonDays))),
    members,
    events: Array.isArray(events)
      ? events
          .map((event) => normalizeEvent(event, memberIds))
          .filter((event): event is CalendarEventItem => event !== null)
      : [],
    forcedWorkdays: Array.isArray(forced)
      ? forced.map((day) => asIsoDate(day)).filter((day): day is string => day !== null)
      : [],
    today: asIsoDate(record.today) ?? base.today,
  };
}

function normalizeSettings(raw: unknown): ComputeSettings {
  const record = asRecord(raw);
  const base = defaultSettings();
  const engine = asNumber(record.engine, base.engine);
  const dist = asNumber(record.dist, base.dist);
  return {
    engine: engine === 1 ? 1 : 0,
    dist: dist === 1 ? 1 : 0,
    lambda: Math.min(100, Math.max(0, asNumber(record.lambda, base.lambda))),
    iterations: Math.min(
      2_000_000,
      Math.max(1, Math.round(asNumber(record.iterations, base.iterations))),
    ),
    seed: Math.max(0, Math.round(asNumber(record.seed, base.seed))),
    bins: Math.min(512, Math.max(4, Math.round(asNumber(record.bins, base.bins)))),
    gridPoints: Math.min(
      16_384,
      Math.max(16, Math.round(asNumber(record.gridPoints, base.gridPoints))),
    ),
  };
}

/**
 * 読み込んだ JSON を内容に整える。
 *
 * 形が違うものは例外を投げず、項目ごとに既定値へ落とす。
 */
export function normalizeDocument(raw: unknown): ProjectDocument {
  const record = asRecord(raw);
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
  const knownIds = new Set<string>(
    rawTasks.map((task) => asString(asRecord(task).id)).filter((id) => id !== ""),
  );
  const calendar = normalizeCalendar(record.calendar);
  const memberIds = new Set(calendar.members.map((member) => member.id));
  return {
    tasks: rawTasks.map((task) => normalizeTask(task, knownIds, memberIds)),
    calendar,
    settings: normalizeSettings(record.settings),
  };
}

/** 読み込んだファイルの中身。スキーマ名が違うものは受け付けない。 */
export interface LoadedFile {
  name: string;
  document: ProjectDocument;
}

/**
 * ファイルから読み込む。
 *
 * 古い形式 (内容がトップレベルに並んでいるもの) も読めるようにしてある。
 * 保存したファイルが次のバージョンで開けなくなるのは避けたい。
 */
export function readProjectFile(raw: unknown): LoadedFile | null {
  const record = asRecord(raw);
  if (asString(record.schema) !== SCHEMA) return null;
  const nested = record.document;
  return {
    name: asString(record.name, "project"),
    document: normalizeDocument(nested === undefined ? record : nested),
  };
}
