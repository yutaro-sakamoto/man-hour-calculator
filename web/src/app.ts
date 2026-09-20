/** 画面が共有する状態と、状態を変えるための入り口。 */

import type { ComputeResult } from "./wasm.ts";
import type { ScheduleModel } from "./model/schedule.ts";
import type { TreeRow } from "./model/tree.ts";
import type { ColumnMode, Project, TaskFilter } from "./types.ts";
import type { ResolvedMembers } from "./model/members.ts";

export type TabId = "tasks" | "members" | "calendar" | "distribution" | "schedule";
export const TABS: readonly TabId[] = ["tasks", "members", "calendar", "distribution", "schedule"];

export interface AppState {
  project: Project;
  /** 親子関係を解決した行。`project.tasks` と同じ並び。 */
  rows: TreeRow[];
  result: ComputeResult | null;
  schedule: ScheduleModel | null;
  /** 未割当ぶんを補った人員一覧。計算に渡した並びと一致する。 */
  members: ResolvedMembers;
  filter: TaskFilter;
  columnMode: ColumnMode;
  activeTab: TabId;
  /** カレンダーの月表示で見ている月。 */
  calendarMonth: { year: number; month: number };
  /** 月表示で見ている人員の添字。`null` なら全員の合計。 */
  calendarMember: number | null;
  status: { text: string; tone: "info" | "error" };
  /** スケジュールタブで確率を見る日。 */
  probeDate: string | null;
}

/** 再生成せずに使い回す要素 (canvas は作り直すとイベントと状態を失うため)。 */
export interface AppWidgets {
  distributionFigure: HTMLElement;
  scheduleFigure: HTMLElement;
}

export interface AppActions {
  /** プロジェクトを変更して、再計算と再描画まで行う。 */
  mutate: (change: (project: Project) => void) => void;
  /** 計算に影響しない表示の変更。 */
  patch: (change: (state: AppState) => void) => void;
  render: () => void;
}
