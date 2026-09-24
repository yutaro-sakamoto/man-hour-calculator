//! サーバを攻める側から試す。
//!
//! `api.rs` は「正しく使えば正しく動く」を見る。ここは**悪意のある呼び手**を
//! 想定する。
//!
//! 1. 他人のものに触れない (BOLA / IDOR)。ルート表を全部なめて、関係の無い
//!    アカウントから他人の id で叩き、**1 つも通らず、何も変わらない**ことを見る
//! 2. 認証が無い・壊れているときは、どのルートも 401
//! 3. どの応答にも防御のヘッダが付く (クリックジャッキング・MIME の推測・
//!    リファラ・API の応答をキャッシュに残さない)
//! 4. 大きすぎる本文は断る。ただし**正しい上限いっぱい**の呼び出しは通す
//! 5. パスをいじって (`..` など) 別のものを読ませられない
//!
//! ルート表 (`ROUTES`) から作るので、ルートを足せば自動で検査に入る。

use std::sync::{Arc, RwLock};

use axum::body::Body;
use axum::http::{header, Request as HttpRequest, StatusCode};
use mhc_api::model::{SystemRole, User, UserId, MAX_ATTACHMENTS_PER_COMMENT, MAX_ATTACHMENT_BYTES};
use mhc_api::protocol::ROUTES;
use mhc_api::store::Store;
use mhc_server::auth;
use mhc_server::http::{App, AppState, Auth};
use mhc_server::store::sqlite::SqliteConn;
use mhc_server::store::SqlStore;
use serde_json::{json, Value};
use tower::ServiceExt;

const NOW: &str = "2026-09-20T10:00:00Z";

struct Server {
    app: axum::Router,
    tokens: Vec<(&'static str, String)>,
}

/// 応答の要るところだけ。
struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Value,
}

impl Server {
    fn new() -> Self {
        let store = SqlStore::open(SqliteConn::in_memory().expect("開ける")).expect("開ける");
        let mut tokens = Vec::new();
        for (id, role) in [
            ("root", SystemRole::Admin),
            ("alice", SystemRole::Member),
            ("bob", SystemRole::Member),
        ] {
            (&store)
                .put_user(User {
                    id: UserId::new(id),
                    name: id.into(),
                    email: None,
                    system_role: role,
                    created_at: NOW.into(),
                })
                .expect("作れる");
            let issued = auth::create(&mut *store.sql(), id, "テスト", NOW).expect("発行できる");
            tokens.push((id, issued.secret));
        }
        let app: App<SqliteConn> = Arc::new(AppState {
            store: RwLock::new(store),
            auth: Auth::Token,
            ui: Arc::from("<!doctype html><title>画面</title>"),
            allow_origins: Vec::new(),
        });
        Self {
            app: mhc_server::http::router(app),
            tokens,
        }
    }

    async fn raw(&self, request: HttpRequest<Body>) -> Reply {
        let response = self.app.clone().oneshot(request).await.expect("応答が返る");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 64 << 20)
            .await
            .expect("本文を読める");
        Reply {
            status,
            headers,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }

    /// `user` が `None` なら認証を付けない。`Some("")` なら壊れたトークン。
    async fn send(&self, method: &str, path: &str, user: Option<&str>, body: &str) -> Reply {
        let mut builder = HttpRequest::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(user) = user {
            let secret = self
                .tokens
                .iter()
                .find(|(id, _)| *id == user)
                .map_or("0".repeat(64), |(_, secret)| secret.clone());
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {secret}"));
        }
        self.raw(builder.body(Body::from(body.to_string())).unwrap())
            .await
    }

    async fn ok(&self, method: &str, path: &str, user: &str, body: Value) -> Value {
        let reply = self.send(method, path, Some(user), &body.to_string()).await;
        assert!(
            reply.status.is_success(),
            "{method} {path} が {}: {}",
            reply.status,
            reply.body
        );
        reply.body
    }

