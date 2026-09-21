//! 表の定義と、版を進める手順。
//!
//! `schema_version` に「どこまで適用したか」を 1 行だけ持ち、[`STEPS`] の
//! 先頭から順に、まだ当てていないものだけを当てる。**過去の段を書き換えない**
//! かぎり、古いデータベースも新しいバイナリで開ける。
//!
//! SQL は SQLite と PostgreSQL の共通部分だけで書いてある。`TEXT` と
//! `BIGINT`、複合主キー、`REFERENCES` はどちらも同じ綴りで通る。

use mhc_api::error::{ApiError, ApiResult};

use super::{Reader, Sql, Value};

/// 版ごとの SQL。**足すのは末尾だけ**。既にあるものは書き換えない。
const STEPS: &[&[&str]] = &[
    // 版 1: 最初の一式。
    &[
        "CREATE TABLE users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT,
            system_role TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
        "CREATE TABLE user_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
        "CREATE TABLE user_group_members (
            group_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            PRIMARY KEY (group_id, user_id)
        )",
        "CREATE TABLE project_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
        "CREATE TABLE project_group_access (
            group_id TEXT NOT NULL,
            principal_kind TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            role TEXT NOT NULL,
            PRIMARY KEY (group_id, principal_kind, principal_id)
        )",
        "CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            group_id TEXT,
            due_date TEXT,
            status TEXT,
            task_count TEXT NOT NULL,
            member_count TEXT NOT NULL,
            document TEXT NOT NULL
        )",
        "CREATE TABLE project_access (
            project_id TEXT NOT NULL,
            principal_kind TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            role TEXT NOT NULL,
            PRIMARY KEY (project_id, principal_kind, principal_id)
        )",
        // 「自分が見られるプロジェクト」を引くための索引。いまは全件を
        // 読んでから絞っているが、DynamoDB へ移すときもここが分かれ目になる。
        "CREATE INDEX project_access_by_principal
            ON project_access (principal_kind, principal_id)",
        "CREATE INDEX projects_by_group ON projects (group_id)",
        "CREATE TABLE api_tokens (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            hash TEXT NOT NULL,
            label TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_used_at TEXT
        )",
        "CREATE INDEX api_tokens_by_user ON api_tokens (user_id)",
    ],
    // 版 2: コメント。内容とは別の表に置く。
    //
    // 内容の保存は毎回まるごと置き換えるので、同じ JSON に入れると 2 人が
    // 同時に書いたときに片方が消える。行に分けておけば、書き込みは 1 行の
    // 追加で済む。
    &[
        "CREATE TABLE comments (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            task_id TEXT,
            author TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT
        )",
        "CREATE INDEX comments_by_project ON comments (project_id, created_at)",
    ],
    // 版 3: コメントの添付。
    //
    // これも行に分ける。コメントの本文に混ぜると、本文を直すたびに
    // 添付のバイト列まで読み書きすることになる。
    &[
        "CREATE TABLE attachments (
            id TEXT PRIMARY KEY,
            comment_id TEXT NOT NULL,
            position BIGINT NOT NULL,
            filename TEXT NOT NULL,
            mime TEXT NOT NULL,
            size BIGINT NOT NULL,
            data TEXT NOT NULL
        )",
        "CREATE INDEX attachments_by_comment ON attachments (comment_id, position)",
    ],
];

/// いま入っている版。まだ何も無ければ 0。
pub const SCHEMA_VERSION: usize = STEPS.len();

/// 足りない段だけを当てる。すでに最新なら何もしない。
pub fn migrate(sql: &mut dyn Sql) -> ApiResult<()> {
    sql.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version BIGINT NOT NULL)",
        &[],
    )?;

    let current = read_version(sql)?;
    if current > SCHEMA_VERSION {
        return Err(ApiError::internal(format!(
            "この保存先は版 {current} で、このバイナリ (版 {SCHEMA_VERSION}) より新しいものです。\
             サーバを更新してください"
        )));
    }

    for (index, step) in STEPS.iter().enumerate().skip(current) {
        for statement in *step {
            sql.execute(statement, &[])?;
        }
        write_version(sql, index + 1)?;
    }
    Ok(())
}

fn read_version(sql: &mut dyn Sql) -> ApiResult<usize> {
    let rows = sql.query("SELECT version FROM schema_version", &[])?;
    let Some(row) = rows.first() else {
        return Ok(0);
    };
    match Reader::new(row).next()? {
        Value::Int(version) => usize::try_from(*version)
            .map_err(|_| ApiError::internal(format!("版が読めません: {version}"))),
        other => Err(ApiError::internal(format!("版が読めません: {other:?}"))),
    }
}

fn write_version(sql: &mut dyn Sql, version: usize) -> ApiResult<()> {
    sql.execute("DELETE FROM schema_version", &[])?;
    sql.execute(
        "INSERT INTO schema_version (version) VALUES (?)",
        &[Value::Int(i64::try_from(version).unwrap_or(i64::MAX))],
    )
}
