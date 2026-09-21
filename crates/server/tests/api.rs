//! サーバを HTTP 越しに試す。
//!
//! ルータは本物をそのまま組み立て、`tower` の `oneshot` でリクエストを
//! 流し込む。ソケットを開かないので速く、見ているものは本番と同じ。
//!
//! PostgreSQL の版は `MHC_TEST_POSTGRES_URL` があるときだけ走る。

use std::sync::{Arc, RwLock};

use axum::body::Body;
use axum::http::{header, Request as HttpRequest, StatusCode};
use mhc_api::model::{SystemRole, User, UserId};
use mhc_api::store::Store;
use mhc_server::auth;
use mhc_server::http::{App, AppState, Auth};
use mhc_server::store::postgres::PostgresConn;
use mhc_server::store::sqlite::SqliteConn;
use mhc_server::store::{Sql, SqlStore};
use serde_json::{json, Value};
use tower::ServiceExt;

const NOW: &str = "2026-09-20T10:00:00Z";

/// 立ち上げたサーバと、そこで使えるトークン。
struct Harness {
    app: axum::Router,
    tokens: Vec<(String, String)>,
}

impl Harness {
    fn new<C: Sql + 'static>(conn: C, auth_mode: Auth) -> Self {
        Self::with_origins(conn, auth_mode, Vec::new())
    }

    fn with_origins<C: Sql + 'static>(
        conn: C,
        auth_mode: Auth,
        allow_origins: Vec<String>,
    ) -> Self {
        let store = SqlStore::open(conn).expect("開ける");
        let mut tokens = Vec::new();
        for (id, name, role) in [
            ("root", "管理者", SystemRole::Admin),
            ("alice", "佐藤", SystemRole::Member),
            ("bob", "鈴木", SystemRole::Member),
        ] {
            (&store)
                .put_user(User {
                    id: UserId::new(id),
                    name: name.into(),
                    email: None,
                    system_role: role,
                    created_at: NOW.into(),
                })
                .expect("作れる");
            let issued = auth::create(&mut *store.sql(), id, "テスト", NOW).expect("発行できる");
            tokens.push((id.to_string(), issued.secret));
        }

        let app: App<C> = Arc::new(AppState {
            store: RwLock::new(store),
            auth: auth_mode,
            ui: Arc::from("<!doctype html><title>画面</title>"),
            allow_origins,
        });
        Self {
            app: mhc_server::http::router(app),
            tokens,
        }
    }

    fn token(&self, user: &str) -> &str {
        self.tokens
            .iter()
            .find(|(id, _)| id == user)
            .map(|(_, secret)| secret.as_str())
            .expect("発行してある")
    }

    /// 1 回叩く。`user` が `None` なら認証ヘッダを付けない。
    async fn send(
        &self,
        method: &str,
        path: &str,
        user: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = HttpRequest::builder().method(method).uri(path);
        if let Some(user) = user {
            builder = builder.header(
                header::AUTHORIZATION,
                format!("Bearer {}", self.token(user)),
            );
        }
        let request = match body {
            Some(value) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(value.to_string())),
            None => builder.body(Body::empty()),
        }
        .expect("組み立てられる");

        let response = self.app.clone().oneshot(request).await.expect("応答が返る");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("本文を読める");
        let parsed = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, parsed)
    }

    /// 生のトークンで叩く (発行済みの一覧に無いものを試すため)。
    async fn send_with_secret(&self, method: &str, path: &str, secret: &str) -> StatusCode {
        let request = HttpRequest::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {secret}"))
            .body(Body::empty())
            .expect("組み立てられる");
        self.app
            .clone()
            .oneshot(request)
            .await
            .expect("応答が返る")
            .status()
    }

    async fn get(&self, path: &str, user: &str) -> (StatusCode, Value) {
        self.send("GET", path, Some(user), None).await
    }

    /// 通るはずの呼び出し。失敗したら本文ごと落とす。
    async fn ok(&self, method: &str, path: &str, user: &str, body: Option<Value>) -> Value {
        let (status, value) = self.send(method, path, Some(user), body).await;
        assert!(
            status.is_success(),
            "{method} {path} が {status} で失敗: {value}"
        );
        value
    }
}