    /// 管理者から見た、いまの状態のすべて。攻撃の前後で比べる。
    async fn snapshot(&self) -> Value {
        let mut out = serde_json::Map::new();
        for path in [
            "/v1/users",
            "/v1/user-groups",
            "/v1/project-groups",
            "/v1/projects/p1",
            "/v1/projects/p1/comments",
            "/v1/projects/p1/access",
        ] {
            out.insert(path.into(), self.ok("GET", path, "root", Value::Null).await);
        }
        Value::Object(out)
    }
}

/// alice のものを一揃い作る。bob はどれにも関係しない。
async fn alices_world(server: &Server) {
    server
        .ok(
            "POST",
            "/v1/user-groups",
            "root",
            json!({"id": "g1", "name": "alice のチーム"}),
        )
        .await;
    server
        .ok(
            "PUT",
            "/v1/user-groups/g1/members/alice",
            "root",
            Value::Null,
        )
        .await;
    server
        .ok(
            "POST",
            "/v1/project-groups",
            "alice",
            json!({"id": "pg1", "name": "alice の入れ物"}),
        )
        .await;
    server
        .ok(
            "POST",
            "/v1/projects",
            "alice",
            json!({"id": "p1", "name": "alice の案件"}),
        )
        .await;
    server
        .ok(
            "PATCH",
            "/v1/projects/p1",
            "alice",
            json!({"groupId": "pg1"}),
        )
        .await;
    server
        .ok(
            "POST",
            "/v1/projects/p1/comments",
            "alice",
            json!({"commentId": "c1", "body": "alice のコメント"}),
        )
        .await;
}

/// ルートに差し込む値。**bob を自分自身の手で昇格させる**形にする
/// (自分をグループに入れる・自分に owner を付ける) — いちばんありそうな攻撃。
fn concrete(path: &str) -> String {
    path.replace("{projectId}", "p1")
        .replace("{commentId}", "c1")
        .replace(
            "{groupId}",
            if path.starts_with("/v1/user-groups") {
                "g1"
            } else {
                "pg1"
            },
        )
        .replace(
            "{userId}",
            if path.contains("/members/") {
                "bob"
            } else {
                "alice"
            },
        )
        .replace("{principalKind}", "user")
        .replace("{principalId}", "bob")
}

/// どのルートにも「それらしい」本文。欠けた欄で弾かれて検査が空回り
/// しないよう、どの操作の必須欄も満たしておく。
fn plausible_body(document: &Value) -> String {
    json!({
        "id": "p9",
        "newId": "p9",
        "commentId": "c9",
        "name": "乗っ取り",
        "body": "乗っ取り",
        "role": "owner",
        "systemRole": "admin",
        "groupId": "pg1",
        "document": document,
    })
    .to_string()
}

#[tokio::test]
async fn an_unrelated_member_can_neither_read_nor_change_anything_of_anothers() {
    let server = Server::new();
    alices_world(&server).await;
    let document = server
        .ok("GET", "/v1/projects/p1", "alice", Value::Null)
        .await["document"]
        .clone();
    let body = plausible_body(&document);
    let before = server.snapshot().await;

    let mut probed = 0;
    for &(method, path) in ROUTES {
        // id を含まないルート (一覧・新規作成) は、自分の範囲で使えるのが正しい。
        // 一覧に他人のものが混ざらないことは下の検査で見る。
        if !path.contains('{') {
            continue;
        }
        let target = concrete(path);
        let reply = server.send(method, &target, Some("bob"), &body).await;
        assert!(
            !reply.status.is_success(),
            "bob が {method} {target} を通した ({}): {}",
            reply.status,
            reply.body
        );
        // 失敗の応答に、他人のものの中身を載せていない。
        let text = reply.body.to_string();
        assert!(
            !text.contains("alice のコメント") && !text.contains("\"tasks\""),
            "{method} {target} の失敗の応答に中身が漏れた: {text}"
        );
        probed += 1;
    }
    assert!(
        probed >= 15,
        "id を持つルートを {probed} 個しか試していない"
    );

    assert_eq!(
        server.snapshot().await,
        before,
        "失敗したはずの呼び出しで状態が変わった"
    );

    // 一覧には、共有されていないものが出ない。
    let listed = server
        .ok("GET", "/v1/projects", "bob", Value::Null)
        .await
        .to_string();
    assert!(!listed.contains("alice の案件"), "{listed}");
}

