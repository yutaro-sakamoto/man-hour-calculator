/** プロジェクト (保存・読み込みの単位) の生成と検証。 */

import { todayIso } from "../format.ts";
import type {
  CalendarEventItem,
  CalendarSettings,
  ComputeSettings,
  Priority,
  Project,
  Task,
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
    ...overrides,
  };
}

export function defaultCalendar(): CalendarSettings {
  const today = todayIso();
  return {
    startDate: today,
    workdays: [false, true, true, true, true, true, false],
    hoursPerDay: 8,
    hoursPerPersonDay: 8,
    teamSize: 1,
    useJapaneseHolidays: true,
    horizonDays: 365,
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

export function emptyProject(name: string): Project {
  return {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    name,
    tasks: [],
    calendar: defaultCalendar(),
    settings: defaultSettings(),
  };
}

/** 機能をひととおり触れる見本データ。 */
export function sampleProject(lang: "ja" | "en"): Project {
  const label = (ja: string, en: string): string => (lang === "ja" ? ja : en);
  const project = emptyProject(label("サンプル案件", "Sample project"));

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
    }),
    createTask({
      name: label("基本設計", "Architecture"),
      parentId: design.id,
      group: label("設計", "Design"),
      min: "3",
      likely: "5",
      max: "12",
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
    }),
    createTask({
      name: label("画面実装", "UI implementation"),
      parentId: build.id,
      group: label("実装", "Build"),
      min: "10",
      likely: "15",
      max: "40",
    }),
    createTask({
      name: label("バッチ実装", "Batch jobs"),
      parentId: build.id,
      group: label("実装", "Build"),
      priority: "low",
      min: "2",
      likely: "4",
      max: "9",
    }),
    createTask({
      name: label("テストとリリース", "Test and release"),
      group: label("QA", "QA"),
      min: "3",
      likely: "6",
      max: "14",
    }),
  ];
  return project;
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

function normalizeTask(raw: unknown, knownIds: Set<string>): Task {
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
  };
}

function normalizeEvent(raw: unknown): CalendarEventItem | null {
  const record = asRecord(raw);
  const startDate = asIsoDate(record.startDate);
  if (startDate === null) return null;
  const hours = record.hours;
  return {
    id: asString(record.id) || newId(),
    name: asString(record.name),
    startDate,
    endDate: asIsoDate(record.endDate) ?? startDate,
    hours: typeof hours === "number" && Number.isFinite(hours) && hours >= 0 ? hours : null,
  };
}

function normalizeCalendar(raw: unknown): CalendarSettings {
  const record = asRecord(raw);
  const base = defaultCalendar();
  const workdays = record.workdays;
  const events = record.events;
  const forced = record.forcedWorkdays;
  return {
    startDate: asIsoDate(record.startDate) ?? base.startDate,
    workdays: Array.isArray(workdays)
      ? (base.workdays.map((on, i) => asBoolean(workdays[i], on)) as CalendarSettings["workdays"])
      : base.workdays,
    hoursPerDay: Math.max(0, asNumber(record.hoursPerDay, base.hoursPerDay)),
    hoursPerPersonDay: Math.max(0.1, asNumber(record.hoursPerPersonDay, base.hoursPerPersonDay)),
    teamSize: Math.max(0, asNumber(record.teamSize, base.teamSize)),
    useJapaneseHolidays: asBoolean(record.useJapaneseHolidays, base.useJapaneseHolidays),
    horizonDays: Math.min(1830, Math.max(1, asNumber(record.horizonDays, base.horizonDays))),
    events: Array.isArray(events)
      ? events.map(normalizeEvent).filter((e): e is CalendarEventItem => e !== null)
      : [],
    forcedWorkdays: Array.isArray(forced)
      ? forced.map(asIsoDate).filter((d): d is string => d !== null)
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
 * 読み込んだ JSON をプロジェクトに整える。
 *
 * 形が違うものは例外を投げず、項目ごとに既定値へ落とす。
 * ただしスキーマ名が違う場合だけは、別物のファイルとみなして `null` を返す。
 */
export function normalizeProject(raw: unknown): Project | null {
  const record = asRecord(raw);
  if (asString(record.schema) !== SCHEMA) return null;

  const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
  const knownIds = new Set<string>(
    rawTasks.map((task) => asString(asRecord(task).id)).filter((id) => id !== ""),
  );
  return {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    savedAt: asString(record.savedAt, new Date().toISOString()),
    name: asString(record.name, "project"),
    tasks: rawTasks.map((task) => normalizeTask(task, knownIds)),
    calendar: normalizeCalendar(record.calendar),
    settings: normalizeSettings(record.settings),
  };
}
