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

import type { ApiClient, NewUserInput, UserPatchInput } from "./client.ts";
import {
  ApiError,
  type ApiErrorCode,
  type Project,
  type ProjectAccess,
  type ProjectDocument,
  type ProjectId,
  type ProjectRole,
  type ProjectSummary,
  type User,
  type UserId,
} from "./types.ts";

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
      throw new ApiError("unauthorized", `サーバに接続できません: ${String(cause)}`, 0);
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
    return this.send("PATCH", `/v1/users/${encodeURIComponent(id)}`, patch);
  }

  deleteUser(id: UserId): Promise<void> {
    return this.send("DELETE", `/v1/users/${encodeURIComponent(id)}`);
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.send("GET", "/v1/projects");
  }

  createProject(id: ProjectId, name: string, document?: ProjectDocument): Promise<Project> {
    return this.send("POST", "/v1/projects", { id, name, document });
  }

  getProject(id: ProjectId): Promise<Project> {
    return this.send("GET", `/v1/projects/${encodeURIComponent(id)}`);
  }

  saveDocument(id: ProjectId, document: ProjectDocument): Promise<ProjectSummary> {
    return this.send("PUT", `/v1/projects/${encodeURIComponent(id)}/document`, document);
  }

  renameProject(id: ProjectId, name: string): Promise<ProjectSummary> {
    return this.send("PATCH", `/v1/projects/${encodeURIComponent(id)}`, { name });
  }

  deleteProject(id: ProjectId): Promise<void> {
    return this.send("DELETE", `/v1/projects/${encodeURIComponent(id)}`);
  }

  duplicateProject(id: ProjectId, newId: ProjectId, name: string): Promise<Project> {
    return this.send("POST", `/v1/projects/${encodeURIComponent(id)}/duplicate`, { newId, name });
  }

  listAccess(id: ProjectId): Promise<ProjectAccess[]> {
    return this.send("GET", `/v1/projects/${encodeURIComponent(id)}/access`);
  }

  setAccess(id: ProjectId, userId: UserId, role: ProjectRole): Promise<ProjectAccess[]> {
    return this.send(
      "PUT",
      `/v1/projects/${encodeURIComponent(id)}/access/${encodeURIComponent(userId)}`,
      { role },
    );
  }

  removeAccess(id: ProjectId, userId: UserId): Promise<ProjectAccess[]> {
    return this.send(
      "DELETE",
      `/v1/projects/${encodeURIComponent(id)}/access/${encodeURIComponent(userId)}`,
    );
  }
}
