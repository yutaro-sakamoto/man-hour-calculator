/** 画面が共有する状態と、状態を変えるための入り口。 */

import type { ApiClient } from "./api/client.ts";
import type {
  Project,
  ProjectDocument,
  ProjectGroup,
  ProjectHealth,
  ProjectRole,
  ProjectSummary,
  User,
  UserGroup,
} from "./api/types.ts";
import { roleAtLeast } from "./api/types.ts";
import type { Connection } from "./model/connection.ts";
import type { ResolvedMembers } from "./model/members.ts";
import type { ScheduleModel } from "./model/schedule.ts";
import type { TreeRow } from "./model/tree.ts";
import type { ColumnMode, TaskFilter } from "./types.ts";
import type { ComputeResult } from "./wasm.ts";

export type TabId = "projects" | "tasks" | "members" | "calendar" | "distribution" | "schedule";

export const TABS: readonly TabId[] = [
  "projects",
  "tasks",
  "members",
  "calendar",
  "distribution",
  "schedule",
];

/** いま開いているプロジェクト。 */
export interface OpenProject {
  id: string;
  name: string;
  /** 自分の役割。 */
  role: ProjectRole;
  access: Project["access"];
  updatedAt: string;
}

export interface AppState {
  /** API の接続先。ローカルの WASM かサーバか。 */
  client: ApiClient;
  /** 自分のアカウント。 */
  me: User;
  /** 共有先を選ぶためのアカウント一覧。 */
  users: User[];
  /** 共有先に選べるグループ。 */
  userGroups: UserGroup[];
  /** プロジェクトの入れ物。 */
  projectGroups: ProjectGroup[];
  /** 自分が見られるプロジェクトの一覧。 */
  projects: ProjectSummary[];
  projectFilter: ProjectFilter;
  projectSort: ProjectSort;
  /** 畳めるカードのうち、開いているものの id。描き直しても畳まれないように持つ。 */
  openPanels: Record<string, boolean>;
  /** いま開いているもの。1 件も無ければ null。 */
  open: OpenProject | null;
  /** 編集中の内容。 */
  document: ProjectDocument;

  /** 親子関係を解決した行。`document.tasks` と同じ並び。 */
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

/** プロジェクト一覧の絞り込み。空文字は「すべて」。 */
export interface ProjectFilter {
  text: string;
  group: string;
  health: ProjectHealth | "" | "attention";
  role: ProjectRole | "";
}

/**
 * 並び順。既定は `attention` — **手当てが要るものから**。
 * 遅れているプロジェクトが下のほうに埋もれないようにするため。
 */
export type ProjectSort = "attention" | "due" | "updated" | "name";

export const PROJECT_SORTS: readonly ProjectSort[] = ["attention", "due", "updated", "name"];

/** 書き換えてよいか。閲覧者には編集させない。 */
export function canWrite(state: AppState): boolean {
  return roleAtLeast(state.open?.role ?? null, "editor");
}

/** 改名・削除・共有の設定ができるか。 */
export function canManage(state: AppState): boolean {
  return roleAtLeast(state.open?.role ?? null, "owner");
}

/** 再生成せずに使い回す要素 (canvas は作り直すとイベントと状態を失うため)。 */
export interface AppWidgets {
  distributionFigure: HTMLElement;
  scheduleFigure: HTMLElement;
}

export interface AppActions {
  /** 内容を変更して、再計算・保存・再描画まで行う。 */
  mutate: (change: (document: ProjectDocument) => void) => void;
  /** 計算に影響しない表示の変更。 */
  patch: (change: (state: AppState) => void) => void;
  /** API を呼び、失敗したら状態表示に出す。成功すれば再描画する。 */
  run: (action: () => Promise<void>) => void;
  /** プロジェクトを開き直す。 */
  openProject: (id: string) => Promise<void>;
  /**
   * 控えが古いプロジェクトを計算し直して保存する。更新できた件数を返す。
   *
   * 中身を読み込んで手元の WASM で回すので、サーバは何も計算しない。
   */
  recomputeStatuses: (ids: readonly string[]) => Promise<number>;
  /** サーバへの接続先を切り替える。`null` でローカルに戻る。 */
  connect: (connection: Connection | null) => Promise<void>;
  render: () => void;
}
