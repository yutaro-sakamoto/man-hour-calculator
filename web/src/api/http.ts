/**
 * サーバに繋ぐ API クライアント。
 *
 * ルートは `docs/openapi.yaml` のとおりで、`crates/api` の
 * `Request::route` が唯一の正。サーバ側のハンドラは、受け取った HTTP を
 * 同じ `Service` に取り次ぐだけになる。
 *
 * まだサーバを建てていないので、ここは「差し替え先が用意されている」ことを
 * 示す実装。接続先を設定した時点でそのまま使える。
 */

import type { ApiClient, NewUserInput, ProjectPatchInput, UserPatchInput } from "./client.ts";
import {
  ApiError,
  type AccessEntry,
  type Attachment,
  type Comment,
  type CommentId,
  type ApiErrorCode,
  type Principal,
  type Project,
  type ProjectDocument,
  type ProjectGroup,
  type ProjectGroupId,
  type ProjectId,
  type ProjectRole,
  type ProjectStatus,
  type ProjectSummary,
  type User,
  type UserGroup,
  type UserGroupId,
  type UserId,
} from "./types.ts";

/** パスに埋める 1 片。`/` などが混ざっても壊れないようにする。 */
const seg = (value: string): string => encodeURIComponent(value);

/** `…/access/{principalKind}/{principalId}` の末尾。 */
const principalPath = (principal: Principal): string =>
  `${seg(principal.kind)}/${seg(principal.id)}`;

interface ErrorBody {
  code?: ApiErrorCode;
  message?: string;
}

export interface HttpClientOptions {
  baseUrl: string;
  /** Bearer トークン。省略すると付けない。 */
  token?: string;
}

export class HttpApiClient implements ApiClient {
  readonly remote = true;
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(options: HttpClientOptions) {
    // 末尾のスラッシュは落としておく (パスと二重にならないように)。
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
  }

  get label(): string {
    return this.baseUrl;
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token !== undefined) headers.Authorization = `Bearer ${this.token}`;

    const init: RequestInit = { method, headers, credentials: "same-origin" };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      // 通信そのものが失敗した場合も、画面の扱いを揃えるため ApiError に包む。
      // 届かなかったのであって、断られたのではない。
      throw new ApiError("offline", String(cause), 0);
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const parsed: unknown = text === "" ? null : JSON.parse(text);

