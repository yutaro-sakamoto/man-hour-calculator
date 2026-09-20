/**
 * クライアントから見た API。
 *
 * 画面はこの口しか知らない。後ろに何があるかは
 *
 * - {@link "./local.ts" | LocalApiClient} … 同じ HTML に載っている WASM
 * - {@link "./http.ts" | HttpApiClient} … 社内サーバやクラウド上のサーバ
 *
 * で差し替わる。どちらも `crates/api` の同じ実装に行き着くので、
 * 権限の判定や不変条件が経路によって変わることはない。
 */

import type {
  Project,
  ProjectAccess,
  ProjectDocument,
  ProjectId,
  ProjectRole,
  ProjectSummary,
  SystemRole,
  User,
  UserId,
} from "./types.ts";

export interface NewUserInput {
  id: UserId;
  name: string;
  email?: string;
  systemRole: SystemRole;
}

export interface UserPatchInput {
  name?: string;
  email?: string;
  /** メールアドレスを空にする。 */
  clearEmail?: boolean;
  systemRole?: SystemRole;
}

export interface ApiClient {
  /** この接続先の呼び名 (画面に出す)。 */
  readonly label: string;
  /** サーバに繋がっているか。ローカルなら false。 */
  readonly remote: boolean;

  me: () => Promise<User>;

  listUsers: () => Promise<User[]>;
  createUser: (input: NewUserInput) => Promise<User>;
  updateUser: (id: UserId, patch: UserPatchInput) => Promise<User>;
  deleteUser: (id: UserId) => Promise<void>;

  listProjects: () => Promise<ProjectSummary[]>;
  createProject: (id: ProjectId, name: string, document?: ProjectDocument) => Promise<Project>;
  getProject: (id: ProjectId) => Promise<Project>;
  saveDocument: (id: ProjectId, document: ProjectDocument) => Promise<ProjectSummary>;
  renameProject: (id: ProjectId, name: string) => Promise<ProjectSummary>;
  deleteProject: (id: ProjectId) => Promise<void>;
  duplicateProject: (id: ProjectId, newId: ProjectId, name: string) => Promise<Project>;

  listAccess: (id: ProjectId) => Promise<ProjectAccess[]>;
  setAccess: (id: ProjectId, userId: UserId, role: ProjectRole) => Promise<ProjectAccess[]>;
  removeAccess: (id: ProjectId, userId: UserId) => Promise<ProjectAccess[]>;
}
