//! HTTP と API のあいだ。
//!
//! ここがやるのは 3 つだけ。
//!
//! 1. 呼び出し元を特定して `actor` を埋める
//! 2. ルートと本文を [`Request`] に組み立てる
//! 3. [`dispatch`] の結果を HTTP の応答に写す
//!
//! **ルートの表は [`mhc_api::protocol::ROUTES`] が唯一の正**で、ここは
//! それに合わせて並べてある。食い違っていないことは
//! `every_documented_route_is_served` が見張っている。
//!
//! # ロック
//!
//! 「読む → 判定 → 書く」で不変条件を守っているので、書き込みのあいだは
//! 他の書き込みを入れない。どちらのロックを取るかは
//! [`Request::is_mutating`] が決める。

use std::sync::{Arc, RwLock};

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use mhc_api::error::ApiError;
use mhc_api::model::{
    CommentId, Document, Principal, ProjectGroupId, ProjectId, ProjectRole, ProjectStatus,
    SystemRole, UserId,
};
use mhc_api::protocol::{dispatch, Envelope, Outcome, Request};
use mhc_api::service::Service;
use serde::Deserialize;

use crate::store::{schema, Sql, SqlStore};
use crate::{auth, clock};

/// 呼び出し元の特定のしかた。
#[derive(Debug, Clone)]
pub enum Auth {
    /// `Authorization: Bearer <トークン>` を見る。
    Token,
    /// 信頼するヘッダに入っている id をそのまま使う。
    ///
    /// 前段 (リバースプロキシや SSO) がそのヘッダを**必ず上書きする**
    /// ことが前提。素のままインターネットに晒すと誰にでもなりすませる。
    Header(String),
    /// 誰でもこのアカウントとして通す。手元で試すとき専用。
    Trusting(UserId),
}

pub struct AppState<C: Sql> {
    pub store: RwLock<SqlStore<C>>,
    pub auth: Auth,
    pub ui: Arc<str>,
    /// API を呼んでよい別の置き場所。空なら**どこからも許さない**。
    pub allow_origins: Vec<String>,
}

pub type App<C> = Arc<AppState<C>>;

impl<C: Sql> AppState<C> {
    /// 毒された錠は開ける。1 つの panic で以後すべてを止めない。
    fn read(&self) -> std::sync::RwLockReadGuard<'_, SqlStore<C>> {
        self.store.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, SqlStore<C>> {
        self.store.write().unwrap_or_else(|e| e.into_inner())
    }

    /// ヘッダから呼び出し元を決める。
    fn actor(&self, headers: &HeaderMap, now: &str) -> Result<UserId, ApiError> {
        match &self.auth {
            Auth::Trusting(user) => Ok(user.clone()),
            Auth::Header(name) => headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(UserId::new)
                .ok_or_else(|| ApiError::unauthorized(format!("{name} ヘッダがありません"))),
            Auth::Token => {
                let header = headers
                    .get(header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok());
                let secret = auth::bearer(header).ok_or_else(|| {
                    ApiError::unauthorized("Authorization: Bearer <トークン> が要ります")
                })?;
                // 「最後に使った日」を書くだけなので、読み取りロックのままでよい。
                // 不変条件には関わらない、独立した 1 行の更新。
                let store = self.read();
                let found = auth::resolve(&mut *store.sql(), secret, clock::day_of(now))?;
                found.ok_or_else(|| ApiError::unauthorized("トークンが通りません"))
            }
        }
    }

    /// 1 回の呼び出しを通す。ここが同期の本体で、非同期側から
    /// `spawn_blocking` で呼ばれる。
    pub fn call(&self, headers: &HeaderMap, request: Request) -> Outcome {
        let now = clock::now();
        let actor = match self.actor(headers, &now) {
            Ok(actor) => actor,
            Err(error) => return Outcome::from_result(Err(error)),
        };
        let envelope = Envelope {
            actor,
            now,
            request,
        };

        if envelope.request.is_mutating() {
            let guard = self.write();
            dispatch(&mut Service::new(&*guard), envelope)
        } else {
            let guard = self.read();
            dispatch(&mut Service::new(&*guard), envelope)
        }
    }
}

/* ===== 応答 ===== */

/// 成功したときの状態コード。
#[derive(Copy, Clone)]
enum Ok_ {
    /// 取れた・変えた。
    Fine,
    /// 作った。
    Created,
}