    if (!response.ok) {
      const error = (parsed ?? {}) as ErrorBody;
      throw new ApiError(
        error.code ?? "invalid",
        error.message ?? `HTTP ${String(response.status)}`,
        response.status,
      );
    }
    return parsed as T;
  }

  me(): Promise<User> {
    return this.send("GET", "/v1/me");
  }

  listUsers(): Promise<User[]> {
    return this.send("GET", "/v1/users");
  }

  createUser(input: NewUserInput): Promise<User> {
    return this.send("POST", "/v1/users", input);
  }

  updateUser(id: UserId, patch: UserPatchInput): Promise<User> {
    return this.send("PATCH", `/v1/users/${seg(id)}`, patch);
  }

  deleteUser(id: UserId): Promise<void> {
    return this.send("DELETE", `/v1/users/${seg(id)}`);
  }

  listUserGroups(): Promise<UserGroup[]> {
    return this.send("GET", "/v1/user-groups");
  }

  createUserGroup(id: UserGroupId, name: string): Promise<UserGroup> {
    return this.send("POST", "/v1/user-groups", { id, name });
  }

  renameUserGroup(id: UserGroupId, name: string): Promise<UserGroup> {
    return this.send("PATCH", `/v1/user-groups/${seg(id)}`, { name });
  }

  deleteUserGroup(id: UserGroupId): Promise<void> {
    return this.send("DELETE", `/v1/user-groups/${seg(id)}`);
  }

  addGroupMember(id: UserGroupId, userId: UserId): Promise<UserGroup> {
    return this.send("PUT", `/v1/user-groups/${seg(id)}/members/${seg(userId)}`);
  }

  removeGroupMember(id: UserGroupId, userId: UserId): Promise<UserGroup> {
    return this.send("DELETE", `/v1/user-groups/${seg(id)}/members/${seg(userId)}`);
  }

  listProjectGroups(): Promise<ProjectGroup[]> {
    return this.send("GET", "/v1/project-groups");
  }

  createProjectGroup(id: ProjectGroupId, name: string): Promise<ProjectGroup> {
    return this.send("POST", "/v1/project-groups", { id, name });
  }

  renameProjectGroup(id: ProjectGroupId, name: string): Promise<ProjectGroup> {
    return this.send("PATCH", `/v1/project-groups/${seg(id)}`, { name });
  }

  deleteProjectGroup(id: ProjectGroupId): Promise<void> {
    return this.send("DELETE", `/v1/project-groups/${seg(id)}`);
  }

  setGroupAccess(
    id: ProjectGroupId,
    principal: Principal,
    role: ProjectRole,
  ): Promise<ProjectGroup> {
    return this.send("PUT", `/v1/project-groups/${seg(id)}/access/${principalPath(principal)}`, {
      role,
    });
  }

  removeGroupAccess(id: ProjectGroupId, principal: Principal): Promise<ProjectGroup> {
    return this.send("DELETE", `/v1/project-groups/${seg(id)}/access/${principalPath(principal)}`);
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.send("GET", "/v1/projects");
  }

  createProject(id: ProjectId, name: string, document?: ProjectDocument): Promise<Project> {
    return this.send("POST", "/v1/projects", { id, name, document });
  }

  getProject(id: ProjectId): Promise<Project> {
    return this.send("GET", `/v1/projects/${seg(id)}`);
  }

  saveDocument(
    id: ProjectId,
    document: ProjectDocument,
    status?: ProjectStatus,
  ): Promise<ProjectSummary> {
    return this.send("PUT", `/v1/projects/${seg(id)}/document`, {
      document,
      ...(status ? { status } : {}),
    });
  }

  updateProject(id: ProjectId, patch: ProjectPatchInput): Promise<ProjectSummary> {
    return this.send("PATCH", `/v1/projects/${seg(id)}`, patch);
  }

  deleteProject(id: ProjectId): Promise<void> {
    return this.send("DELETE", `/v1/projects/${seg(id)}`);
  }

  duplicateProject(id: ProjectId, newId: ProjectId, name: string): Promise<Project> {
    return this.send("POST", `/v1/projects/${seg(id)}/duplicate`, { newId, name });
  }

  listComments(id: ProjectId, taskId?: string): Promise<Comment[]> {
    const query = taskId === undefined ? "" : `?taskId=${encodeURIComponent(taskId)}`;
    return this.send("GET", `/v1/projects/${seg(id)}/comments${query}`);
  }

  postComment(
    id: ProjectId,
    commentId: CommentId,
    body: string,
    taskId?: string,
    attachments: Attachment[] = [],
  ): Promise<Comment> {
    return this.send("POST", `/v1/projects/${seg(id)}/comments`, {
      commentId,
      body,
      attachments,
      ...(taskId === undefined ? {} : { taskId }),
    });
  }

  editComment(
    commentId: CommentId,
    body: string,
    attachments: Attachment[] = [],
  ): Promise<Comment> {
    return this.send("PATCH", `/v1/comments/${seg(commentId)}`, { body, attachments });
  }

  deleteComment(commentId: CommentId): Promise<void> {
    return this.send("DELETE", `/v1/comments/${seg(commentId)}`);
  }

  listAccess(id: ProjectId): Promise<AccessEntry[]> {
    return this.send("GET", `/v1/projects/${seg(id)}/access`);
  }

  setAccess(id: ProjectId, principal: Principal, role: ProjectRole): Promise<AccessEntry[]> {
    return this.send("PUT", `/v1/projects/${seg(id)}/access/${principalPath(principal)}`, { role });
  }

  removeAccess(id: ProjectId, principal: Principal): Promise<AccessEntry[]> {
    return this.send("DELETE", `/v1/projects/${seg(id)}/access/${principalPath(principal)}`);
  }
}
