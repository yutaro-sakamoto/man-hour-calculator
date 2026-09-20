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
  AccessEntry,
  Comment,
  CommentId,
  Principal,
  Project,
  ProjectDocument,
  ProjectGroup,
  ProjectGroupId,
  ProjectId,
  ProjectRole,
  ProjectStatus,
  ProjectSummary,
  SystemRole,
  User,
  UserGroup,
  UserGroupId,
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

/**
 * プロジェクトの見出しの変更。省略した項目は据え置き。
 *
 * `clearGroup` / `clearDueDate` があるのは、「空にする」と「触らない」を
 * 区別するため (JSON では `undefined` が消えてしまうので、明示的な旗にする)。
 */
export interface ProjectPatchInput {
  name?: string;
  groupId?: ProjectGroupId;
  clearGroup?: boolean;
  /** YYYY-MM-DD。 */
  dueDate?: string;
  clearDueDate?: boolean;
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

  listUserGroups: () => Promise<UserGroup[]>;
  createUserGroup: (id: UserGroupId, name: string) => Promise<UserGroup>;
  renameUserGroup: (id: UserGroupId, name: string) => Promise<UserGroup>;
  deleteUserGroup: (id: UserGroupId) => Promise<void>;
  addGroupMember: (id: UserGroupId, userId: UserId) => Promise<UserGroup>;
  removeGroupMember: (id: UserGroupId, userId: UserId) => Promise<UserGroup>;

  listProjectGroups: () => Promise<ProjectGroup[]>;
  createProjectGroup: (id: ProjectGroupId, name: string) => Promise<ProjectGroup>;
  renameProjectGroup: (id: ProjectGroupId, name: string) => Promise<ProjectGroup>;
  deleteProjectGroup: (id: ProjectGroupId) => Promise<void>;
  setGroupAccess: (
    id: ProjectGroupId,
    principal: Principal,
    role: ProjectRole,
  ) => Promise<ProjectGroup>;
  removeGroupAccess: (id: ProjectGroupId, principal: Principal) => Promise<ProjectGroup>;

  listProjects: () => Promise<ProjectSummary[]>;
  createProject: (id: ProjectId, name: string, document?: ProjectDocument) => Promise<Project>;
  getProject: (id: ProjectId) => Promise<Project>;
  /** `status` を添えると、一覧に出す見通しの控えとして保存する。 */
  saveDocument: (
    id: ProjectId,
    document: ProjectDocument,
    status?: ProjectStatus,
  ) => Promise<ProjectSummary>;
  updateProject: (id: ProjectId, patch: ProjectPatchInput) => Promise<ProjectSummary>;
  deleteProject: (id: ProjectId) => Promise<void>;
  duplicateProject: (id: ProjectId, newId: ProjectId, name: string) => Promise<Project>;

  /** `taskId` を渡すとそのタスク宛てだけ。 */
  listComments: (id: ProjectId, taskId?: string) => Promise<Comment[]>;
  /** 閲覧できれば書ける。 */
  postComment: (
    id: ProjectId,
    commentId: CommentId,
    body: string,
    taskId?: string,
  ) => Promise<Comment>;
  /** 書き直せるのは本人だけ。 */
  editComment: (commentId: CommentId, body: string) => Promise<Comment>;
  /** 消せるのは本人か、プロジェクトの所有者。 */
  deleteComment: (commentId: CommentId) => Promise<void>;

  listAccess: (id: ProjectId) => Promise<AccessEntry[]>;
  setAccess: (id: ProjectId, principal: Principal, role: ProjectRole) => Promise<AccessEntry[]>;
  removeAccess: (id: ProjectId, principal: Principal) => Promise<AccessEntry[]>;
}