fn sqlite() -> Harness {
    Harness::new(SqliteConn::in_memory().expect("開ける"), Auth::Token)
}

/* ===== 認証 ===== */

#[tokio::test]
async fn a_call_without_a_token_is_refused() {
    let server = sqlite();
    let (status, body) = server.send("GET", "/v1/projects", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "unauthorized");
}

#[tokio::test]
async fn a_made_up_token_is_refused() {
    let server = sqlite();
    let request = HttpRequest::builder()
        .method("GET")
        .uri("/v1/me")
        .header(header::AUTHORIZATION, "Bearer でたらめ")
        .body(Body::empty())
        .unwrap();
    let response = server.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_token_names_its_owner() {
    let server = sqlite();
    let me = server.ok("GET", "/v1/me", "alice", None).await;
    assert_eq!(me["id"], "alice");
    assert_eq!(me["name"], "佐藤");
}

#[tokio::test]
async fn a_trusted_header_names_the_caller() {
    let server = Harness::new(
        SqliteConn::in_memory().unwrap(),
        Auth::Header("X-Forwarded-User".into()),
    );
    let request = HttpRequest::builder()
        .method("GET")
        .uri("/v1/me")
        .header("X-Forwarded-User", "bob")
        .body(Body::empty())
        .unwrap();
    let response = server.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // ヘッダが無ければ通らない。
    let (status, _) = server.send("GET", "/v1/me", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/* ===== プロジェクト ===== */

#[tokio::test]
async fn a_project_can_be_made_read_changed_and_deleted() {
    let server = sqlite();

    let created = server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "新規案件"})),
        )
        .await;
    assert_eq!(created["name"], "新規案件");

    let (status, _) = server
        .send(
            "POST",
            "/v1/projects",
            Some("alice"),
            Some(json!({"id": "p1", "name": "重複"})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "同じ id は作れない");

    // 保存した内容が返ってくる。
    let document = json!({
        "tasks": [{
            "id": "t1", "name": "設計", "parentId": null, "group": "",
            "priority": "normal", "enabled": true,
            "min": "1", "likely": "2", "max": "3",
            "startDate": null, "progress": 0.0, "endDate": null, "assigneeId": null
        }],
        "calendar": created["document"]["calendar"],
        "settings": created["document"]["settings"],
    });
    let summary = server
        .ok(
            "PUT",
            "/v1/projects/p1/document",
            "alice",
            Some(json!({"document": document})),
        )
        .await;
    assert_eq!(summary["taskCount"], 1);

    let fetched = server.ok("GET", "/v1/projects/p1", "alice", None).await;
    assert_eq!(fetched["document"]["tasks"][0]["name"], "設計");

    let renamed = server
        .ok(
            "PATCH",
            "/v1/projects/p1",
            "alice",
            Some(json!({"name": "改名", "dueDate": "2026-12-31"})),
        )
        .await;
    assert_eq!(renamed["name"], "改名");
    assert_eq!(renamed["dueDate"], "2026-12-31");
    assert_eq!(renamed["health"], "unknown", "控えがまだ無い");

    let (status, _) = server
        .send("DELETE", "/v1/projects/p1", Some("alice"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = server.get("/v1/projects/p1", "alice").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_list_only_shows_what_the_caller_may_see() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "秘密"})),
        )
        .await;

    let (_, mine) = server.get("/v1/projects", "alice").await;
    assert_eq!(mine.as_array().map(Vec::len), Some(1));

    let (_, theirs) = server.get("/v1/projects", "bob").await;
    assert_eq!(theirs.as_array().map(Vec::len), Some(0), "共有していない");

    let (status, _) = server.get("/v1/projects/p1", "bob").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_shared_project_can_be_read_but_not_rewritten_by_a_viewer() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    server
        .ok(
            "PUT",
            "/v1/projects/p1/access/user/bob",
            "alice",
            Some(json!({"role": "viewer"})),
        )
        .await;

    let fetched = server.ok("GET", "/v1/projects/p1", "bob", None).await;
    assert_eq!(fetched["name"], "案件");

    let (status, _) = server
        .send(
            "PUT",
            "/v1/projects/p1/document",
            Some("bob"),
            Some(json!({"document": fetched["document"]})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_last_owner_cannot_be_taken_away() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;

    let (status, body) = server
        .send(
            "DELETE",
            "/v1/projects/p1/access/user/alice",
            Some("alice"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "conflict");
}

#[tokio::test]
async fn an_unknown_principal_kind_is_refused() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    let (status, body) = server
        .send(
            "PUT",
            "/v1/projects/p1/access/robot/r2d2",
            Some("alice"),
            Some(json!({"role": "viewer"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "invalid");
}

/* ===== グループ ===== */

#[tokio::test]
async fn a_user_group_carries_access_to_its_members() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/user-groups",
            "root",
            Some(json!({"id": "team", "name": "開発チーム"})),
        )
        .await;
    let group = server
        .ok("PUT", "/v1/user-groups/team/members/bob", "root", None)
        .await;
    assert_eq!(group["members"], json!(["bob"]));

    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    server
        .ok(
            "PUT",
            "/v1/projects/p1/access/group/team",
            "alice",
            Some(json!({"role": "editor"})),
        )
        .await;

    let (_, listed) = server.get("/v1/projects", "bob").await;
    assert_eq!(listed[0]["role"], "editor", "チーム経由で編集できる");

    server
        .ok("DELETE", "/v1/user-groups/team/members/bob", "root", None)
        .await;
    let (_, listed) = server.get("/v1/projects", "bob").await;
    assert_eq!(listed.as_array().map(Vec::len), Some(0), "外れると見えない");
}

#[tokio::test]
async fn a_project_group_hands_its_access_down() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/project-groups",
            "alice",
            Some(json!({"id": "dept", "name": "第一部"})),
        )
        .await;
    server
        .ok(
            "PUT",
            "/v1/project-groups/dept/access/user/bob",
            "alice",
            Some(json!({"role": "viewer"})),
        )
        .await;
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    server
        .ok(
            "PATCH",
            "/v1/projects/p1",
            "alice",
            Some(json!({"groupId": "dept"})),
        )
        .await;

    let (_, listed) = server.get("/v1/projects", "bob").await;
    assert_eq!(listed[0]["groupName"], "第一部");
    assert_eq!(listed[0]["role"], "viewer");

    // グループを消しても、プロジェクトは残って所属だけ外れる。
    server
        .ok("DELETE", "/v1/project-groups/dept", "alice", None)
        .await;
    let fetched = server.ok("GET", "/v1/projects/p1", "alice", None).await;
    assert_eq!(fetched["groupId"], Value::Null);
    let (_, listed) = server.get("/v1/projects", "bob").await;
    assert_eq!(listed.as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn only_an_admin_manages_accounts_over_http() {
    let server = sqlite();
    let new_user = || json!({"id": "dave", "name": "高橋", "systemRole": "member"});

    let (status, _) = server
        .send("POST", "/v1/users", Some("alice"), Some(new_user()))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, created) = server
        .send("POST", "/v1/users", Some("root"), Some(new_user()))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["name"], "高橋");
}

