/** アプリ全体で共有するドメイン型。 */

export type Priority = "high" | "normal" | "low";
export const PRIORITIES: readonly Priority[] = ["high", "normal", "low"];

/** タスクの進行状態。Rust 側の `TaskState` と対応する。 */
export type TaskState = "notStarted" | "inProgress" | "done";

export type EngineId = 0 | 1;
export type DistId = 0 | 1;

/** `YYYY-MM-DD` 形式の暦日。 */
export type IsoDate = string;

/** `HH:MM` 形式の時刻。 */
export type TimeOfDay = string;

/** 曜日ごとの稼働時間帯。`start === end` なら非稼働。 */
export interface WorkWindow {
  start: TimeOfDay;
  end: TimeOfDay;
}

/** 稼働する人。 */
export interface Member {
  id: string;
  name: string;
  /** 日曜から土曜までの 7 件。 */
  workdays: WorkWindow[];
  /** 稼働日 1 日あたりの休憩分数。 */
  breakMinutes: number;
}

export interface Task {
  id: string;
  name: string;
  /** 親タスクの id。トップレベルなら null。 */
  parentId: string | null;
  /** 自由記入のグループ名。空文字なら未分類。 */
  group: string;
  priority: Priority;
  /** 計算に含めるか。子を持つタスクを外すと、その配下もまとめて外れる。 */
  enabled: boolean;
  /** 3 点見積もり。子を持つタスクでは使われず、配下の合計が表示される。 */
  min: string;
  likely: string;
  max: string;
  /** 実績。 */
  startDate: IsoDate | null;
  /** 進捗率 (0〜100)。 */
  progress: number;
  endDate: IsoDate | null;
  /** 担当する人員の id。`null` なら未割当。 */
  assigneeId: string | null;
}

/** 繰り返しの間隔 (週)。`0` なら繰り返さない。 */
export type RepeatWeeks = number;

/** 稼働に影響する予定。複数人で共有されることがある。 */
export interface CalendarEventItem {
  id: string;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  /** 開始・終了時刻。`null` なら終日。 */
  startTime: TimeOfDay | null;
  endTime: TimeOfDay | null;
  /** 0 = 繰り返さない、1 = 毎週、2 = 隔週、4 = 4 週ごと。 */
  repeatWeeks: RepeatWeeks;
  /** 繰り返しの終了日。`null` なら期間いっぱい。 */
  until: IsoDate | null;
  /** 参加する人員の id。空なら全員が対象。 */
  memberIds: string[];
  /**
   * 休みにした回の**初日**。
   *
   * 繰り返す予定のうち 1 回だけを外すために使う。回の初日で指定するので、
   * 複数日にまたがる回はまるごと消える (途中の 1 日だけ残しても、
   * 予定としての意味を成さないため)。
   */
  excludedDates: IsoDate[];
}

export interface CalendarSettings {
  startDate: IsoDate;
  /** 1 人日を何時間とみなすか。 */
  hoursPerPersonDay: number;
  useJapaneseHolidays: boolean;
  /** 何日先まで見るか。 */
  horizonDays: number;
  members: Member[];
  events: CalendarEventItem[];
  /** 週末・祝日でも全員が稼働する日。 */
  forcedWorkdays: IsoDate[];
  /** 進捗の基準日。 */
  today: IsoDate;
}

export interface ComputeSettings {
  engine: EngineId;
  dist: DistId;
  lambda: number;
  iterations: number;
  seed: number;
  bins: number;
  gridPoints: number;
}

/** 保存・読み込みの単位。ファイルにはこの形のまま JSON で書き出す。 */
export interface Project {
  schema: "man-hour-calculator";
  version: 1;
  savedAt: string;
  name: string;
  tasks: Task[];
  calendar: CalendarSettings;
  settings: ComputeSettings;
}

/** タスク一覧の絞り込み条件。表示だけに効き、計算対象は変えない。 */
export interface TaskFilter {
  text: string;
  group: string;
  priority: Priority | "";
  state: TaskState | "";
  /** 担当者の id。`"\u0000"` は未割当を表す。 */
  assignee: string;
}

/** 表に出す列のまとまり。 */
export type ColumnMode = "estimate" | "actual" | "all";
