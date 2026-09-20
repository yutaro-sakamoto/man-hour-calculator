/**
 * API がやり取りする型。`crates/api/src/model.rs` と 1 対 1 に対応する。
 *
 * # 「人」が 2 種類ある
 *
 * - {@link User} … **アカウント**。操作する主体で、権限を持つ。
 * - `Member` … **人員**。工数を消化する稼働資源で、稼働時間帯を持つ。
 *
 * アカウントと人員は 1 対 1 とは限らない (外注や「未割当」のように、
 * ログインしない人員もいる)。
 */

import type { CalendarSettings, ComputeSettings, Task } from "../types.ts";

export type UserId = string;
export type ProjectId = string;
export type UserGroupId = string;
export type ProjectGroupId = string;

/** システム全体での役割。 */
export type SystemRole = "admin" | "member";

/** プロジェクトごとの役割。強い順に owner > editor > viewer。 */
export type ProjectRole = "owner" | "editor" | "viewer";

/** 弱い順に並べたもの。強さの比較に使う。 */
export const PROJECT_ROLES: readonly ProjectRole[] = ["viewer", "editor", "owner"];

/** `role` が `needed` 以上の強さか。 */
export function roleAtLeast(role: ProjectRole | null, needed: ProjectRole): boolean {
  if (role === null) return false;
  return PROJECT_ROLES.indexOf(role) >= PROJECT_ROLES.indexOf(needed);
}

export interface User {
  id: UserId;
  name: string;
  email?: string;
  systemRole: SystemRole;
  createdAt: string;
}

/**
 * 権限を配る相手。アカウント 1 人か、グループ 1 つ。
 *
 * `kind` と `id` の 2 つ組にしてあるのは、HTTP のパス
 * (`…/access/{principalKind}/{principalId}`) にそのまま載るため。
 */
export interface Principal {
  kind: "user" | "group";
  id: string;
}

export const principalUser = (id: UserId): Principal => ({ kind: "user", id });
export const principalGroup = (id: UserGroupId): Principal => ({ kind: "group", id });

/** `Map` の鍵や比較に使える 1 本の文字列。 */
export const principalKey = (principal: Principal): string => `${principal.kind}:${principal.id}`;

export const samePrincipal = (a: Principal, b: Principal): boolean =>
  a.kind === b.kind && a.id === b.id;

export interface AccessEntry {
  principal: Principal;
  role: ProjectRole;
}

/** 部署やチーム。権限をまとめて配るための入れ物。 */
export interface UserGroup {
  id: UserGroupId;
  name: string;
  members: UserId[];
  createdAt: string;
}

/** プロジェクトの入れ物。ここに与えた権限は配下のすべてに継がれる。 */
export interface ProjectGroup {
  id: ProjectGroupId;
  name: string;
  access: AccessEntry[];
  createdAt: string;
}

/**
 * 一度計算した見通しの控え。
 *
 * 一覧のたびに全プロジェクトの中身を計算し直すのは重いので、保存時に
 * 1 回だけ計算してこれを添えて送る。`basedOn` が `updatedAt` と違えば
 * 古いので、画面は数字を見せずに「再計算が必要」と出す。
 */
export interface ProjectStatus {
  computedAt: string;
  /** 計算の元にした内容の `updatedAt`。 */
  basedOn: string;
  effortP50: number;
  effortP80: number;
  /** 1970-01-01 からの日数。期間内に終わらなければ null。 */
  finishP50: number | null;
  finishP80: number | null;
  spent: number;
  /** 0.0 〜 1.0。 */
  progress: number;
  taskCount: number;
  doneCount: number;
}

/**
 * 一覧に出す状態。判定は `crates/api/src/health.rs` が唯一の実装で、
 * 画面はその結果を受け取るだけ。
 */
export type ProjectHealth =
  "noTasks" | "unknown" | "done" | "onTrack" | "atRisk" | "late" | "behindPace" | "inProgress";

/** 手当てが要る状態か。色だけでなく並び順と注記にも使う。 */
export const needsAttention = (health: ProjectHealth): boolean =>
  health === "late" || health === "behindPace" || health === "atRisk";

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 一覧を求めた本人の実効的な役割 (グループ経由を含む)。 */
  role: ProjectRole;
  groupId: ProjectGroupId | null;
  groupName: string | null;
  /** YYYY-MM-DD。 */
  dueDate: string | null;
  health: ProjectHealth;
  status: ProjectStatus | null;
  /** 所有者の名前。グループ経由で所有者になっている人も含む。 */
  ownerNames: string[];
  taskCount: number;
  /** 人員 (稼働資源) の数。アカウント数ではない。 */
  memberCount: number;
}

/** プロジェクトの中身。画面が編集するのはここ。 */
export interface ProjectDocument {
  tasks: Task[];
  calendar: CalendarSettings;
  settings: ComputeSettings;
}

export interface Project {
  id: ProjectId;
  name: string;
  createdAt: string;
  updatedAt: string;
  groupId: ProjectGroupId | null;
  dueDate: string | null;
  /** このプロジェクトへの直接の付与。グループ経由の分は含まない。 */
  access: AccessEntry[];
  status: ProjectStatus | null;
  taskCount: number;
  memberCount: number;
  document: ProjectDocument;
}

/** 失敗の種類。HTTP のステータスに対応する。 */
export type ApiErrorCode =
  "unauthorized" | "forbidden" | "notFound" | "invalid" | "conflict" | "internal";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
