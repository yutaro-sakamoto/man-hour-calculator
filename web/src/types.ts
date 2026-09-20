/** アプリ全体で共有するドメイン型。 */

export type Priority = "high" | "normal" | "low";
export const PRIORITIES: readonly Priority[] = ["high", "normal", "low"];

/** タスクの進行状態。Rust 側の `TaskState` と対応する。 */
export type TaskState = "notStarted" | "inProgress" | "done";

export type EngineId = 0 | 1;
export type DistId = 0 | 1;

/** `YYYY-MM-DD` 形式の暦日。 */
export type IsoDate = string;

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
}

/** 稼働に影響する予定。 */
export interface CalendarEventItem {
  id: string;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  /** 1 人あたり失われる時間。`null` は終日休み。 */
  hours: number | null;
}

export interface CalendarSettings {
  startDate: IsoDate;
  /** 日曜〜土曜の稼働フラグ。 */
  workdays: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  hoursPerDay: number;
  hoursPerPersonDay: number;
  teamSize: number;
  useJapaneseHolidays: boolean;
  /** 何日先まで見るか。 */
  horizonDays: number;
  events: CalendarEventItem[];
  /** 週末・祝日でも稼働する日。 */
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
}

/** 表に出す列のまとまり。 */
export type ColumnMode = "estimate" | "actual" | "all";
