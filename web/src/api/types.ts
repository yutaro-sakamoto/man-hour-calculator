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

export interface ProjectAccess {
  userId: UserId;
  role: ProjectRole;
}

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 一覧を求めた本人の役割。 */
  role: ProjectRole;
  ownerName: string;
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
  access: ProjectAccess[];
  document: ProjectDocument;
}

/** 失敗の種類。HTTP のステータスに対応する。 */
export type ApiErrorCode = "unauthorized" | "forbidden" | "notFound" | "invalid" | "conflict";

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
