//! 呼び出しの形。
//!
//! 1 回の呼び出しは [`Envelope`] で表す。ローカルではこれを JSON にして
//! WASM に渡し、サーバでは HTTP のルートとボディに展開する。
//! どちらの経路でも [`dispatch`] が同じ [`Service`] を呼ぶので、
//! 振る舞いがずれることがない。
//!
//! 各操作が HTTP のどこに写るかは [`Request::route`] が持っている。
//! `docs/openapi.yaml` はこの対応を人間向けに書き下したもの。

use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::model::{
    AccessEntry, Attachment, Comment, CommentId, Document, Principal, Project, ProjectGroup,
    ProjectGroupId, ProjectId, ProjectRole, ProjectStatus, ProjectSummary, SystemRole, User,
    UserGroup, UserGroupId, UserId,
};
use crate::service::{NewComment, NewUser, ProjectPatch, Service, UserPatch};
use crate::store::Store;

/// 操作の種類と引数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    /// 自分の情報。
    Me,

    ListUsers,
    #[serde(rename_all = "camelCase")]
    CreateUser {
        id: UserId,
        name: String,
        #[serde(default)]
        email: Option<String>,
        system_role: SystemRole,
    },
    #[serde(rename_all = "camelCase")]
    UpdateUser {
        id: UserId,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        email: Option<String>,
        /// `true` なら メールアドレスを空にする。
        #[serde(default)]
        clear_email: bool,
        #[serde(default)]
        system_role: Option<SystemRole>,
    },
    #[serde(rename_all = "camelCase")]
    DeleteUser {
        id: UserId,
    },

    ListUserGroups,
    #[serde(rename_all = "camelCase")]
    CreateUserGroup {
        id: UserGroupId,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    RenameUserGroup {
        id: UserGroupId,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    DeleteUserGroup {
        id: UserGroupId,
    },
    #[serde(rename_all = "camelCase")]
    AddGroupMember {
        id: UserGroupId,
        user_id: UserId,
    },
    #[serde(rename_all = "camelCase")]
    RemoveGroupMember {
        id: UserGroupId,
        user_id: UserId,
    },

    ListProjectGroups,
    #[serde(rename_all = "camelCase")]
    CreateProjectGroup {
        id: ProjectGroupId,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    RenameProjectGroup {
        id: ProjectGroupId,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    DeleteProjectGroup {
        id: ProjectGroupId,
    },
    #[serde(rename_all = "camelCase")]
    SetGroupAccess {
        id: ProjectGroupId,
        principal: Principal,
        role: ProjectRole,
    },
    #[serde(rename_all = "camelCase")]
    RemoveGroupAccess {
        id: ProjectGroupId,
        principal: Principal,
    },

    ListProjects,
    #[serde(rename_all = "camelCase")]
    CreateProject {
        id: ProjectId,
        name: String,
        #[serde(default)]
        document: Document,
    },
    #[serde(rename_all = "camelCase")]
    GetProject {
        id: ProjectId,
    },
    #[serde(rename_all = "camelCase")]
    SaveDocument {
        id: ProjectId,
        document: Document,
        /// 保存する内容から計算した控え。`basedOn` が保存時刻と食い違えば捨てられる。
        #[serde(default)]
        status: Option<ProjectStatus>,
    },
    #[serde(rename_all = "camelCase")]
    UpdateProject {
        id: ProjectId,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        group_id: Option<ProjectGroupId>,
        /// `true` ならどのグループにも属さない状態に戻す。
        #[serde(default)]
        clear_group: bool,
        #[serde(default)]
        due_date: Option<String>,
        /// `true` なら期限を外す。
        #[serde(default)]
        clear_due_date: bool,
    },
    #[serde(rename_all = "camelCase")]
    DeleteProject {
        id: ProjectId,
    },
    #[serde(rename_all = "camelCase")]
    DuplicateProject {
        id: ProjectId,
        new_id: ProjectId,
        name: String,
    },

    #[serde(rename_all = "camelCase")]
    ListComments {
        id: ProjectId,
        /// 渡すとそのタスク宛てだけを返す。
        #[serde(default)]
        task_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PostComment {
        id: ProjectId,
        comment_id: CommentId,
        #[serde(default)]
        task_id: Option<String>,
        body: String,
        /// 添付。ルートは増やさない — 1 つの形を WASM と HTTP の両方で通す。
        #[serde(default)]
        attachments: Vec<Attachment>,
    },
    #[serde(rename_all = "camelCase")]
    EditComment {
        comment_id: CommentId,
        body: String,
        /// 送られたものがそのまま新しい一覧になる (足すのではなく置き換え)。
        #[serde(default)]
        attachments: Vec<Attachment>,
    },
    #[serde(rename_all = "camelCase")]
    DeleteComment {
        comment_id: CommentId,
    },

    #[serde(rename_all = "camelCase")]
    ListAccess {
        id: ProjectId,
    },
    #[serde(rename_all = "camelCase")]
    SetAccess {
        id: ProjectId,
        principal: Principal,
        role: ProjectRole,
    },
    #[serde(rename_all = "camelCase")]
    RemoveAccess {
        id: ProjectId,
        principal: Principal,
    },
}

/// すべての操作の (メソッド, パス)。**API の目録**。
///
/// [`Request::route`] と重複しているように見えるが、役割が違う。`route` は
/// 値からパスを引くためのもので、こちらは「全部でこれだけある」を表に出す
/// ためのもの。`enum` を値なしに列挙することはできないので、両者の一致は
/// 単体テストで固定している (`routes_and_the_index_agree`)。
/// `docs/openapi.yaml` の検査もこの表を見る。
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/v1/me"),
    ("GET", "/v1/users"),
    ("POST", "/v1/users"),
    ("PATCH", "/v1/users/{userId}"),
    ("DELETE", "/v1/users/{userId}"),
    ("GET", "/v1/user-groups"),
    ("POST", "/v1/user-groups"),
    ("PATCH", "/v1/user-groups/{groupId}"),
    ("DELETE", "/v1/user-groups/{groupId}"),
    ("PUT", "/v1/user-groups/{groupId}/members/{userId}"),
    ("DELETE", "/v1/user-groups/{groupId}/members/{userId}"),
    ("GET", "/v1/project-groups"),
    ("POST", "/v1/project-groups"),
    ("PATCH", "/v1/project-groups/{groupId}"),
    ("DELETE", "/v1/project-groups/{groupId}"),
    (
        "PUT",
        "/v1/project-groups/{groupId}/access/{principalKind}/{principalId}",
    ),
    (
        "DELETE",
        "/v1/project-groups/{groupId}/access/{principalKind}/{principalId}",
    ),
    ("GET", "/v1/projects"),
    ("POST", "/v1/projects"),
    ("GET", "/v1/projects/{projectId}"),
    ("PATCH", "/v1/projects/{projectId}"),
    ("DELETE", "/v1/projects/{projectId}"),
    ("PUT", "/v1/projects/{projectId}/document"),
    ("POST", "/v1/projects/{projectId}/duplicate"),
    ("GET", "/v1/projects/{projectId}/comments"),
    ("POST", "/v1/projects/{projectId}/comments"),
    ("PATCH", "/v1/comments/{commentId}"),
    ("DELETE", "/v1/comments/{commentId}"),
    ("GET", "/v1/projects/{projectId}/access"),
    (
        "PUT",
        "/v1/projects/{projectId}/access/{principalKind}/{principalId}",
    ),
    (
        "DELETE",
        "/v1/projects/{projectId}/access/{principalKind}/{principalId}",
    ),
];

impl Request {
    /// HTTP に載せたときのメソッドとパス。`{}` は埋め込みの位置。
    ///
    /// ローカルでは使わないが、**この表が API の定義そのもの**で、
    /// OpenAPI とサーバの実装はここに合わせる。
    pub fn route(&self) -> (&'static str, &'static str) {
        match self {
            Self::Me => ("GET", "/v1/me"),

            Self::ListUsers => ("GET", "/v1/users"),
            Self::CreateUser { .. } => ("POST", "/v1/users"),
            Self::UpdateUser { .. } => ("PATCH", "/v1/users/{userId}"),
            Self::DeleteUser { .. } => ("DELETE", "/v1/users/{userId}"),

            Self::ListUserGroups => ("GET", "/v1/user-groups"),
            Self::CreateUserGroup { .. } => ("POST", "/v1/user-groups"),
            Self::RenameUserGroup { .. } => ("PATCH", "/v1/user-groups/{groupId}"),
            Self::DeleteUserGroup { .. } => ("DELETE", "/v1/user-groups/{groupId}"),
            Self::AddGroupMember { .. } => ("PUT", "/v1/user-groups/{groupId}/members/{userId}"),
            Self::RemoveGroupMember { .. } => {
                ("DELETE", "/v1/user-groups/{groupId}/members/{userId}")
            }

            Self::ListProjectGroups => ("GET", "/v1/project-groups"),
            Self::CreateProjectGroup { .. } => ("POST", "/v1/project-groups"),
            Self::RenameProjectGroup { .. } => ("PATCH", "/v1/project-groups/{groupId}"),
            Self::DeleteProjectGroup { .. } => ("DELETE", "/v1/project-groups/{groupId}"),
            Self::SetGroupAccess { .. } => (
                "PUT",
                "/v1/project-groups/{groupId}/access/{principalKind}/{principalId}",
            ),
            Self::RemoveGroupAccess { .. } => (
                "DELETE",
                "/v1/project-groups/{groupId}/access/{principalKind}/{principalId}",
            ),

            Self::ListProjects => ("GET", "/v1/projects"),
            Self::CreateProject { .. } => ("POST", "/v1/projects"),
            Self::GetProject { .. } => ("GET", "/v1/projects/{projectId}"),
            Self::SaveDocument { .. } => ("PUT", "/v1/projects/{projectId}/document"),
            Self::UpdateProject { .. } => ("PATCH", "/v1/projects/{projectId}"),
            Self::DeleteProject { .. } => ("DELETE", "/v1/projects/{projectId}"),
            Self::DuplicateProject { .. } => ("POST", "/v1/projects/{projectId}/duplicate"),

            Self::ListComments { .. } => ("GET", "/v1/projects/{projectId}/comments"),
            Self::PostComment { .. } => ("POST", "/v1/projects/{projectId}/comments"),
            Self::EditComment { .. } => ("PATCH", "/v1/comments/{commentId}"),
            Self::DeleteComment { .. } => ("DELETE", "/v1/comments/{commentId}"),

            Self::ListAccess { .. } => ("GET", "/v1/projects/{projectId}/access"),
            Self::SetAccess { .. } => (
                "PUT",
                "/v1/projects/{projectId}/access/{principalKind}/{principalId}",
            ),
            Self::RemoveAccess { .. } => (
                "DELETE",
                "/v1/projects/{projectId}/access/{principalKind}/{principalId}",
            ),
        }
    }

    /// 内容を書き換える操作か。ローカルでは、これが真のときだけ保存する。
    /// サーバでは読み取りロックと書き込みロックの選択に使う。
    pub fn is_mutating(&self) -> bool {
        !matches!(
            self,
            Self::Me
                | Self::ListUsers
                | Self::ListUserGroups
                | Self::ListProjectGroups
                | Self::ListProjects
                | Self::GetProject { .. }
                | Self::ListComments { .. }
                | Self::ListAccess { .. }
        )
    }
}

/// 返ってくる中身。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Reply {
    User(User),
    Users(Vec<User>),
    UserGroup(UserGroup),
    UserGroups(Vec<UserGroup>),
    ProjectGroup(ProjectGroup),
    ProjectGroups(Vec<ProjectGroup>),
    Projects(Vec<ProjectSummary>),
    Project(Box<Project>),
    Summary(Box<ProjectSummary>),
    Access(Vec<AccessEntry>),
    Comment(Box<Comment>),
    Comments(Vec<Comment>),
    Empty,
}

impl Reply {
    /// HTTP の本文に載せる中身。
    ///
    /// `Reply` は経路を問わず使える形 (`{"kind":…,"value":…}`) をしているが、
    /// HTTP ではルートが種類を表しているので、本文には中身だけを載せる。
    /// [`Reply::Empty`] は本文なし (204 No Content) を意味する。
    pub fn body(&self) -> Option<serde_json::Value> {
        // 包んでから取り出す。各変種を並べ直すより、serde の結果を
        // そのまま使うほうが取りこぼしが無い。
        let mut wrapped = serde_json::to_value(self).ok()?;
        wrapped.get_mut("value").map(serde_json::Value::take)
    }
}

/// 1 回の呼び出し。
///
/// `actor` と `now` を外から渡すのは、WASM のなかに認証も時計も
/// 持ち込まないため。サーバではセッションとサーバ時刻がこれを埋める。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub actor: UserId,
    pub now: String,
    pub request: Request,
}

/// 呼び出しの結果。JSON では `{"ok":true,...}` / `{"ok":false,...}` になる。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "ok")]
pub enum Outcome {
    #[serde(rename = "true")]
    Ok { reply: Reply },
    #[serde(rename = "false")]
    Err { error: ApiError, status: u16 },
}

impl Outcome {
    pub fn from_result(result: crate::error::ApiResult<Reply>) -> Self {
        match result {
            Ok(reply) => Self::Ok { reply },
            Err(error) => Self::Err {
                status: error.http_status(),
                error,
            },
        }
    }
}

/// 呼び出しを [`Service`] に取り次ぐ。ローカルでもサーバでもここを通る。
pub fn dispatch<S: Store>(service: &mut Service<S>, envelope: Envelope) -> Outcome {
    Outcome::from_result(run(service, envelope))
}

fn run<S: Store>(service: &mut Service<S>, envelope: Envelope) -> crate::error::ApiResult<Reply> {
    let actor = service.actor(&envelope.actor)?;
    let now = envelope.now.as_str();

    Ok(match envelope.request {
        Request::Me => Reply::User(service.me(&actor)?),

        Request::ListUsers => Reply::Users(service.list_users(&actor)?),
        Request::CreateUser {
            id,
            name,
            email,
            system_role,
        } => Reply::User(service.create_user(
            &actor,
            now,
            NewUser {
                id,
                name,
                email,
                system_role,
            },
        )?),
        Request::UpdateUser {
            id,
            name,
            email,
            clear_email,
            system_role,
        } => Reply::User(service.update_user(
            &actor,
            &id,
            UserPatch {
                name,
                email: if clear_email {
                    Some(None)
                } else {
                    email.map(Some)
                },
                system_role,
            },
        )?),
        Request::DeleteUser { id } => {
            service.delete_user(&actor, &id)?;
            Reply::Empty
        }

        Request::ListUserGroups => Reply::UserGroups(service.list_user_groups(&actor)?),
        Request::CreateUserGroup { id, name } => {
            Reply::UserGroup(service.create_user_group(&actor, now, id, &name)?)
        }
        Request::RenameUserGroup { id, name } => {
            Reply::UserGroup(service.rename_user_group(&actor, &id, &name)?)
        }
        Request::DeleteUserGroup { id } => {
            service.delete_user_group(&actor, &id)?;
            Reply::Empty
        }
        Request::AddGroupMember { id, user_id } => {
            Reply::UserGroup(service.set_group_member(&actor, &id, &user_id, true)?)
        }
        Request::RemoveGroupMember { id, user_id } => {
            Reply::UserGroup(service.set_group_member(&actor, &id, &user_id, false)?)
        }

        Request::ListProjectGroups => Reply::ProjectGroups(service.list_project_groups(&actor)?),
        Request::CreateProjectGroup { id, name } => {
            Reply::ProjectGroup(service.create_project_group(&actor, now, id, &name)?)
        }
        Request::RenameProjectGroup { id, name } => {
            Reply::ProjectGroup(service.rename_project_group(&actor, &id, &name)?)
        }
        Request::DeleteProjectGroup { id } => {
            service.delete_project_group(&actor, &id)?;
            Reply::Empty
        }
        Request::SetGroupAccess {
            id,
            principal,
            role,
        } => Reply::ProjectGroup(service.set_group_access(&actor, &id, &principal, Some(role))?),
        Request::RemoveGroupAccess { id, principal } => {
            Reply::ProjectGroup(service.set_group_access(&actor, &id, &principal, None)?)
        }

        Request::ListProjects => Reply::Projects(service.list_projects(&actor, now)?),
        Request::CreateProject { id, name, document } => Reply::Project(Box::new(
            service.create_project(&actor, now, id, &name, document)?,
        )),
        Request::GetProject { id } => Reply::Project(Box::new(service.get_project(&actor, &id)?)),
        Request::SaveDocument {
            id,
            document,
            status,
        } => Reply::Summary(Box::new(
            service.save_document(&actor, &id, now, document, status)?,
        )),
        Request::UpdateProject {
            id,
            name,
            group_id,
            clear_group,
            due_date,
            clear_due_date,
        } => Reply::Summary(Box::new(service.update_project(
            &actor,
            &id,
            now,
            ProjectPatch {
                name,
                group_id: if clear_group {
                    Some(None)
                } else {
                    group_id.map(Some)
                },
                due_date: if clear_due_date {
                    Some(None)
                } else {
                    due_date.map(Some)
                },
            },
        )?)),
        Request::DeleteProject { id } => {
            service.delete_project(&actor, &id)?;
            Reply::Empty
        }
        Request::DuplicateProject { id, new_id, name } => Reply::Project(Box::new(
            service.duplicate_project(&actor, &id, now, new_id, &name)?,
        )),

        Request::ListComments { id, task_id } => {
            Reply::Comments(service.list_comments(&actor, &id, task_id.as_deref())?)
        }
        Request::PostComment {
            id,
            comment_id,
            task_id,
            body,
            attachments,
        } => Reply::Comment(Box::new(service.post_comment(
            &actor,
            &id,
            now,
            NewComment {
                id: comment_id,
                task_id,
                body,
                attachments,
            },
        )?)),
        Request::EditComment {
            comment_id,
            body,
            attachments,
        } => Reply::Comment(Box::new(service.edit_comment(
            &actor,
            &comment_id,
            now,
            &body,
            attachments,
        )?)),
        Request::DeleteComment { comment_id } => {
            service.delete_comment(&actor, &comment_id)?;
            Reply::Empty
        }

        Request::ListAccess { id } => Reply::Access(service.list_access(&actor, &id)?),
        Request::SetAccess {
            id,
            principal,
            role,
        } => Reply::Access(service.set_access(&actor, &id, &principal, Some(role))?),
        Request::RemoveAccess { id, principal } => {
            Reply::Access(service.set_access(&actor, &id, &principal, None)?)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;

    const NOW: &str = "2026-09-20T10:00:00Z";

    fn service() -> Service<MemoryStore> {
        let mut store = MemoryStore::new();
        for (id, name, role) in [
            ("root", "管理者", SystemRole::Admin),
            ("alice", "佐藤", SystemRole::Member),
            ("bob", "鈴木", SystemRole::Member),
        ] {
            store
                .put_user(User {
                    id: UserId::new(id),
                    name: name.into(),
                    email: None,
                    system_role: role,
                    created_at: NOW.into(),
                })
                .unwrap();
        }
        Service::new(store)
    }

    fn call(service: &mut Service<MemoryStore>, actor: &str, request: Request) -> Outcome {
        dispatch(
            service,
            Envelope {
                actor: UserId::new(actor),
                now: NOW.into(),
                request,
            },
        )
    }

    fn ok(service: &mut Service<MemoryStore>, actor: &str, request: Request) -> Reply {
        match call(service, actor, request) {
            Outcome::Ok { reply } => reply,
            other => panic!("通るはずの呼び出しが失敗した: {other:?}"),
        }
    }

    /// 呼び出しに使いうるすべての操作。網羅を忘れないための一覧。
    fn every_request() -> Vec<Request> {
        vec![
            Request::Me,
            Request::ListUsers,
            Request::CreateUser {
                id: UserId::new("x"),
                name: "x".into(),
                email: None,
                system_role: SystemRole::Member,
            },
            Request::UpdateUser {
                id: UserId::new("x"),
                name: None,
                email: None,
                clear_email: false,
                system_role: None,
            },
            Request::DeleteUser {
                id: UserId::new("x"),
            },
            Request::ListUserGroups,
            Request::CreateUserGroup {
                id: UserGroupId::new("g"),
                name: "g".into(),
            },
            Request::RenameUserGroup {
                id: UserGroupId::new("g"),
                name: "h".into(),
            },
            Request::DeleteUserGroup {
                id: UserGroupId::new("g"),
            },
            Request::AddGroupMember {
                id: UserGroupId::new("g"),
                user_id: UserId::new("x"),
            },
            Request::RemoveGroupMember {
                id: UserGroupId::new("g"),
                user_id: UserId::new("x"),
            },
            Request::ListProjectGroups,
            Request::CreateProjectGroup {
                id: ProjectGroupId::new("f"),
                name: "f".into(),
            },
            Request::RenameProjectGroup {
                id: ProjectGroupId::new("f"),
                name: "g".into(),
            },
            Request::DeleteProjectGroup {
                id: ProjectGroupId::new("f"),
            },
            Request::SetGroupAccess {
                id: ProjectGroupId::new("f"),
                principal: Principal::user("x"),
                role: ProjectRole::Editor,
            },
            Request::RemoveGroupAccess {
                id: ProjectGroupId::new("f"),
                principal: Principal::user("x"),
            },
            Request::ListProjects,
            Request::CreateProject {
                id: ProjectId::new("p"),
                name: "p".into(),
                document: Document::default(),
            },
            Request::GetProject {
                id: ProjectId::new("p"),
            },
            Request::SaveDocument {
                id: ProjectId::new("p"),
                document: Document::default(),
                status: None,
            },
            Request::UpdateProject {
                id: ProjectId::new("p"),
                name: Some("q".into()),
                group_id: None,
                clear_group: false,
                due_date: None,
                clear_due_date: false,
            },
            Request::DeleteProject {
                id: ProjectId::new("p"),
            },
            Request::DuplicateProject {
                id: ProjectId::new("p"),
                new_id: ProjectId::new("q"),
                name: "q".into(),
            },
            Request::ListComments {
                id: ProjectId::new("p"),
                task_id: None,
            },
            Request::PostComment {
                id: ProjectId::new("p"),
                comment_id: CommentId::new("c"),
                task_id: None,
                body: "やあ".into(),
                attachments: Vec::new(),
            },
            Request::EditComment {
                comment_id: CommentId::new("c"),
                body: "やあ (修正)".into(),
                attachments: Vec::new(),
            },
            Request::DeleteComment {
                comment_id: CommentId::new("c"),
            },
            Request::ListAccess {
                id: ProjectId::new("p"),
            },
            Request::SetAccess {
                id: ProjectId::new("p"),
                principal: Principal::user("x"),
                role: ProjectRole::Editor,
            },
            Request::RemoveAccess {
                id: ProjectId::new("p"),
                principal: Principal::group("g"),
            },
        ]
    }

    #[test]
    fn every_operation_has_its_own_route() {
        let mut seen = Vec::new();
        for request in every_request() {
            let route = request.route();
            assert!(
                !seen.contains(&route),
                "{route:?} が重複している ({request:?})"
            );
            assert!(route.1.starts_with("/v1/"), "{route:?}");
            seen.push(route);
        }
        assert_eq!(seen.len(), ROUTES.len(), "操作を足したらここも増やす");
    }

    #[test]
    fn routes_and_the_index_agree() {
        let mut listed: Vec<_> = every_request().iter().map(Request::route).collect();
        listed.sort_unstable();
        let mut index = ROUTES.to_vec();
        index.sort_unstable();
        assert_eq!(listed, index, "ROUTES と route() が食い違っている");
    }

    #[test]
    fn reads_and_writes_are_told_apart() {
        for request in every_request() {
            let (method, _) = request.route();
            let expected = method != "GET";
            assert_eq!(
                request.is_mutating(),
                expected,
                "{request:?} の読み書きの判定が HTTP メソッドと食い違う"
            );
        }
    }

    #[test]
    fn requests_round_trip_as_json() {
        for request in every_request() {
            let envelope = Envelope {
                actor: UserId::new("alice"),
                now: NOW.into(),
                request,
            };
            let text = serde_json::to_string(&envelope).unwrap();
            let back: Envelope = serde_json::from_str(&text).unwrap();
            assert_eq!(back, envelope);
        }
    }

    #[test]
    fn the_operation_name_is_camel_case_in_json() {
        let text = serde_json::to_string(&Request::ListProjects).unwrap();
        assert_eq!(text, r#"{"op":"listProjects"}"#);
    }

    #[test]
    fn a_principal_travels_as_a_kind_and_an_id() {
        let text = serde_json::to_string(&Request::RemoveAccess {
            id: ProjectId::new("p"),
            principal: Principal::group("team"),
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"op":"removeAccess","id":"p","principal":{"kind":"group","id":"team"}}"#
        );
    }

    #[test]
    fn a_reply_body_is_the_bare_value() {
        let user = User {
            id: UserId::new("alice"),
            name: "佐藤".into(),
            email: None,
            system_role: SystemRole::Member,
            created_at: NOW.into(),
        };
        let body = Reply::User(user.clone()).body().expect("本文がある");
        assert_eq!(body, serde_json::to_value(&user).unwrap());
        assert_eq!(body.get("kind"), None, "包みは剥がれている");

        assert_eq!(Reply::Empty.body(), None, "204 になる");
        assert_eq!(
            Reply::Users(Vec::new()).body(),
            Some(serde_json::json!([])),
            "空の一覧は 204 ではなく空の配列"
        );
    }

    #[test]
    fn a_successful_call_comes_back_as_ok() {
        let mut service = service();
        match ok(&mut service, "alice", Request::Me) {
            Reply::User(user) => assert_eq!(user.name, "佐藤"),
            other => panic!("想定外: {other:?}"),
        }
    }

    #[test]
    fn a_refused_call_carries_the_http_status() {
        let mut service = service();
        let outcome = call(
            &mut service,
            "alice",
            Request::CreateUser {
                id: UserId::new("x"),
                name: "x".into(),
                email: None,
                system_role: SystemRole::Member,
            },
        );
        match outcome {
            Outcome::Err { error, status } => {
                assert_eq!(error.code, crate::error::ErrorCode::Forbidden);
                assert_eq!(status, 403);
            }
            other => panic!("通ってはいけない: {other:?}"),
        }
    }

    #[test]
    fn an_unknown_caller_is_refused_with_401() {
        let mut service = service();
        match call(&mut service, "居ない", Request::ListProjects) {
            Outcome::Err { status, .. } => assert_eq!(status, 401),
            other => panic!("通ってはいけない: {other:?}"),
        }
    }

    #[test]
    fn outcomes_serialise_with_an_ok_flag() {
        let ok = serde_json::to_string(&Outcome::Ok {
            reply: Reply::Empty,
        })
        .unwrap();
        assert!(ok.contains(r#""ok":"true""#), "{ok}");

        let failed = serde_json::to_string(&Outcome::Err {
            error: crate::error::ApiError::not_found("無い"),
            status: 404,
        })
        .unwrap();
        assert!(failed.contains(r#""ok":"false""#), "{failed}");
        assert!(failed.contains(r#""status":404"#), "{failed}");
    }

    #[test]
    fn a_whole_session_works_through_the_protocol() {
        let mut service = service();

        // 作る → 一覧に出る → 共有する → 相手からも見える
        let created = call(
            &mut service,
            "alice",
            Request::CreateProject {
                id: ProjectId::new("p1"),
                name: "新規案件".into(),
                document: Document::default(),
            },
        );
        assert!(matches!(created, Outcome::Ok { .. }));

        match ok(&mut service, "alice", Request::ListProjects) {
            Reply::Projects(list) => {
                assert_eq!(list.len(), 1);
                assert_eq!(list[0].name, "新規案件");
                assert_eq!(list[0].owner_names, vec!["佐藤".to_string()]);
            }
            other => panic!("想定外: {other:?}"),
        }

        assert!(matches!(
            call(
                &mut service,
                "alice",
                Request::SetAccess {
                    id: ProjectId::new("p1"),
                    principal: Principal::user("root"),
                    role: ProjectRole::Editor,
                },
            ),
            Outcome::Ok { .. }
        ));

        match ok(
            &mut service,
            "root",
            Request::ListAccess {
                id: ProjectId::new("p1"),
            },
        ) {
            Reply::Access(access) => assert_eq!(access.len(), 2),
            other => panic!("想定外: {other:?}"),
        }
    }

    #[test]
    fn a_group_can_be_granted_access_through_the_protocol() {
        let mut service = service();

        // 管理者がチームを作って bob を入れる。
        ok(
            &mut service,
            "root",
            Request::CreateUserGroup {
                id: UserGroupId::new("team"),
                name: "開発チーム".into(),
            },
        );
        ok(
            &mut service,
            "root",
            Request::AddGroupMember {
                id: UserGroupId::new("team"),
                user_id: UserId::new("bob"),
            },
        );

        // alice のプロジェクトをチームに共有する。
        ok(
            &mut service,
            "alice",
            Request::CreateProject {
                id: ProjectId::new("p1"),
                name: "新規案件".into(),
                document: Document::default(),
            },
        );
        match call(&mut service, "bob", Request::ListProjects) {
            Outcome::Ok {
                reply: Reply::Projects(list),
            } => assert!(list.is_empty(), "共有前は見えない"),
            other => panic!("想定外: {other:?}"),
        }

        ok(
            &mut service,
            "alice",
            Request::SetAccess {
                id: ProjectId::new("p1"),
                principal: Principal::group("team"),
                role: ProjectRole::Editor,
            },
        );

        match ok(&mut service, "bob", Request::ListProjects) {
            Reply::Projects(list) => {
                assert_eq!(list.len(), 1, "チーム経由で見える");
                assert_eq!(list[0].role, ProjectRole::Editor);
            }
            other => panic!("想定外: {other:?}"),
        }

        // チームから外すと見えなくなる。
        ok(
            &mut service,
            "root",
            Request::RemoveGroupMember {
                id: UserGroupId::new("team"),
                user_id: UserId::new("bob"),
            },
        );
        match ok(&mut service, "bob", Request::ListProjects) {
            Reply::Projects(list) => assert!(list.is_empty()),
            other => panic!("想定外: {other:?}"),
        }
    }

    #[test]
    fn a_project_group_hands_down_its_access() {
        let mut service = service();

        ok(
            &mut service,
            "alice",
            Request::CreateProjectGroup {
                id: ProjectGroupId::new("dept"),
                name: "第一部".into(),
            },
        );
        ok(
            &mut service,
            "alice",
            Request::SetGroupAccess {
                id: ProjectGroupId::new("dept"),
                principal: Principal::user("bob"),
                role: ProjectRole::Viewer,
            },
        );
        ok(
            &mut service,
            "alice",
            Request::CreateProject {
                id: ProjectId::new("p1"),
                name: "新規案件".into(),
                document: Document::default(),
            },
        );

        // グループに入れると、グループの権限が効くようになる。
        match ok(
            &mut service,
            "alice",
            Request::UpdateProject {
                id: ProjectId::new("p1"),
                name: None,
                group_id: Some(ProjectGroupId::new("dept")),
                clear_group: false,
                due_date: Some("2026-12-31".into()),
                clear_due_date: false,
            },
        ) {
            Reply::Summary(summary) => {
                assert_eq!(summary.group_name.as_deref(), Some("第一部"));
                assert_eq!(summary.due_date.as_deref(), Some("2026-12-31"));
            }
            other => panic!("想定外: {other:?}"),
        }

        match ok(&mut service, "bob", Request::ListProjects) {
            Reply::Projects(list) => {
                assert_eq!(list.len(), 1);
                assert_eq!(list[0].role, ProjectRole::Viewer);
            }
            other => panic!("想定外: {other:?}"),
        }
    }

    #[test]
    fn a_bad_due_date_is_refused() {
        let mut service = service();
        ok(
            &mut service,
            "alice",
            Request::CreateProject {
                id: ProjectId::new("p1"),
                name: "新規案件".into(),
                document: Document::default(),
            },
        );
        match call(
            &mut service,
            "alice",
            Request::UpdateProject {
                id: ProjectId::new("p1"),
                name: None,
                group_id: None,
                clear_group: false,
                due_date: Some("2026/12/31".into()),
                clear_due_date: false,
            },
        ) {
            Outcome::Err { error, .. } => assert_eq!(error.code, crate::error::ErrorCode::Invalid),
            other => panic!("通ってはいけない: {other:?}"),
        }
    }
}