/* ===== 状態 ===== */

#[tokio::test]
async fn a_snapshot_decides_whether_a_project_looks_late() {
    let server = sqlite();
    let created = server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    server
        .ok(
            "PATCH",
            "/v1/projects/p1",
            "alice",
            Some(json!({"dueDate": "2026-10-01"})),
        )
        .await;

    // 期限 (2026-10-01 = 20727 日) より後ろにしか終わらない見通しを送る。
    let document = json!({
        "tasks": [{
            "id": "t1", "name": "設計", "parentId": null, "group": "",
            "priority": "normal", "enabled": true,
            "min": "1", "likely": "2", "max": "3",
            "startDate": null, "progress": 0.0, "endDate": null, "assigneeId": null
        }],
        "calendar": created["document"]["calendar"],
        "settings": created["document"]["settings"],
    });
    let saved = server
        .ok(
            "PUT",
            "/v1/projects/p1/document",
            "alice",
            Some(json!({"document": document})),
        )
        .await;

    let status = json!({
        "computedAt": saved["updatedAt"],
        "basedOn": saved["updatedAt"],
        "effortP50": 2.0, "effortP80": 3.0,
        "finishP50": 20_800, "finishP80": 20_820,
        "spent": 0.0, "progress": 0.0,
        "taskCount": 1, "doneCount": 0,
    });
    let saved = server
        .ok(
            "PUT",
            "/v1/projects/p1/document",
            "alice",
            Some(json!({"document": document, "status": status})),
        )
        .await;
    assert_eq!(saved["health"], "late", "期限に間に合わない");

    let (_, listed) = server.get("/v1/projects", "alice").await;
    assert_eq!(listed[0]["health"], "late");
    assert_eq!(listed[0]["ownerNames"], json!(["佐藤"]));
}

