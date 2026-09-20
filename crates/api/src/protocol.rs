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
    Document, Project, ProjectAccess, ProjectId, ProjectRole, ProjectSummary, SystemRole, User,
    UserId,
};
use crate::service::{NewUser, Service, UserPatch};
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
    },
    #[serde(rename_all = "camelCase")]
    RenameProject {
        id: ProjectId,
        name: String,
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
    ListAccess {
        id: ProjectId,
    },
    #[serde(rename_all = "camelCase")]
    SetAccess {
        id: ProjectId,
        user_id: UserId,
        role: ProjectRole,
    },
    #[serde(rename_all = "camelCase")]
    RemoveAccess {
        id: ProjectId,
        user_id: UserId,
    },
}

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
            Self::ListProjects => ("GET", "/v1/projects"),
            Self::CreateProject { .. } => ("POST", "/v1/projects"),
            Self::GetProject { .. } => ("GET", "/v1/projects/{projectId}"),
            Self::SaveDocument { .. } => ("PUT", "/v1/projects/{projectId}/document"),
            Self::RenameProject { .. } => ("PATCH", "/v1/projects/{projectId}"),
            Self::DeleteProject { .. } => ("DELETE", "/v1/projects/{projectId}"),
            Self::DuplicateProject { .. } => ("POST", "/v1/projects/{projectId}/duplicate"),
            Self::ListAccess { .. } => ("GET", "/v1/projects/{projectId}/access"),
            Self::SetAccess { .. } => ("PUT", "/v1/projects/{projectId}/access/{userId}"),
            Self::RemoveAccess { .. } => ("DELETE", "/v1/projects/{projectId}/access/{userId}"),
        }
    }

    /// 内容を書き換える操作か。ローカルでは、これが真のときだけ保存する。
    pub fn is_mutating(&self) -> bool {
        !matches!(
            self,
            Self::Me
                | Self::ListUsers
                | Self::ListProjects
                | Self::GetProject { .. }
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
    Projects(Vec<ProjectSummary>),
    Project(Box<Project>),
    Summary(Box<ProjectSummary>),
    Access(Vec<ProjectAccess>),
    Empty,
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

        Request::ListProjects => Reply::Projects(service.list_projects(&actor)?),
        Request::CreateProject { id, name, document } => Reply::Project(Box::new(
            service.create_project(&actor, now, id, &name, document)?,
        )),
        Request::GetProject { id } => Reply::Project(Box::new(service.get_project(&actor, &id)?)),
        Request::SaveDocument { id, document } => {
            Reply::Summary(Box::new(service.save_document(&actor, &id, now, document)?))
        }
        Request::RenameProject { id, name } => {
            Reply::Summary(Box::new(service.rename_project(&actor, &id, now, &name)?))
        }
        Request::DeleteProject { id } => {
            service.delete_project(&actor, &id)?;
            Reply::Empty
        }
        Request::DuplicateProject { id, new_id, name } => Reply::Project(Box::new(
            service.duplicate_project(&actor, &id, now, new_id, &name)?,
        )),

        Request::ListAccess { id } => Reply::Access(service.list_access(&actor, &id)?),
        Request::SetAccess { id, user_id, role } => {
            Reply::Access(service.set_access(&actor, &id, now, &user_id, role)?)
        }
        Request::RemoveAccess { id, user_id } => {
            Reply::Access(service.remove_access(&actor, &id, now, &user_id)?)
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
        ] {
            store.put_user(User {
                id: UserId::new(id),
                name: name.into(),
                email: None,
                system_role: role,
                created_at: NOW.into(),
            });
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
            },
            Request::RenameProject {
                id: ProjectId::new("p"),
                name: "q".into(),
            },
            Request::DeleteProject {
                id: ProjectId::new("p"),
            },
            Request::DuplicateProject {
                id: ProjectId::new("p"),
                new_id: ProjectId::new("q"),
                name: "q".into(),
            },
            Request::ListAccess {
                id: ProjectId::new("p"),
            },
            Request::SetAccess {
                id: ProjectId::new("p"),
                user_id: UserId::new("x"),
                role: ProjectRole::Editor,
            },
            Request::RemoveAccess {
                id: ProjectId::new("p"),
                user_id: UserId::new("x"),
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
        assert_eq!(seen.len(), 15, "操作を足したらここも増やす");
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
    fn a_successful_call_comes_back_as_ok() {
        let mut service = service();
        let outcome = call(&mut service, "alice", Request::Me);
        match outcome {
            Outcome::Ok {
                reply: Reply::User(user),
            } => assert_eq!(user.name, "佐藤"),
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

        match call(&mut service, "alice", Request::ListProjects) {
            Outcome::Ok {
                reply: Reply::Projects(list),
            } => {
                assert_eq!(list.len(), 1);
                assert_eq!(list[0].name, "新規案件");
            }
            other => panic!("想定外: {other:?}"),
        }

        assert!(matches!(
            call(
                &mut service,
                "alice",
                Request::SetAccess {
                    id: ProjectId::new("p1"),
                    user_id: UserId::new("root"),
                    role: ProjectRole::Editor,
                },
            ),
            Outcome::Ok { .. }
        ));

        match call(
            &mut service,
            "root",
            Request::ListAccess {
                id: ProjectId::new("p1"),
            },
        ) {
            Outcome::Ok {
                reply: Reply::Access(access),
            } => assert_eq!(access.len(), 2),
            other => panic!("想定外: {other:?}"),
        }
    }
}