fn respond(outcome: Outcome, success: Ok_) -> Response {
    match outcome {
        Outcome::Ok { reply } => match reply.body() {
            Some(value) => {
                let code = match success {
                    Ok_::Fine => StatusCode::OK,
                    Ok_::Created => StatusCode::CREATED,
                };
                (code, Json(value)).into_response()
            }
            // 返すものが無い操作 (削除など)。
            None => StatusCode::NO_CONTENT.into_response(),
        },
        Outcome::Err { error, status } => {
            let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (code, Json(error)).into_response()
        }
    }
}

/// 呼び出しを別のスレッドに逃がす。保存先への問い合わせは同期なので、
/// そのまま await の上で回すと実行器を塞いでしまう。
async fn call<C: Sql + 'static>(
    app: App<C>,
    headers: HeaderMap,
    request: Request,
    success: Ok_,
) -> Response {
    let task = tokio::task::spawn_blocking(move || respond(app.call(&headers, request), success));
    match task.await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "処理中に落ちました");
            let failed = ApiError::internal("処理中に問題が起きました");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(failed)).into_response()
        }
    }
}

/// パスに入っていた相手を読み解く。読めなければ、そのまま返す応答を作る。
fn principal(kind: &str, id: &str) -> Result<Principal, Box<Response>> {
    Principal::parse(kind, id).ok_or_else(|| {
        let error = ApiError::invalid(format!("知らない相手の種類です: {kind}"));
        Box::new((StatusCode::UNPROCESSABLE_ENTITY, Json(error)).into_response())
    })
}

/* ===== 本文 ===== */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUserBody {
    id: UserId,
    name: String,
    #[serde(default)]
    email: Option<String>,
    system_role: SystemRole,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateUserBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    clear_email: bool,
    #[serde(default)]
    system_role: Option<SystemRole>,
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdNameBody {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct RoleBody {
    role: ProjectRole,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PostCommentBody {
    comment_id: CommentId,
    #[serde(default)]
    task_id: Option<String>,
    body: String,
}

#[derive(Deserialize)]
struct BodyOnly {
    body: String,
}

/// `?taskId=…` で絞り込む。
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CommentQuery {
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectBody {
    id: ProjectId,
    name: String,
    #[serde(default)]
    document: Document,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDocumentBody {
    document: Document,
    #[serde(default)]
    status: Option<ProjectStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProjectBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    group_id: Option<ProjectGroupId>,
    #[serde(default)]
    clear_group: bool,
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    clear_due_date: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateBody {
    new_id: ProjectId,
    name: String,
}

/* ===== ルート ===== */

/// 別の場所に置いた画面から呼べるようにする層。
///
/// サーバが自分で配る画面を開くぶんには同一オリジンなので、これは要らない。
/// 必要になるのは、GitHub Pages などに置いた 1 枚の HTML から社内サーバを
/// 呼ぶとき。**明示的に挙げた出どころだけ**を通す。`*` は使わない —
/// トークンを載せる API を誰からでも呼べるようにする理由が無い。
fn cors(origins: &[String]) -> Option<tower_http::cors::CorsLayer> {
    if origins.is_empty() {
        return None;
    }
    let parsed: Vec<axum::http::HeaderValue> = origins
        .iter()
        .filter_map(|origin| match origin.parse() {
            Ok(value) => Some(value),
            Err(_) => {
                tracing::warn!(origin, "読み取れない出どころなので無視します");
                None
            }
        })
        .collect();
    if parsed.is_empty() {
        return None;
    }
    Some(
        tower_http::cors::CorsLayer::new()
            .allow_origin(parsed)
            .allow_methods([
                axum::http::Method::GET,
                axum::http::Method::POST,
                axum::http::Method::PUT,
                axum::http::Method::PATCH,
                axum::http::Method::DELETE,
            ])
            .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
    )
}

/// 組み立てたルータ。テストからも同じものを使う。
pub fn router<C: Sql + 'static>(app: App<C>) -> Router {
    let allowed = cors(&app.allow_origins);
    let routes = Router::new()
        .route("/v1/me", get(me::<C>))
        .route("/v1/users", get(list_users::<C>).post(create_user::<C>))
        .route(
            "/v1/users/{userId}",
            patch(update_user::<C>).delete(delete_user::<C>),
        )
        .route(
            "/v1/user-groups",
            get(list_user_groups::<C>).post(create_user_group::<C>),
        )
        .route(
            "/v1/user-groups/{groupId}",
            patch(rename_user_group::<C>).delete(delete_user_group::<C>),
        )
        .route(
            "/v1/user-groups/{groupId}/members/{userId}",
            put(add_group_member::<C>).delete(remove_group_member::<C>),
        )
        .route(
            "/v1/project-groups",
            get(list_project_groups::<C>).post(create_project_group::<C>),
        )
        .route(
            "/v1/project-groups/{groupId}",
            patch(rename_project_group::<C>).delete(delete_project_group::<C>),
        )
        .route(
            "/v1/project-groups/{groupId}/access/{principalKind}/{principalId}",
            put(set_group_access::<C>).delete(remove_group_access::<C>),
        )
        .route(
            "/v1/projects",
            get(list_projects::<C>).post(create_project::<C>),
        )
        .route(
            "/v1/projects/{projectId}",
            get(get_project::<C>)
                .patch(update_project::<C>)
                .delete(delete_project::<C>),
        )
        .route("/v1/projects/{projectId}/document", put(save_document::<C>))
        .route(
            "/v1/projects/{projectId}/duplicate",
            post(duplicate_project::<C>),
        )
        .route(
            "/v1/projects/{projectId}/comments",
            get(list_comments::<C>).post(post_comment::<C>),
        )
        .route(
            "/v1/comments/{commentId}",
            patch(edit_comment::<C>).delete(delete_comment::<C>),
        )
        .route("/v1/projects/{projectId}/access", get(list_access::<C>))
        .route(
            "/v1/projects/{projectId}/access/{principalKind}/{principalId}",
            put(set_access::<C>).delete(remove_access::<C>),
        )
        .route("/healthz", get(healthz))
        // 画面。知らないパスもここに落とすので、深いリンクを開いても出る。
        .route("/", get(ui::<C>))
        .fallback(get(ui::<C>))
        .layer(tower_http::catch_panic::CatchPanicLayer::new())
        .layer(tower_http::trace::TraceLayer::new_for_http());

    match allowed {
        Some(layer) => routes.layer(layer).with_state(app),
        None => routes.with_state(app),
    }
}

async fn healthz() -> Response {
    Json(serde_json::json!({
        "status": "ok",
        "api": mhc_api::API_VERSION,
        "schema": schema::SCHEMA_VERSION,
    }))
    .into_response()
}

async fn ui<C: Sql + 'static>(State(app): State<App<C>>) -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        app.ui.to_string(),
    )
        .into_response()
}

/* --- 自分 --- */

async fn me<C: Sql + 'static>(State(app): State<App<C>>, headers: HeaderMap) -> Response {
    call(app, headers, Request::Me, Ok_::Fine).await
}

/* --- アカウント --- */

async fn list_users<C: Sql + 'static>(State(app): State<App<C>>, headers: HeaderMap) -> Response {
    call(app, headers, Request::ListUsers, Ok_::Fine).await
}

async fn create_user<C: Sql + 'static>(
    State(app): State<App<C>>,
    headers: HeaderMap,
    Json(body): Json<CreateUserBody>,
) -> Response {
    let request = Request::CreateUser {
        id: body.id,
        name: body.name,
        email: body.email,
        system_role: body.system_role,
    };
    call(app, headers, request, Ok_::Created).await
}