#[tokio::test]
async fn a_member_cannot_do_what_only_an_admin_may() {
    let server = Server::new();
    alices_world(&server).await;
    let before = server.snapshot().await;
    for (method, path, body) in [
        (
            "POST",
            "/v1/users",
            json!({"id": "eve", "name": "eve", "systemRole": "admin"}),
        ),
        ("PATCH", "/v1/users/bob", json!({"systemRole": "admin"})),
        ("DELETE", "/v1/users/alice", Value::Null),
        ("POST", "/v1/user-groups", json!({"id": "g9", "name": "x"})),
        ("DELETE", "/v1/user-groups/g1", Value::Null),
    ] {
        let reply = server
            .send(method, path, Some("bob"), &body.to_string())
            .await;
        assert_eq!(
            reply.status,
            StatusCode::FORBIDDEN,
            "{method} {path}: {}",
            reply.body
        );
    }
    assert_eq!(server.snapshot().await, before);
}

#[tokio::test]
async fn every_route_needs_a_valid_token() {
    let server = Server::new();
    alices_world(&server).await;
    let before = server.snapshot().await;
    for &(method, path) in ROUTES {
        let target = concrete(path);
        for (who, label) in [(None, "トークン無し"), (Some("mallory"), "偽のトークン")]
        {
            let reply = server.send(method, &target, who, "{}").await;
            assert_eq!(
                reply.status,
                StatusCode::UNAUTHORIZED,
                "{label}で {method} {target} が {}",
                reply.status
            );
        }
    }
    assert_eq!(server.snapshot().await, before);
}

/* ===== 応答ヘッダ ===== */

#[tokio::test]
async fn every_response_carries_the_defensive_headers() {
    let server = Server::new();
    alices_world(&server).await;
    let cases = [
        ("GET", "/", None),
        ("GET", "/some/deep/link", None),
        ("GET", "/healthz", None),
        ("GET", "/v1/me", None),                     // 401
        ("GET", "/v1/me", Some("alice")),            // 200
        ("GET", "/v1/projects/nope", Some("alice")), // 404
        ("POST", "/v1/projects", Some("alice")),     // 400/422 (本文が足りない)
    ];
    for (method, path, user) in cases {
        let reply = server.send(method, path, user, "{}").await;
        let header = |name: &str| {
            reply
                .headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string()
        };
        let what = format!("{method} {path} ({})", reply.status);
        // 型を推測させない (JSON を HTML として読ませない)。
        assert_eq!(header("x-content-type-options"), "nosniff", "{what}");
        // 別のサイトの枠に入れさせない (クリックジャッキング)。
        assert_eq!(header("x-frame-options"), "DENY", "{what}");
        assert!(
            header("content-security-policy").contains("frame-ancestors 'none'"),
            "{what}"
        );
        // URL (プロジェクトの id など) を外へ渡さない。
        assert_eq!(header("referrer-policy"), "no-referrer", "{what}");
        // API の応答 (中身とトークンで引いたもの) を途中に残させない。
        if path.starts_with("/v1/") {
            assert_eq!(header("cache-control"), "no-store", "{what}");
        }
    }
}

/* ===== 大きさ ===== */

