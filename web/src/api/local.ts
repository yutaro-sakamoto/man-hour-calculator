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

  /**
   * 保存しておいたワークスペースを読む。
   *
   * **「無い」と「読めない」を区別する。** 一緒くたにすると、読めない状態を
   * 「まっさら」とみなして空のワークスペースで上書きしてしまう。版を上げた
   * あとに古い HTML を開いただけで、手元のプロジェクトが全部消える。
   */
  static restore(): "ok" | "empty" | "unreadable" {
    let saved: string | null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // プライベートモードなどで読めないことがある。空から始める。
      return "empty";
    }
    if (saved === null) return "empty";
    const outcome = JSON.parse(importState(saved)) as Outcome;
    if (outcome.ok === "true") return "ok";
    // 読めないものを潰さない。書き込みを止めて、そのまま残す。
    LocalApiClient.sealed = true;
    return "unreadable";
  }

  /**
   * 保存を止める。読めない内容を上書きしないための封。
   *
   * 一度封をしたら、その画面が開いている間は書かない。
   */
  private static sealed = false;

  /** 直近の保存に失敗したか。失敗したままなら自動保存は効いていない。 */
  private static failed = false;

  /**
   * 保存できない状態か。画面はこれを見て注意書きを出す。
   *
   * 読めない内容を守るために止めている場合と、書き込みそのものが
   * 失敗している場合 (容量不足・プライベートモード) の両方を指す。
   */
  static storageBroken(): boolean {
    return LocalApiClient.sealed || LocalApiClient.failed;
  }

  /** いまのワークスペースを保存する。 */
  static persist(): boolean {
    if (LocalApiClient.sealed) return false;
    try {
      localStorage.setItem(STORAGE_KEY, exportState());
      LocalApiClient.failed = false;
      return true;
    } catch {
      // 容量不足やプライベートモード。**黙って捨てない** — 画面に出す。
      LocalApiClient.failed = true;
      return false;
    }
  }

  /**
   * あと何バイト書けそうか。分からなければ `null`。
   *
   * 添付する**前に**見る。localStorage は変更のたびにワークスペース全体を
   * 書き直すので、溢れるときは保存そのものが落ちる。付け終わってから
   * 「保存できませんでした」と言われても、もう遅い。
   */
  static remainingBytes(): number | null {
    try {
      const used = exportState().length;
      // だいたい 5 MiB。UTF-16 で数える実装があるので、文字数を
      // そのままバイト数とみなして辛めに見ておく。
      return Math.max(0, 5 * 1024 * 1024 - used);
    } catch {
      return null;
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

  listUserGroups(): Promise<UserGroup[]> {
    return this.read({ op: "listUserGroups" });
  }

  createUserGroup(id: UserGroupId, name: string): Promise<UserGroup> {
    return this.write({ op: "createUserGroup", id, name });
  }

  renameUserGroup(id: UserGroupId, name: string): Promise<UserGroup> {
    return this.write({ op: "renameUserGroup", id, name });
  }

  async deleteUserGroup(id: UserGroupId): Promise<void> {
    await this.write({ op: "deleteUserGroup", id });
  }

  addGroupMember(id: UserGroupId, userId: UserId): Promise<UserGroup> {
    return this.write({ op: "addGroupMember", id, userId });
  }

  removeGroupMember(id: UserGroupId, userId: UserId): Promise<UserGroup> {
    return this.write({ op: "removeGroupMember", id, userId });
  }

  listProjectGroups(): Promise<ProjectGroup[]> {
    return this.read({ op: "listProjectGroups" });
  }

  createProjectGroup(id: ProjectGroupId, name: string): Promise<ProjectGroup> {
    return this.write({ op: "createProjectGroup", id, name });
  }

  renameProjectGroup(id: ProjectGroupId, name: string): Promise<ProjectGroup> {
    return this.write({ op: "renameProjectGroup", id, name });
  }

  async deleteProjectGroup(id: ProjectGroupId): Promise<void> {
    await this.write({ op: "deleteProjectGroup", id });
  }

  setGroupAccess(
    id: ProjectGroupId,
    principal: Principal,
    role: ProjectRole,
  ): Promise<ProjectGroup> {
    return this.write({ op: "setGroupAccess", id, principal, role });
  }

  removeGroupAccess(id: ProjectGroupId, principal: Principal): Promise<ProjectGroup> {
    return this.write({ op: "removeGroupAccess", id, principal });
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

  saveDocument(
    id: ProjectId,
    document: ProjectDocument,
    status?: ProjectStatus,
  ): Promise<ProjectSummary> {
    return this.write({ op: "saveDocument", id, document, ...(status ? { status } : {}) });
  }

  updateProject(id: ProjectId, patch: ProjectPatchInput): Promise<ProjectSummary> {
    return this.write({ op: "updateProject", id, ...patch });
  }

  async deleteProject(id: ProjectId): Promise<void> {
    await this.write({ op: "deleteProject", id });
  }

  duplicateProject(id: ProjectId, newId: ProjectId, name: string): Promise<Project> {
    return this.write({ op: "duplicateProject", id, newId, name });
  }

  listComments(id: ProjectId, taskId?: string): Promise<Comment[]> {
    return this.read({ op: "listComments", id, ...(taskId === undefined ? {} : { taskId }) });
  }

  postComment(
    id: ProjectId,
    commentId: CommentId,
    body: string,
    taskId?: string,
    attachments: Attachment[] = [],
  ): Promise<Comment> {
    return this.write({
      op: "postComment",
      id,
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
    return this.write({ op: "editComment", commentId, body, attachments });
  }

  async deleteComment(commentId: CommentId): Promise<void> {
    await this.write({ op: "deleteComment", commentId });
  }

  listAccess(id: ProjectId): Promise<AccessEntry[]> {
    return this.read({ op: "listAccess", id });
  }

  setAccess(id: ProjectId, principal: Principal, role: ProjectRole): Promise<AccessEntry[]> {
    return this.write({ op: "setAccess", id, principal, role });
  }

  removeAccess(id: ProjectId, principal: Principal): Promise<AccessEntry[]> {
    return this.write({ op: "removeAccess", id, principal });
  }
}
