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
    // 版 4: 添付の一意性を**コメント単位**にする。
    //
    // 版 3 では `id` が表全体で一意だった。id は要求の本文から来た値を
    // そのまま使うので、他のコメントの添付 id を指定されると
    // 「消してから入れ直す」の入れ直しが主キー違反で落ち、**元の添付が
    // 消えたまま**になる。
    &[
        "CREATE TABLE attachments_v4 (
            id TEXT NOT NULL,
            comment_id TEXT NOT NULL,
            position BIGINT NOT NULL,
            filename TEXT NOT NULL,
            mime TEXT NOT NULL,
            size BIGINT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (comment_id, id)
        )",
        "INSERT INTO attachments_v4 (id, comment_id, position, filename, mime, size, data) \
         SELECT id, comment_id, position, filename, mime, size, data FROM attachments",
        "DROP TABLE attachments",
        "ALTER TABLE attachments_v4 RENAME TO attachments",
        "CREATE INDEX attachments_by_comment ON attachments (comment_id, position)",
    ],
];

/// いま入っている版。まだ何も無ければ 0。
pub const SCHEMA_VERSION: usize = STEPS.len();

/// 足りない段だけを当てる。すでに最新なら何もしない。
pub fn migrate(sql: &mut dyn Sql) -> ApiResult<()> {
    migrate_to(sql, SCHEMA_VERSION)
}

/// `target` の版まで当てる。途中の版のデータベースを作って、そこから
/// 最新へ上げる検査のために分けてある (本番は常に最新まで)。
fn migrate_to(sql: &mut dyn Sql, target: usize) -> ApiResult<()> {
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

    for (index, step) in STEPS.iter().enumerate().take(target).skip(current) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::sqlite::SqliteConn;
    use crate::store::SqlStore;
    use mhc_api::model::{CommentId, ProjectId, UserId};
    use mhc_api::store::Store;

    /// その版の表にだけ書ける形で、1 揃いのデータを直に入れる。
    /// 中身は「その版を使っていた頃のサーバが書いたもの」を模している。
    fn fill(sql: &mut dyn Sql, version: usize) {
        let text = Value::text;
        sql.execute(
            "INSERT INTO users (id, name, email, system_role, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                text("u1"),
                text("佐藤"),
                Value::Null,
                text("admin"),
                text("2026-01-01T00:00:00Z"),
            ],
        )
        .unwrap();
        sql.execute(
            "INSERT INTO projects (id, name, created_at, updated_at, group_id, due_date, status, \
             task_count, member_count, document) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                text("p1"),
                text("案件"),
                text("2026-01-01T00:00:00Z"),
                text("2026-01-01T00:00:00Z"),
                Value::Null,
                Value::Null,
                Value::Null,
                text("0"),
                text("1"),
                text(r#"{"tasks":[],"calendar":{},"settings":{}}"#),
            ],
        )
        .unwrap();
        sql.execute(
            "INSERT INTO project_access (project_id, principal_kind, principal_id, role) \
             VALUES (?, ?, ?, ?)",
            &[text("p1"), text("user"), text("u1"), text("owner")],
        )
        .unwrap();
        if version >= 2 {
            sql.execute(
                "INSERT INTO comments (id, project_id, task_id, author, body, created_at, \
                 updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                &[
                    text("c1"),
                    text("p1"),
                    Value::Null,
                    text("u1"),
                    text("本文"),
                    text("2026-01-02T00:00:00Z"),
                    Value::Null,
                ],
            )
            .unwrap();
        }
        if version >= 3 {
            sql.execute(
                "INSERT INTO attachments (id, comment_id, position, filename, mime, size, data) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                &[
                    text("a1"),
                    text("c1"),
                    Value::Int(0),
                    text("図.png"),
                    text("image/png"),
                    Value::Int(3),
                    text("AAAA"),
                ],
            )
            .unwrap();
        }
    }

    /// **どの版のデータベースからでも**最新に上げられ、中身が残る。
    ///
    /// 最新の表で作ったデータベースだけを試していると、段を足したときに
    /// 「古い版の行を運べない」誤り (列の取り違え・主キーの衝突) に
    /// 気づけない。版 4 の添付の付け替えがまさにそれを運ぶ段。
    #[test]
    fn every_old_database_upgrades_to_the_latest_with_its_data() {
        for version in 1..=SCHEMA_VERSION {
            let mut conn = SqliteConn::in_memory().unwrap();
            migrate_to(&mut conn, version).unwrap();
            fill(&mut conn, version);

            let store = SqlStore::open(conn)
                .unwrap_or_else(|e| panic!("版 {version} から上げられない: {e:?}"));
            let what = format!("版 {version} から上げたもの");
            let user = (&store).user(&UserId::new("u1")).unwrap().expect(&what);
            assert_eq!(user.name, "佐藤", "{what}");
            let project = (&store)
                .project(&ProjectId::new("p1"))
                .unwrap()
                .expect(&what);
            assert_eq!(project.meta.name, "案件", "{what}");
            assert_eq!(project.meta.access.len(), 1, "{what}");
            if version >= 2 {
                let comment = (&store)
                    .comment(&CommentId::new("c1"))
                    .unwrap()
                    .expect(&what);
                assert_eq!(comment.body, "本文", "{what}");
                if version >= 3 {
                    assert_eq!(comment.attachments.len(), 1, "{what}");
                    assert_eq!(comment.attachments[0].filename, "図.png", "{what}");
                }
            }
            // 上げたあとも、最新の約束どおりに書ける。
            (&store)
                .put_user(mhc_api::model::User {
                    id: UserId::new("u2"),
                    name: "新しい人".into(),
                    email: None,
                    system_role: mhc_api::model::SystemRole::Member,
                    created_at: "2026-02-01T00:00:00Z".into(),
                })
                .unwrap();
        }
    }

    /// 2 度当てても何も起きない (起動のたびに `migrate` が呼ばれる)。
    #[test]
    fn migrating_twice_changes_nothing() {
        let mut conn = SqliteConn::in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(read_version(&mut conn).unwrap(), SCHEMA_VERSION);
    }
}
