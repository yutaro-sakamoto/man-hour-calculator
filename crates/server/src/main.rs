//! 起動。
//!
//! `mhc-server` と打つだけで、`./mhc.db` に保存し、`127.0.0.1:8080` で
//! 待ち受け、画面も同じところから配る。**用意するものは何もない。**
//! 初回だけ管理者とトークンを作り、標準出力に一度だけ出す。

#![forbid(unsafe_code)]

use std::sync::{Arc, RwLock};

use clap::Parser;
use mhc_api::error::ApiResult;
use mhc_api::model::{SystemRole, User, UserId};
use mhc_api::store::Store;
use mhc_server::config::{parse_backend, AuthKind, Backend, Cli, Command, TokenCommand};
use mhc_server::http::{App, AppState, Auth};
use mhc_server::store::postgres::PostgresConn;
use mhc_server::store::sqlite::SqliteConn;
use mhc_server::store::{Sql, SqlStore};
use mhc_server::{auth, clock, EMBEDDED_UI};

fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let cli = Cli::parse();
    let backend = parse_backend(&cli.db)?;

    // 保存先ごとに同じ手順を走らせる。型が違うだけで、やることは同じ。
    match backend {
        Backend::Sqlite(path) => {
            let conn = SqliteConn::open(&path).map_err(|e| e.message)?;
            start(cli, conn)
        }
        Backend::Postgres(url) => {
            let conn = PostgresConn::connect(&url).map_err(|e| e.message)?;
            start(cli, conn)
        }
    }
}

fn start<C: Sql + 'static>(cli: Cli, conn: C) -> Result<(), String> {
    let store = SqlStore::open(conn).map_err(|e| e.message)?;
    let label = store.label();

    // 下請けの用事 (トークンの発行など) はここで終わる。
    if let Some(Command::Token(command)) = &cli.command {
        return run_token_command(&store, command).map_err(|e| e.message);
    }

    let admin = ensure_admin(&store, &cli).map_err(|e| e.message)?;
    let auth = pick_auth(&cli, &admin)?;
    let ui = load_ui(&cli)?;

    let app: App<C> = Arc::new(AppState {
        store: RwLock::new(store),
        auth,
        ui,
    });

    println!("保存先: {label}");
    println!("待ち受け: http://{}", cli.listen);
    serve(app, cli.listen)
}

/// 認証のしかたを決める。`none` は危ないので、黙って始めない。
fn pick_auth(cli: &Cli, admin: &UserId) -> Result<Auth, String> {
    Ok(match cli.auth {
        AuthKind::Token => Auth::Token,
        AuthKind::Header => {
            println!(
                "認証: {} ヘッダを信用します。\n\
                 このヘッダを必ず上書きする前段 (リバースプロキシや SSO) の\n\
                 後ろに置いてください。直接公開すると誰にでもなりすませます。",
                cli.auth_header
            );
            Auth::Header(cli.auth_header.clone())
        }
        AuthKind::None => {
            let user = cli
                .auth_user
                .clone()
                .map_or_else(|| admin.clone(), UserId::new);
            println!(
                "警告: 認証なしで起動します。繋いだ全員が「{}」として\n\
                 すべてを操作できます。手元で試すときだけにしてください。",
                user.as_str()
            );
            Auth::Trusting(user)
        }
    })
}

/// 配る画面を読む。`--ui` があればそれを、無ければ埋め込んだもの。
fn load_ui(cli: &Cli) -> Result<Arc<str>, String> {
    match &cli.ui {
        Some(path) => std::fs::read_to_string(path)
            .map(Arc::from)
            .map_err(|e| format!("画面を読めません ({}): {e}", path.display())),
        None => Ok(Arc::from(EMBEDDED_UI)),
    }
}

/// 管理者が 1 人もいなければ作り、最初のトークンを出す。
///
/// **この一度しか平文は出ない。** 控え損ねたら
/// `mhc-server token create --user <id>` でもう 1 本出す。
fn ensure_admin<C: Sql>(store: &SqlStore<C>, cli: &Cli) -> ApiResult<UserId> {
    let users = (&store).users()?;
    if let Some(admin) = users
        .iter()
        .find(|user| user.system_role == SystemRole::Admin)
    {
        return Ok(admin.id.clone());
    }

    let now = clock::now();
    let id = UserId::new(&cli.admin_id);
    // `Store` は借りた形に実装してあるので、共有参照をそのまま可変の場所に置く。
    let mut borrowed = store;
    borrowed.put_user(User {
        id: id.clone(),
        name: cli.admin_name.clone(),
        email: None,
        system_role: SystemRole::Admin,
        created_at: now.clone(),
    })?;
    let issued = auth::create(&mut *store.sql(), id.as_str(), "最初のトークン", &now)?;

    println!(
        "管理者「{}」({}) を作りました。",
        cli.admin_name, cli.admin_id
    );
    println!();
    println!("  トークン: {}", issued.secret);
    println!();
    println!("この 1 回しか表示されません。控えてください。");
    println!(
        "失くしたら: mhc-server token create --user {}",
        cli.admin_id
    );
    println!();
    Ok(id)
}

fn run_token_command<C: Sql>(store: &SqlStore<C>, command: &TokenCommand) -> ApiResult<()> {
    match command {
        TokenCommand::Create { user, label } => {
            if (&store).user(&UserId::new(user.clone()))?.is_none() {
                println!("アカウント「{user}」がありません。");
                return Ok(());
            }
            let issued = auth::create(&mut *store.sql(), user, label, &clock::now())?;
            println!("id: {}", issued.id);
            println!("トークン: {}", issued.secret);
            println!();
            println!("この 1 回しか表示されません。控えてください。");
        }
        TokenCommand::List => {
            let tokens = auth::list(&mut *store.sql())?;
            if tokens.is_empty() {
                println!("トークンはまだありません。");
            }
            for token in tokens {
                println!(
                    "{}\t{}\t{}\t作成 {}\t最終 {}",
                    token.id,
                    token.user_id,
                    if token.label.is_empty() {
                        "-"
                    } else {
                        &token.label
                    },
                    token.created_at,
                    token.last_used_at.as_deref().unwrap_or("-"),
                );
            }
        }
        TokenCommand::Revoke { id } => {
            if auth::revoke(&mut *store.sql(), id)? {
                println!("失効させました: {id}");
            } else {
                println!("そのトークンはありません: {id}");
            }
        }
    }
    Ok(())
}

/// 非同期の実行器をここで初めて起こす。保存先の用事だけなら要らない。
fn serve<C: Sql + 'static>(app: App<C>, listen: std::net::SocketAddr) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("実行器を作れません: {e}"))?;

    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .map_err(|e| format!("{listen} で待ち受けられません: {e}"))?;
        axum::serve(listener, mhc_server::http::router(app))
            .with_graceful_shutdown(shutdown())
            .await
            .map_err(|e| format!("サーバが落ちました: {e}"))
    })
}

/// Ctrl-C で、処理中のリクエストを終えてから止まる。
async fn shutdown() {
    if tokio::signal::ctrl_c().await.is_ok() {
        println!("\n止めます。");
    }
}