/* ===== そのほか ===== */

#[tokio::test]
async fn every_documented_route_is_served() {
    // 知らないパスは画面 (HTML) に落ち、200 が返る。POST などで落ちたときは
    // 405。どちらも「そのルートを API として持っていない」ことを表すので、
    // そのどちらでもないことを見る。認証を付けていないので、本当に届いて
    // いれば 401 か、本文が足りないという 4xx が返る。
    let server = sqlite();
    for &(method, path) in mhc_api::protocol::ROUTES {
        let concrete = path
            .replace("{userId}", "alice")
            .replace("{groupId}", "g")
            .replace("{projectId}", "p")
            .replace("{principalKind}", "user")
            .replace("{principalId}", "bob");

        let request = HttpRequest::builder()
            .method(method)
            .uri(&concrete)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .expect("組み立てられる");
        let status = server
            .app
            .clone()
            .oneshot(request)
            .await
            .expect("応答が返る")
            .status();

        assert_ne!(
            status,
            StatusCode::OK,
            "{method} {concrete} が画面に落ちている (ルートが無い)"
        );
        assert_ne!(
            status,
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} {concrete} のメソッドが合っていない"
        );
    }
}

#[tokio::test]
async fn the_ui_is_served_from_the_same_binary() {
    let server = sqlite();
    let request = HttpRequest::builder().uri("/").body(Body::empty()).unwrap();
    let response = server.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("text/html; charset=utf-8")
    );
}