async fn update_user<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<UpdateUserBody>,
) -> Response {
    let request = Request::UpdateUser {
        id: UserId::new(id),
        name: body.name,
        email: body.email,
        clear_email: body.clear_email,
        system_role: body.system_role,
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn delete_user<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request = Request::DeleteUser {
        id: UserId::new(id),
    };
    call(app, headers, request, Ok_::Fine).await
}

/* --- アカウントのグループ --- */

async fn list_user_groups<C: Sql + 'static>(
    State(app): State<App<C>>,
    headers: HeaderMap,
) -> Response {
    call(app, headers, Request::ListUserGroups, Ok_::Fine).await
}

async fn create_user_group<C: Sql + 'static>(
    State(app): State<App<C>>,
    headers: HeaderMap,
    Json(body): Json<IdNameBody>,
) -> Response {
    let request = Request::CreateUserGroup {
        id: mhc_api::model::UserGroupId::new(body.id),
        name: body.name,
    };
    call(app, headers, request, Ok_::Created).await
}

async fn rename_user_group<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<NameBody>,
) -> Response {
    let request = Request::RenameUserGroup {
        id: mhc_api::model::UserGroupId::new(id),
        name: body.name,
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn delete_user_group<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request = Request::DeleteUserGroup {
        id: mhc_api::model::UserGroupId::new(id),
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn add_group_member<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path((group, user)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let request = Request::AddGroupMember {
        id: mhc_api::model::UserGroupId::new(group),
        user_id: UserId::new(user),
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn remove_group_member<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path((group, user)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let request = Request::RemoveGroupMember {
        id: mhc_api::model::UserGroupId::new(group),
        user_id: UserId::new(user),
    };
    call(app, headers, request, Ok_::Fine).await
}

/* --- プロジェクトのグループ --- */

async fn list_project_groups<C: Sql + 'static>(
    State(app): State<App<C>>,
    headers: HeaderMap,
) -> Response {
    call(app, headers, Request::ListProjectGroups, Ok_::Fine).await
}

async fn create_project_group<C: Sql + 'static>(
    State(app): State<App<C>>,
    headers: HeaderMap,
    Json(body): Json<IdNameBody>,
) -> Response {
    let request = Request::CreateProjectGroup {
        id: ProjectGroupId::new(body.id),
        name: body.name,
    };
    call(app, headers, request, Ok_::Created).await
}

async fn rename_project_group<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<NameBody>,
) -> Response {
    let request = Request::RenameProjectGroup {
        id: ProjectGroupId::new(id),
        name: body.name,
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn delete_project_group<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request = Request::DeleteProjectGroup {
        id: ProjectGroupId::new(id),
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn set_group_access<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path((group, kind, id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<RoleBody>,
) -> Response {
    let principal = match principal(&kind, &id) {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let request = Request::SetGroupAccess {
        id: ProjectGroupId::new(group),
        principal,
        role: body.role,
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn remove_group_access<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path((group, kind, id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    let principal = match principal(&kind, &id) {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let request = Request::RemoveGroupAccess {
        id: ProjectGroupId::new(group),
        principal,
    };
    call(app, headers, request, Ok_::Fine).await
}

/* --- プロジェクト --- */

async fn list_projects<C: Sql + 'static>(
    State(app): State<App<C>>,
    headers: HeaderMap,
) -> Response {
    call(app, headers, Request::ListProjects, Ok_::Fine).await
}

async fn create_project<C: Sql + 'static>(
    State(app): State<App<C>>,
    headers: HeaderMap,
    Json(body): Json<CreateProjectBody>,
) -> Response {
    let request = Request::CreateProject {
        id: body.id,
        name: body.name,
        document: body.document,
    };
    call(app, headers, request, Ok_::Created).await
}

async fn get_project<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request = Request::GetProject {
        id: ProjectId::new(id),
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn save_document<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<SaveDocumentBody>,
) -> Response {
    let request = Request::SaveDocument {
        id: ProjectId::new(id),
        document: body.document,
        status: body.status,
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn update_project<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<UpdateProjectBody>,
) -> Response {
    let request = Request::UpdateProject {
        id: ProjectId::new(id),
        name: body.name,
        group_id: body.group_id,
        clear_group: body.clear_group,
        due_date: body.due_date,
        clear_due_date: body.clear_due_date,
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn delete_project<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request = Request::DeleteProject {
        id: ProjectId::new(id),
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn duplicate_project<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<DuplicateBody>,
) -> Response {
    let request = Request::DuplicateProject {
        id: ProjectId::new(id),
        new_id: body.new_id,
        name: body.name,
    };
    call(app, headers, request, Ok_::Created).await
}

/* --- コメント --- */

async fn list_comments<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<CommentQuery>,
    headers: HeaderMap,
) -> Response {
    let request = Request::ListComments {
        id: ProjectId::new(id),
        task_id: query.task_id,
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn post_comment<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PostCommentBody>,
) -> Response {
    let request = Request::PostComment {
        id: ProjectId::new(id),
        comment_id: body.comment_id,
        task_id: body.task_id,
        body: body.body,
    };
    call(app, headers, request, Ok_::Created).await
}

async fn edit_comment<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<BodyOnly>,
) -> Response {
    let request = Request::EditComment {
        comment_id: CommentId::new(id),
        body: body.body,
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn delete_comment<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request = Request::DeleteComment {
        comment_id: CommentId::new(id),
    };
    call(app, headers, request, Ok_::Fine).await
}

/* --- 権限 --- */

async fn list_access<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request = Request::ListAccess {
        id: ProjectId::new(id),
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn set_access<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path((project, kind, id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<RoleBody>,
) -> Response {
    let principal = match principal(&kind, &id) {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let request = Request::SetAccess {
        id: ProjectId::new(project),
        principal,
        role: body.role,
    };
    call(app, headers, request, Ok_::Fine).await
}

async fn remove_access<C: Sql + 'static>(
    State(app): State<App<C>>,
    Path((project, kind, id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    let principal = match principal(&kind, &id) {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let request = Request::RemoveAccess {
        id: ProjectId::new(project),
        principal,
    };
    call(app, headers, request, Ok_::Fine).await
}
