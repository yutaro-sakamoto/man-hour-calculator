/**
 * 同じ HTML に載っている WASM を呼ぶ API クライアント。
 *
 * サーバに繋がっていないときはこちらが使われる。ネットワークは介さないが、
 * 通る道は同じで、権限の判定も不変条件も `crates/api` の実装が行う。
 * 「ローカルだから素通し」ということはない。
 *
 * ワークスペース (アカウント・プロジェクト・権限) は WASM のなかに丸ごとあり、
 * 変更のたびに JSON で取り出してブラウザに保存する。サーバで言えば
 * データベースにあたるものを、そのままブラウザに置いている形。
 */

import { apiCall, exportState, importState } from "../wasm.ts";
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

/** WASM が返す封筒。`crates/api/src/protocol.rs` の `Outcome` と対応する。 */
type Outcome =
  | { ok: "true"; reply: { kind: string; value?: unknown } }
  | { ok: "false"; status: number; error: { code: ApiErrorCode; message: string } };

const STORAGE_KEY = "mhc.workspace.v1";

export class LocalApiClient implements ApiClient {
  readonly label = "local";
  readonly remote = false;

  constructor(private actor: UserId) {}

  /** 誰として操作するかを切り替える。ローカルにはログインが無いための仕組み。 */
  actAs(userId: UserId): void {
    this.actor = userId;
  }

  currentActor(): UserId {
    return this.actor;
  }

  /* ===== 保存と復元 ===== */

  /** 保存しておいたワークスペースを読む。無ければ `false`。 */
  static restore(): boolean {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // プライベートモードなどで読めないことがある。空から始める。
      return false;
    }
    if (saved === null) return false;
    const outcome = JSON.parse(importState(saved)) as Outcome;
    return outcome.ok === "true";
  }

  /** いまのワークスペースを保存する。 */
  static persist(): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, exportState());
      return true;
    } catch {
      return false;
    }
  }

  /** ワークスペース全体を JSON で取り出す (ファイルに書き出す用)。 */
  static snapshot(): string {
    return exportState();
  }

  /** ワークスペース全体を差し替える。失敗したら `ApiError`。 */
  static replace(state: string): void {
    const outcome = JSON.parse(importState(state)) as Outcome;
    if (outcome.ok === "false") {
      throw new ApiError(outcome.error.code, outcome.error.message, outcome.status);
    }
  }

  /* ===== 呼び出し ===== */

  private send(request: Record<string, unknown>, mutating: boolean): unknown {
    const envelope = {
      actor: this.actor,
      now: new Date().toISOString(),
      request,
    };
    const outcome = JSON.parse(apiCall(JSON.stringify(envelope))) as Outcome;
    if (outcome.ok === "false") {
      throw new ApiError(outcome.error.code, outcome.error.message, outcome.status);
    }
    if (mutating) LocalApiClient.persist();
    return outcome.reply.value;
  }

  private read<T>(request: Record<string, unknown>): Promise<T> {
    return Promise.resolve(this.send(request, false) as T);
  }

  private write<T>(request: Record<string, unknown>): Promise<T> {
    return Promise.resolve(this.send(request, true) as T);
  }

  me(): Promise<User> {
    return this.read({ op: "me" });
  }

  listUsers(): Promise<User[]> {
    return this.read({ op: "listUsers" });
  }

  createUser(input: NewUserInput): Promise<User> {
    return this.write({ op: "createUser", ...input });
  }

  updateUser(id: UserId, patch: UserPatchInput): Promise<User> {
    return this.write({ op: "updateUser", id, ...patch });
  }

  async deleteUser(id: UserId): Promise<void> {
    await this.write({ op: "deleteUser", id });
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.read({ op: "listProjects" });
  }

  createProject(id: ProjectId, name: string, document?: ProjectDocument): Promise<Project> {
    return this.write({ op: "createProject", id, name, ...(document ? { document } : {}) });
  }

  getProject(id: ProjectId): Promise<Project> {
    return this.read({ op: "getProject", id });
  }

  saveDocument(id: ProjectId, document: ProjectDocument): Promise<ProjectSummary> {
    return this.write({ op: "saveDocument", id, document });
  }

  renameProject(id: ProjectId, name: string): Promise<ProjectSummary> {
    return this.write({ op: "renameProject", id, name });
  }

  async deleteProject(id: ProjectId): Promise<void> {
    await this.write({ op: "deleteProject", id });
  }

  duplicateProject(id: ProjectId, newId: ProjectId, name: string): Promise<Project> {
    return this.write({ op: "duplicateProject", id, newId, name });
  }

  listAccess(id: ProjectId): Promise<ProjectAccess[]> {
    return this.read({ op: "listAccess", id });
  }

  setAccess(id: ProjectId, userId: UserId, role: ProjectRole): Promise<ProjectAccess[]> {
    return this.write({ op: "setAccess", id, userId, role });
  }

  removeAccess(id: ProjectId, userId: UserId): Promise<ProjectAccess[]> {
    return this.write({ op: "removeAccess", id, userId });
  }
}