#[tokio::test]
async fn health_needs_no_token() {
    let server = sqlite();
    let (status, body) = server.send("GET", "/healthz", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

/* ===== PostgreSQL ===== */

/// `MHC_TEST_POSTGRES_URL` があるときだけ走る。
///
/// SQLite と PostgreSQL で同じ結果になることを見る。ここが通れば、
/// 共通の SQL が両方の方言で成り立っていると言える。
#[tokio::test]
async fn postgres_behaves_the_same_as_sqlite() {
    let Ok(url) = std::env::var("MHC_TEST_POSTGRES_URL") else {
        eprintln!("MHC_TEST_POSTGRES_URL が無いので飛ばします");
        return;
    };

    // `postgres` クレートは自前の実行器を持っていて、繋ぐときにそれを回す。
    // 非同期の文脈から直に呼ぶと「実行器の中で実行器は起こせない」と落ちるので、
    // ここも本番と同じく `spawn_blocking` の中で組み立てる。
    let server = tokio::task::spawn_blocking(move || {
        // 前の走行の残りを消してから始める。
        let mut clean = PostgresConn::connect(&url).expect("繋がる");
        for table in [
            "schema_version",
            "api_tokens",
            "comments",
            "project_access",
            "projects",
            "project_group_access",
            "project_groups",
            "user_group_members",
            "user_groups",
            "users",
        ] {
            let _ = clean.execute(&format!("DROP TABLE IF EXISTS {table}"), &[]);
        }
        Harness::new(PostgresConn::connect(&url).expect("繋がる"), Auth::Token)
    })
    .await
    .expect("組み立てられる");

    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    server
        .ok(
            "POST",
            "/v1/user-groups",
            "root",
            Some(json!({"id": "team", "name": "チーム"})),
        )
        .await;
    server
        .ok("PUT", "/v1/user-groups/team/members/bob", "root", None)
        .await;
    server
        .ok(
            "PUT",
            "/v1/projects/p1/access/group/team",
            "alice",
            Some(json!({"role": "editor"})),
        )
        .await;

    let (_, listed) = server.get("/v1/projects", "bob").await;
    assert_eq!(listed[0]["name"], "案件");
    assert_eq!(listed[0]["role"], "editor");
    assert_eq!(listed[0]["ownerNames"], json!(["佐藤"]));
}

/* ===== 別の場所に置いた画面から呼ぶ ===== */

#[tokio::test]
async fn other_origins_are_refused_unless_they_are_named() {
    // 既定ではどこからも許さない。サーバが自分で配る画面を開くぶんには
    // 同一オリジンなので、これで困ることはない。
    let server = sqlite();
    let request = HttpRequest::builder()
        .method("OPTIONS")
        .uri("/v1/projects")
        .header("Origin", "https://pages.example")
        .header("Access-Control-Request-Method", "GET")
        .body(Body::empty())
        .unwrap();
    let response = server.app.clone().oneshot(request).await.unwrap();
    assert!(
        response
            .headers()
            .get("access-control-allow-origin")
            .is_none(),
        "許していない出どころに許可を返してはいけない"
    );
}

#[tokio::test]
async fn a_named_origin_may_call_the_api() {
    let server = Harness::with_origins(
        SqliteConn::in_memory().unwrap(),
        Auth::Token,
        vec!["https://pages.example".into()],
    );

    // 下調べ (preflight) に答えること。
    let request = HttpRequest::builder()
        .method("OPTIONS")
        .uri("/v1/projects")
        .header("Origin", "https://pages.example")
        .header("Access-Control-Request-Method", "GET")
        .header("Access-Control-Request-Headers", "authorization")
        .body(Body::empty())
        .unwrap();
    let response = server.app.clone().oneshot(request).await.unwrap();
    let headers = response.headers();
    assert_eq!(
        headers
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("https://pages.example")
    );
    assert!(
        headers
            .get("access-control-allow-headers")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().contains("authorization")),
        "トークンを載せられなければ意味がない"
    );

    // 挙げていない出どころには許可を返さない。
    let request = HttpRequest::builder()
        .method("OPTIONS")
        .uri("/v1/projects")
        .header("Origin", "https://よそ.example")
        .header("Access-Control-Request-Method", "GET")
        .body(Body::empty())
        .unwrap();
    let response = server.app.clone().oneshot(request).await.unwrap();
    assert_ne!(
        response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("https://よそ.example")
    );
}

/* ===== コメント ===== */

#[tokio::test]
async fn a_viewer_can_comment_over_http() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    server
        .ok(
            "PUT",
            "/v1/projects/p1/access/user/bob",
            "alice",
            Some(json!({"role": "viewer"})),
        )
        .await;

    // 閲覧しかできない人でも書ける。
    let (status, posted) = server
        .send(
            "POST",
            "/v1/projects/p1/comments",
            Some("bob"),
            Some(json!({"commentId": "c1", "body": "見積もりが楽観的では?"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(posted["author"], "bob");
    assert_eq!(posted["taskId"], Value::Null);

    let (_, listed) = server.get("/v1/projects/p1/comments", "alice").await;
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    assert_eq!(listed[0]["body"], "見積もりが楽観的では?");

    // 共有していない人には見えないし、書けない。
    let (status, _) = server.get("/v1/projects/p1/comments", "root").await;
    assert_eq!(status, StatusCode::OK, "管理者は見える");
    let server2 = &server;
    let (status, _) = server2
        .send(
            "POST",
            "/v1/projects/p1/comments",
            None,
            Some(json!({"commentId": "c2", "body": "誰?"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn comments_can_be_filtered_by_task() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    for (id, task) in [("c1", None), ("c2", Some("t1"))] {
        let mut body = json!({"commentId": id, "body": "何か"});
        if let Some(task) = task {
            body["taskId"] = json!(task);
        }
        server
            .ok("POST", "/v1/projects/p1/comments", "alice", Some(body))
            .await;
    }

    let (_, all) = server.get("/v1/projects/p1/comments", "alice").await;
    assert_eq!(all.as_array().map(Vec::len), Some(2));
    let (_, only) = server
        .get("/v1/projects/p1/comments?taskId=t1", "alice")
        .await;
    assert_eq!(only.as_array().map(Vec::len), Some(1));
    assert_eq!(only[0]["id"], "c2");
}

#[tokio::test]
async fn only_the_author_may_rewrite_a_comment_over_http() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    server
        .ok(
            "PUT",
            "/v1/projects/p1/access/user/bob",
            "alice",
            Some(json!({"role": "editor"})),
        )
        .await;
    server
        .ok(
            "POST",
            "/v1/projects/p1/comments",
            "bob",
            Some(json!({"commentId": "c1", "body": "最初の意見"})),
        )
        .await;

    // 所有者でも他人の発言は直せない。
    let (status, _) = server
        .send(
            "PATCH",
            "/v1/comments/c1",
            Some("alice"),
            Some(json!({"body": "改ざん"})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let edited = server
        .ok(
            "PATCH",
            "/v1/comments/c1",
            "bob",
            Some(json!({"body": "直した"})),
        )
        .await;
    assert_eq!(edited["body"], "直した");
    assert_ne!(edited["updatedAt"], Value::Null);

    // 消すほうは所有者にもできる。
    let (status, _) = server
        .send("DELETE", "/v1/comments/c1", Some("alice"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, listed) = server.get("/v1/projects/p1/comments", "alice").await;
    assert_eq!(listed.as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn deleting_a_project_takes_its_comments_with_it_over_http() {
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "案件"})),
        )
        .await;
    server
        .ok(
            "POST",
            "/v1/projects/p1/comments",
            "alice",
            Some(json!({"commentId": "c1", "body": "何か"})),
        )
        .await;
    server.ok("DELETE", "/v1/projects/p1", "alice", None).await;

    // 同じ id でプロジェクトを作り直しても、前のコメントは出てこない。
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({"id": "p1", "name": "作り直し"})),
        )
        .await;
    let (_, listed) = server.get("/v1/projects/p1/comments", "alice").await;
    assert_eq!(listed.as_array().map(Vec::len), Some(0));
}

/* ===== レビューで見つかったもの ===== */

#[tokio::test]
async fn deleting_a_user_revokes_their_tokens() {
    // トークンが残っていると、あとから同じ id でアカウントを作り直したとき、
    // 消したはずのトークンがそのまま通ってしまう。
    let server = sqlite();
    let bob = server.token("bob").to_string();

    server.ok("DELETE", "/v1/users/bob", "root", None).await;

    // 作り直す。`create_user` が断るのは「いま存在する id」だけ。
    server
        .ok(
            "POST",
            "/v1/users",
            "root",
            Some(json!({ "id": "bob", "name": "別の鈴木", "systemRole": "member" })),
        )
        .await;

    let status = server.send_with_secret("GET", "/v1/me", &bob).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "消したアカウントのトークンが生き返っている"
    );
}

#[tokio::test]
async fn an_attachment_id_used_by_another_comment_does_not_destroy_it() {
    // 添付の id は要求の本文から来た値をそのまま使う。以前は表全体で
    // 一意だったので、他のコメントの id を指定すると「消してから入れ直す」の
    // 入れ直しが主キー違反で落ち、元の添付が消えたままになった。
    let server = sqlite();
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            Some(json!({ "id": "p1", "name": "案件" })),
        )
        .await;

    let attachment = json!({
        "id": "a1",
        "filename": "screen.png",
        "mime": "image/png",
        "size": 3,
        "data": "AAAA",
    });
    for id in ["c1", "c2"] {
        server
            .ok(
                "POST",
                "/v1/projects/p1/comments",
                "alice",
                Some(json!({ "commentId": id, "body": "本文", "attachments": [attachment] })),
            )
            .await;
    }

    // c1 の添付が残っていること。
    let comments = server.get("/v1/projects/p1/comments", "alice").await.1;
    let c1 = comments
        .as_array()
        .expect("配列")
        .iter()
        .find(|c| c["id"] == "c1")
        .expect("ある");
    assert_eq!(
        c1["attachments"].as_array().expect("配列").len(),
        1,
        "同じ id を別のコメントで使ったら消えた"
    );
}

#[tokio::test]
async fn a_duplicated_auth_header_is_refused() {
    // 前段のプロキシが「上書き」ではなく「追加」する設定だと、利用者が送った
    // 値のほうが先に読まれて、名乗りたい放題になる。
    let server = Harness::new(
        SqliteConn::in_memory().unwrap(),
        Auth::Header("X-Forwarded-User".into()),
    );
    let request = HttpRequest::builder()
        .method("GET")
        .uri("/v1/me")
        .header("X-Forwarded-User", "root") // 利用者が送ったもの
        .header("X-Forwarded-User", "bob") // プロキシが足したもの
        .body(Body::empty())
        .unwrap();
    let response = server.app.clone().oneshot(request).await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "重なったヘッダの 1 つ目を信じている"
    );
}

/// 書き込みの**途中**で落ちても、前の中身がそのまま残ること。
///
/// API 層の検査 (`check_attachments`) は書き込みの前に弾くので、ここは
/// 保存層を直に叩く。同じ id の添付を 2 つ持たせると、コメントの行を
/// 書き換えたあと、添付の入れ直しが主キー違反で落ちる。
#[test]
fn a_write_that_fails_part_way_leaves_the_previous_row_alone() {
    use mhc_api::model::{Attachment, Comment, CommentId, ProjectId};

    let store = SqlStore::open(SqliteConn::in_memory().expect("開ける")).expect("開ける");
    let mut handle = &store;

    let file = |id: &str| Attachment {
        id: id.into(),
        filename: "a.png".into(),
        mime: "image/png".into(),
        size: 3,
        data: "AAAA".into(),
    };
    let comment = |body: &str, attachments: Vec<Attachment>| Comment {
        id: CommentId::new("c1"),
        project_id: ProjectId::new("p1"),
        task_id: None,
        author: mhc_api::model::UserId::new("alice"),
        body: body.into(),
        created_at: NOW.into(),
        updated_at: None,
        attachments,
    };

    handle
        .put_comment(comment("最初の本文", vec![file("a1")]))
        .expect("書ける");

    // 添付の id が重なっているので、入れ直しの途中で落ちる。
    let broken = handle.put_comment(comment("書き直した本文", vec![file("dup"), file("dup")]));
    assert!(broken.is_err(), "重複した id が通ってしまった");

    let back = handle
        .comment(&CommentId::new("c1"))
        .expect("読める")
        .expect("ある");
    assert_eq!(back.body, "最初の本文", "落ちたのに本文が書き換わっている");
    assert_eq!(back.attachments.len(), 1, "落ちたのに添付が消えている");
}