/// 添付は 1 件 1 MiB、1 コメントに 5 件まで (`crates/api` の上限)。
/// base64 にすると 6.7 MiB ほどになる。axum の既定の上限 (2 MiB) のままだと、
/// **正しい呼び出しがサーバでだけ 413 で落ちていた** (ローカル版では通る)。
#[tokio::test]
async fn a_comment_with_the_largest_allowed_attachments_goes_through() {
    let server = Server::new();
    alices_world(&server).await;
    // ちょうど 1 MiB になる base64 (末尾の `==` まで含めて)。
    let encoded = (MAX_ATTACHMENT_BYTES as usize).div_ceil(3) * 4;
    let data = format!("{}==", "A".repeat(encoded - 2));
    let attachments: Vec<Value> = (0..MAX_ATTACHMENTS_PER_COMMENT)
        .map(|i| {
            json!({
                "id": format!("a{i}"),
                "filename": format!("f{i}.png"),
                "mime": "image/png",
                "size": MAX_ATTACHMENT_BYTES,
                "data": data,
            })
        })
        .collect();
    let body = json!({"commentId": "big", "body": "添付", "attachments": attachments});
    let reply = server
        .send(
            "POST",
            "/v1/projects/p1/comments",
            Some("alice"),
            &body.to_string(),
        )
        .await;
    assert!(
        reply.status.is_success(),
        "{}: {}",
        reply.status,
        reply.body
    );
}

#[tokio::test]
async fn an_oversized_body_is_refused_before_it_is_read() {
    let server = Server::new();
    alices_world(&server).await;
    let before = server.snapshot().await;
    let huge = format!(
        "{{\"id\":\"p2\",\"name\":\"{}\"}}",
        "x".repeat(32 * 1024 * 1024)
    );
    let reply = server
        .send("POST", "/v1/projects", Some("alice"), &huge)
        .await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(server.snapshot().await, before);
}

/* ===== パス ===== */

/// 知らないパスは画面に落ちる (深いリンクのため)。`..` やエンコードした
/// 区切りで、ファイルや別の API を読ませられないこと。
#[tokio::test]
async fn path_tricks_only_ever_reach_the_ui_or_nothing() {
    let server = Server::new();
    alices_world(&server).await;
    for path in [
        "/../../../../etc/passwd",
        "/%2e%2e/%2e%2e/etc/passwd",
        "/v1/projects/..%2f..%2fetc%2fpasswd",
        "/v1/projects/p1%2F..%2F..%2Fusers",
        "//etc/passwd",
        "/v1/projects/p1/../../users",
    ] {
        let request = HttpRequest::builder()
            .method("GET")
            .uri(path)
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", server.tokens[2].1), // bob
            )
            .body(Body::empty());
        let Ok(request) = request else {
            continue; // URI として組み立てられないものは、そもそも届かない
        };
        let reply = server.raw(request).await;
        let text = reply.body.to_string();
        assert!(
            !text.contains("root:") && !text.contains("alice の案件"),
            "{path} ({}) が何かを読ませた: {text}",
            reply.status
        );
    }
}

/* ===== SQL ===== */

/// id・名前・本文に SQL の記号を入れても、ただの文字として往復し、
/// ほかの行に何も起きない。値は必ず `?` で渡している (表と列の名前だけは
/// コードの定数を差し込む) ので通らないはずだが、それを HTTP 越しに確かめる。
#[tokio::test]
async fn sql_metacharacters_are_only_ever_text() {
    let server = Server::new();
    alices_world(&server).await;
    let before = server.snapshot().await;
    let nasty = [
        "' OR '1'='1",
        "x'); DROP TABLE projects;--",
        "\\'; DELETE FROM users; --",
        "\" OR \"\"=\"",
        "%' AND 1=1 --",
        "p\0null",
    ];
    let mut round_trips = 0;
    for (i, text) in nasty.iter().enumerate() {
        let id = format!("q{i}{text}");
        let encoded: String = id
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect();
        let created = server
            .send(
                "POST",
                "/v1/projects",
                Some("bob"),
                &json!({"id": id, "name": text}).to_string(),
            )
            .await;
        if !created.status.is_success() {
            // NUL など、入口で断るのも正しい。断ったなら何も変わっていない。
            continue;
        }
        let read = server
            .ok(
                "GET",
                &format!("/v1/projects/{encoded}"),
                "bob",
                Value::Null,
            )
            .await;
        assert_eq!(read["name"], *text, "名前が化けた");
        server
            .ok(
                "POST",
                &format!("/v1/projects/{encoded}/comments"),
                "bob",
                json!({"commentId": format!("c-{i}"), "body": text}),
            )
            .await;
        round_trips += 1;
    }
    // 全部が入口で断られていたら、この検査は何も見ていない。
    assert!(round_trips >= 4, "往復できたのが {round_trips} 件だけ");
    // alice のものも、アカウントも、そのまま。
    assert_eq!(server.snapshot().await, before);
}

/* ===== 負荷 ===== */

/// 同時に大量に叩いても、書き込みが消えず、所有者が居なくならず、500 が出ない。
///
/// サーバは「読む → 判定 → 書く」を書き込みロックで直列にしている
/// (`http.rs` の冒頭)。ロックを取り違えると、同時に来た 2 つの書き込みの
/// 片方が消えたり、2 人が同時に自分の owner を外して誰も居なくなったりする。
/// 単発のテストでは起きない種類の誤りなので、ここで並べて叩く。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writers_lose_nothing_and_keep_an_owner() {
    let server = Arc::new(Server::new());
    alices_world(&server).await;
    // bob も p1 の owner にする。2 人が同時に「自分を外す」を撃つ。
    server
        .ok(
            "PUT",
            "/v1/projects/p1/access/user/bob",
            "alice",
            json!({"role": "owner"}),
        )
        .await;

    const WORKERS: usize = 16;
    const EACH: usize = 20;
    let started = std::time::Instant::now();
    let mut tasks = Vec::new();
    for worker in 0..WORKERS {
        let server = server.clone();
        tasks.push(tokio::spawn(async move {
            let me = if worker % 2 == 0 { "alice" } else { "bob" };
            let mut statuses = Vec::new();
            for i in 0..EACH {
                // 自分の案件を 1 件ずつ増やす (消えてはいけない)。
                let id = format!("w{worker}-{i}");
                let created = server
                    .send(
                        "POST",
                        "/v1/projects",
                        Some(me),
                        &json!({"id": id, "name": id}).to_string(),
                    )
                    .await;
                statuses.push(created.status);
                // 共有の案件で、自分の owner を外そうとする (最後の 1 人は断られる)。
                let removed = server
                    .send(
                        "DELETE",
                        &format!("/v1/projects/p1/access/user/{me}"),
                        Some(me),
                        "{}",
                    )
                    .await;
                statuses.push(removed.status);
                // 外せたら戻してもらう (もう片方が owner のはず)。
                let other = if me == "alice" { "bob" } else { "alice" };
                let restored = server
                    .send(
                        "PUT",
                        &format!("/v1/projects/p1/access/user/{me}"),
                        Some(other),
                        &json!({"role": "owner"}).to_string(),
                    )
                    .await;
                statuses.push(restored.status);
                let read = server.send("GET", "/v1/projects", Some(me), "{}").await;
                statuses.push(read.status);
            }
            statuses
        }));
    }
    let mut total = 0;
    for task in tasks {
        for status in task.await.expect("落ちない") {
            total += 1;
            assert!(
                !status.is_server_error(),
                "同時に叩いたら {status} が返った"
            );
        }
    }
    let elapsed = started.elapsed();
    eprintln!(
        "{total} 件を {:.2?} で処理 ({:.0} 件/秒)",
        elapsed,
        total as f64 / elapsed.as_secs_f64()
    );

    // 作った案件は 1 件も消えていない。
    let listed = server.ok("GET", "/v1/projects", "root", Value::Null).await;
    let made = listed
        .as_array()
        .expect("一覧")
        .iter()
        .filter(|p| p["id"].as_str().is_some_and(|id| id.starts_with('w')))
        .count();
    assert_eq!(made, WORKERS * EACH, "同時の書き込みで案件が消えた");

    // 共有の案件には、まだ owner が居る。
    let access = server
        .ok("GET", "/v1/projects/p1/access", "root", Value::Null)
        .await;
    let owners = access
        .as_array()
        .expect("権限")
        .iter()
        .filter(|entry| entry["role"] == "owner")
        .count();
    assert!(owners >= 1, "同時に外したら owner が居なくなった: {access}");
}
