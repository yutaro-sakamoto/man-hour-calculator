//! 保存先。SQLite と PostgreSQL のどちらでも同じように動く。
//!
//! # なぜ SQL を 1 組しか書かないのか
//!
//! 2 つのドライバは型も書き方も違うが、**必要なのは「文を実行する」と
//! 「行を読む」だけ**で、方言の差は穴埋めの書き方 (`?` と `$1`) しかない。
//! そこで [`Sql`] という薄い口を切り、問い合わせは 1 組だけ書く。
//! 保存先が増えても、増えるのはドライバ 1 枚で、`Store` の実装は増えない。
//!
//! # どこまで行に展開するか
//!
//! 見積もりの中身 (`document`) は JSON のまま 1 列に持つ。サーバは中身を
//! 解釈しないので、列に割るとただ壊れやすくなるだけ。一方、**権限と
//! グループは行に展開する**。「自分が見られるプロジェクト」を将来
//! インデックスで引けるようにしておきたいため。

pub mod postgres;
pub mod schema;
pub mod sqlite;

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use mhc_api::error::{ApiError, ApiResult};
use mhc_api::model::{
    AccessEntry, Attachment, Comment, CommentId, Document, Principal, Project, ProjectGroup,
    ProjectGroupId, ProjectId, ProjectMeta, ProjectRole, ProjectStatus, SystemRole, User,
    UserGroup, UserGroupId, UserId,
};
use mhc_api::store::Store;

/// 穴埋めに渡せる値。SQL に必要なのはこの 3 つだけ。
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Int(i64),
    Text(String),
}

impl Value {
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    /// `None` を `NULL` にする。
    pub fn opt_text(value: Option<impl Into<String>>) -> Self {
        match value {
            Some(text) => Self::Text(text.into()),
            None => Self::Null,
        }
    }
}

/// 1 行ぶんの値。列の並びは問い合わせの `SELECT` の順。
pub type Row = Vec<Value>;

/// 保存先への薄い口。
///
/// SQL は `?` で穴を開けて書く。PostgreSQL 向けにはドライバ側が
/// `$1, $2, …` に書き換える (**文字列リテラルに `?` を書かないこと**。
/// この規約に頼って素朴に置き換えている)。
pub trait Sql: Send {
    /// 結果を返さない文。
    fn execute(&mut self, sql: &str, params: &[Value]) -> ApiResult<()>;

    /// 行を返す問い合わせ。
    fn query(&mut self, sql: &str, params: &[Value]) -> ApiResult<Vec<Row>>;

    /// この保存先の呼び名 (起動時のログに出す)。
    fn label(&self) -> String;
}

/// 取り出した行を読む助け。列がずれていたら 500 にする (黙って 0 にしない)。
struct Reader<'a> {
    row: &'a Row,
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(row: &'a Row) -> Self {
        Self { row, at: 0 }
    }

    fn next(&mut self) -> ApiResult<&'a Value> {
        let value = self
            .row
            .get(self.at)
            .ok_or_else(|| ApiError::internal("取り出した行に列が足りません"))?;
        self.at += 1;
        Ok(value)
    }

    fn text(&mut self) -> ApiResult<String> {
        match self.next()? {
            Value::Text(text) => Ok(text.clone()),
            other => Err(ApiError::internal(format!(
                "文字列のはずの列が {other:?} でした"
            ))),
        }
    }

    fn opt_text(&mut self) -> ApiResult<Option<String>> {
        match self.next()? {
            Value::Null => Ok(None),
            Value::Text(text) => Ok(Some(text.clone())),
            other => Err(ApiError::internal(format!(
                "文字列か NULL のはずの列が {other:?} でした"
            ))),
        }
    }

    fn int(&mut self) -> ApiResult<i64> {
        match self.next()? {
            Value::Int(value) => Ok(*value),
            other => Err(ApiError::internal(format!(
                "整数のはずの列が {other:?} でした"
            ))),
        }
    }
}

/// 文字列から列挙に戻す。保存されていた値が読めないのは、こちらの落ち度。
fn parse_system_role(text: &str) -> ApiResult<SystemRole> {
    match text {
        "admin" => Ok(SystemRole::Admin),
        "member" => Ok(SystemRole::Member),
        other => Err(ApiError::internal(format!("知らないシステム役割: {other}"))),
    }
}

fn system_role_text(role: SystemRole) -> &'static str {
    match role {
        SystemRole::Admin => "admin",
        SystemRole::Member => "member",
    }
}

fn parse_project_role(text: &str) -> ApiResult<ProjectRole> {
    match text {
        "owner" => Ok(ProjectRole::Owner),
        "editor" => Ok(ProjectRole::Editor),
        "viewer" => Ok(ProjectRole::Viewer),
        other => Err(ApiError::internal(format!("知らない役割: {other}"))),
    }
}

fn project_role_text(role: ProjectRole) -> &'static str {
    match role {
        ProjectRole::Owner => "owner",
        ProjectRole::Editor => "editor",
        ProjectRole::Viewer => "viewer",
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> ApiResult<String> {
    serde_json::to_string(value).map_err(|e| ApiError::internal(format!("JSON に書けません: {e}")))
}

fn from_json<T: serde::de::DeserializeOwned>(text: &str) -> ApiResult<T> {
    serde_json::from_str(text).map_err(|e| ApiError::internal(format!("JSON を読めません: {e}")))
}

/// プロジェクトの見出しを引く列。`document` は重いので含めない。
const META_COLUMNS: &str =
    "id, name, created_at, updated_at, group_id, due_date, status, task_count, member_count";

/// SQL の後ろにある保存先。[`Sql`] を差し替えれば SQLite にも PostgreSQL にもなる。
///
/// 接続を `Mutex` に入れてあるのは、`Store` の読み取りが `&self` なのに対し、
/// どちらのドライバも文を流すのに可変の参照を要るため。サーバは外側でも
/// 読み書きのロックを取るので、ここでの待ちはまず起きない。
pub struct SqlStore<C: Sql> {
    sql: Mutex<C>,
}

impl<C: Sql> SqlStore<C> {
    /// 表を用意してから開く。すでにあるものには触らない。
    pub fn open(mut sql: C) -> ApiResult<Self> {
        schema::migrate(&mut sql)?;
        Ok(Self {
            sql: Mutex::new(sql),
        })
    }

    /// 接続を borrow する。
    ///
    /// 毒された錠は**開ける**。落ちた 1 リクエストのために、以後すべての
    /// 呼び出しを失敗させるほうが害が大きい。壊れているのは SQL の外にある
    /// 一時的な値だけで、保存先の一貫性は DB 自身が守っている。
    pub fn sql(&self) -> MutexGuard<'_, C> {
        self.sql
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn label(&self) -> String {
        self.sql().label()
    }

    /* ===== 権限の行 ===== */

    fn load_access(&self, table: &str, key: &str, id: &str) -> ApiResult<Vec<AccessEntry>> {
        let sql = format!(
            "SELECT principal_kind, principal_id, role FROM {table} \
             WHERE {key} = ? ORDER BY principal_kind, principal_id"
        );
        let rows = self.sql().query(&sql, &[Value::text(id)])?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut read = Reader::new(row);
            let kind = read.text()?;
            let principal_id = read.text()?;
            let role = parse_project_role(&read.text()?)?;
            let principal = Principal::parse(&kind, &principal_id).ok_or_else(|| {
                ApiError::internal(format!("知らない権限の相手: {kind}/{principal_id}"))
            })?;
            out.push(AccessEntry::new(principal, role));
        }
        Ok(out)
    }

    fn save_access(
        &self,
        table: &str,
        key: &str,
        id: &str,
        access: &[AccessEntry],
    ) -> ApiResult<()> {
        self.sql().execute(
            &format!("DELETE FROM {table} WHERE {key} = ?"),
            &[Value::text(id)],
        )?;
        let insert = format!(
            "INSERT INTO {table} ({key}, principal_kind, principal_id, role) VALUES (?, ?, ?, ?)"
        );
        for entry in access {
            self.sql().execute(
                &insert,
                &[
                    Value::text(id),
                    Value::text(entry.principal.kind()),
                    Value::text(entry.principal.id()),
                    Value::text(project_role_text(entry.role)),
                ],
            )?;
        }
        Ok(())
    }

    /* ===== プロジェクトの見出し ===== */

    fn read_meta(&self, row: &Row) -> ApiResult<ProjectMeta> {
        let mut read = Reader::new(row);
        let id = read.text()?;
        let name = read.text()?;
        let created_at = read.text()?;
        let updated_at = read.text()?;
        let group_id = read.opt_text()?;
        let due_date = read.opt_text()?;
        let status = read.opt_text()?;
        let task_count = read.text()?;
        let member_count = read.text()?;
        let access = self.load_access("project_access", "project_id", &id)?;
        Ok(ProjectMeta {
            id: ProjectId::new(id),
            name,
            created_at,
            updated_at,
            group_id: group_id.map(ProjectGroupId::new),
            due_date,
            access,
            status: match status {
                Some(text) => Some(from_json::<ProjectStatus>(&text)?),
                None => None,
            },
            task_count: task_count.parse().unwrap_or(0),
            member_count: member_count.parse().unwrap_or(0),
        })
    }
}

/// `Store` は借りた形に対して実装する。
///
/// 書き込みの排他は外側の `RwLock` が持っていて、`&mut` が持つ必要はない。
/// 共有参照に対して実装しておくと、読み取りロックからも書き込みロックからも
/// 同じ 1 つの実装が使える (`&*guard` で足りる)。
impl<C: Sql> Store for &SqlStore<C> {
    /* ===== アカウント ===== */

    fn users(&self) -> ApiResult<Vec<User>> {
        let rows = self.sql().query(
            "SELECT id, name, email, system_role, created_at FROM users ORDER BY name, id",
            &[],
        )?;
        rows.iter().map(read_user).collect()
    }

    fn user(&self, id: &UserId) -> ApiResult<Option<User>> {
        let rows = self.sql().query(
            "SELECT id, name, email, system_role, created_at FROM users WHERE id = ?",
            &[Value::text(id.as_str())],
        )?;
        rows.first().map(read_user).transpose()
    }

    fn put_user(&mut self, user: User) -> ApiResult<()> {
        self.sql().execute(
            "DELETE FROM users WHERE id = ?",
            &[Value::text(user.id.as_str())],
        )?;
        self.sql().execute(
            "INSERT INTO users (id, name, email, system_role, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::text(user.id.as_str()),
                Value::text(&user.name),
                Value::opt_text(user.email.as_deref()),
                Value::text(system_role_text(user.system_role)),
                Value::text(&user.created_at),
            ],
        )
    }

    fn remove_user(&mut self, id: &UserId) -> ApiResult<bool> {
        if self.user(id)?.is_none() {
            return Ok(false);
        }
        let key = Value::text(id.as_str());
        // 宙に浮いた権限とメンバーシップを残さない。`MemoryStore` と同じ後始末。
        self.sql().execute(
            "DELETE FROM project_access WHERE principal_kind = 'user' AND principal_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "DELETE FROM project_group_access WHERE principal_kind = 'user' AND principal_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "DELETE FROM user_group_members WHERE user_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql()
            .execute("DELETE FROM users WHERE id = ?", &[key])?;
        Ok(true)
    }

    /* ===== アカウントのグループ ===== */

    fn user_groups(&self) -> ApiResult<Vec<UserGroup>> {
        let rows = self
            .sql()
            .query("SELECT id FROM user_groups ORDER BY name, id", &[])?;
        let ids = rows
            .iter()
            .map(|row| Reader::new(row).text())
            .collect::<ApiResult<Vec<_>>>()?;
        ids.iter()
            .map(|id| {
                self.user_group(&UserGroupId::new(id.clone()))?
                    .ok_or_else(|| ApiError::internal("グループが途中で消えました"))
            })
            .collect()
    }

    fn user_group(&self, id: &UserGroupId) -> ApiResult<Option<UserGroup>> {
        let mut sql = self.sql();
        let rows = sql.query(
            "SELECT id, name, created_at FROM user_groups WHERE id = ?",
            &[Value::text(id.as_str())],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let mut read = Reader::new(row);
        let group_id = read.text()?;
        let name = read.text()?;
        let created_at = read.text()?;
        let members = sql.query(
            "SELECT user_id FROM user_group_members WHERE group_id = ? ORDER BY user_id",
            &[Value::text(&group_id)],
        )?;
        Ok(Some(UserGroup {
            id: UserGroupId::new(group_id),
            name,
            members: members
                .iter()
                .map(|row| Ok(UserId::new(Reader::new(row).text()?)))
                .collect::<ApiResult<Vec<_>>>()?,
            created_at,
        }))
    }

    fn put_user_group(&mut self, group: UserGroup) -> ApiResult<()> {
        let key = Value::text(group.id.as_str());
        self.sql().execute(
            "DELETE FROM user_groups WHERE id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "DELETE FROM user_group_members WHERE group_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "INSERT INTO user_groups (id, name, created_at) VALUES (?, ?, ?)",
            &[
                key.clone(),
                Value::text(&group.name),
                Value::text(&group.created_at),
            ],
        )?;
        for member in &group.members {
            self.sql().execute(
                "INSERT INTO user_group_members (group_id, user_id) VALUES (?, ?)",
                &[key.clone(), Value::text(member.as_str())],
            )?;
        }
        Ok(())
    }

    fn remove_user_group(&mut self, id: &UserGroupId) -> ApiResult<bool> {
        if self.user_group(id)?.is_none() {
            return Ok(false);
        }
        let key = Value::text(id.as_str());
        self.sql().execute(
            "DELETE FROM project_access WHERE principal_kind = 'group' AND principal_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "DELETE FROM project_group_access WHERE principal_kind = 'group' AND principal_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "DELETE FROM user_group_members WHERE group_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql()
            .execute("DELETE FROM user_groups WHERE id = ?", &[key])?;
        Ok(true)
    }

    /* ===== プロジェクトのグループ ===== */

    fn project_groups(&self) -> ApiResult<Vec<ProjectGroup>> {
        let rows = self
            .sql()
            .query("SELECT id FROM project_groups ORDER BY name, id", &[])?;
        let ids = rows
            .iter()
            .map(|row| Reader::new(row).text())
            .collect::<ApiResult<Vec<_>>>()?;
        ids.iter()
            .map(|id| {
                self.project_group(&ProjectGroupId::new(id.clone()))?
                    .ok_or_else(|| ApiError::internal("グループが途中で消えました"))
            })
            .collect()
    }

    fn project_group(&self, id: &ProjectGroupId) -> ApiResult<Option<ProjectGroup>> {
        let rows = self.sql().query(
            "SELECT id, name, created_at FROM project_groups WHERE id = ?",
            &[Value::text(id.as_str())],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let mut read = Reader::new(row);
        let group_id = read.text()?;
        let name = read.text()?;
        let created_at = read.text()?;
        let access = self.load_access("project_group_access", "group_id", &group_id)?;
        Ok(Some(ProjectGroup {
            id: ProjectGroupId::new(group_id),
            name,
            access,
            created_at,
        }))
    }

    fn put_project_group(&mut self, group: ProjectGroup) -> ApiResult<()> {
        let key = Value::text(group.id.as_str());
        self.sql().execute(
            "DELETE FROM project_groups WHERE id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "INSERT INTO project_groups (id, name, created_at) VALUES (?, ?, ?)",
            &[
                key,
                Value::text(&group.name),
                Value::text(&group.created_at),
            ],
        )?;
        self.save_access(
            "project_group_access",
            "group_id",
            group.id.as_str(),
            &group.access,
        )
    }

    fn remove_project_group(&mut self, id: &ProjectGroupId) -> ApiResult<bool> {
        if self.project_group(id)?.is_none() {
            return Ok(false);
        }
        let key = Value::text(id.as_str());
        // 配下のプロジェクトは消さない。所属だけ外す。
        self.sql().execute(
            "UPDATE projects SET group_id = NULL WHERE group_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "DELETE FROM project_group_access WHERE group_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql()
            .execute("DELETE FROM project_groups WHERE id = ?", &[key])?;
        Ok(true)
    }

    /* ===== プロジェクト ===== */

    fn project_metas(&self) -> ApiResult<Vec<ProjectMeta>> {
        let rows = self.sql().query(
            &format!(
                "SELECT {} FROM projects ORDER BY updated_at DESC, id",
                META_COLUMNS
            ),
            &[],
        )?;
        rows.iter().map(|row| self.read_meta(row)).collect()
    }

    fn project(&self, id: &ProjectId) -> ApiResult<Option<Project>> {
        let rows = self.sql().query(
            &format!(
                "SELECT {}, document FROM projects WHERE id = ?",
                META_COLUMNS
            ),
            &[Value::text(id.as_str())],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let meta = self.read_meta(row)?;
        let document = match row.last() {
            Some(Value::Text(text)) => from_json::<Document>(text)?,
            _ => return Err(ApiError::internal("document の列が読めません")),
        };
        Ok(Some(Project { meta, document }))
    }

    fn put_project(&mut self, project: Project) -> ApiResult<()> {
        let meta = &project.meta;
        let key = Value::text(meta.id.as_str());
        let status = match &meta.status {
            Some(status) => Value::Text(to_json(status)?),
            None => Value::Null,
        };
        self.sql().execute(
            "DELETE FROM projects WHERE id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "INSERT INTO projects \
             (id, name, created_at, updated_at, group_id, due_date, status, \
              task_count, member_count, document) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                key,
                Value::text(&meta.name),
                Value::text(&meta.created_at),
                Value::text(&meta.updated_at),
                Value::opt_text(meta.group_id.as_ref().map(ProjectGroupId::as_str)),
                Value::opt_text(meta.due_date.as_deref()),
                status,
                // 件数は文字列で持つ。整数の幅がドライバごとに違っても揺れない。
                Value::text(meta.task_count.to_string()),
                Value::text(meta.member_count.to_string()),
                Value::Text(to_json(&project.document)?),
            ],
        )?;
        self.save_access(
            "project_access",
            "project_id",
            meta.id.as_str(),
            &meta.access,
        )
    }

    fn remove_project(&mut self, id: &ProjectId) -> ApiResult<bool> {
        if self.project(id)?.is_none() {
            return Ok(false);
        }
        let key = Value::text(id.as_str());
        self.sql().execute(
            "DELETE FROM project_access WHERE project_id = ?",
            std::slice::from_ref(&key),
        )?;
        // 行き先の無いコメントと添付を残さない。添付を先に消す
        // (コメントが消えたあとでは、どれを消せばよいか引けない)。
        self.sql().execute(
            "DELETE FROM attachments WHERE comment_id IN \
             (SELECT id FROM comments WHERE project_id = ?)",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "DELETE FROM comments WHERE project_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql()
            .execute("DELETE FROM projects WHERE id = ?", &[key])?;
        Ok(true)
    }

    /* ===== コメント ===== */

    fn comments(&self, project: &ProjectId) -> ApiResult<Vec<Comment>> {
        let rows = self.sql().query(
            &format!(
                "SELECT {COMMENT_COLUMNS} FROM comments WHERE project_id = ? \
                 ORDER BY created_at, id"
            ),
            &[Value::text(project.as_str())],
        )?;
        let mut comments: Vec<Comment> = rows.iter().map(read_comment).collect::<ApiResult<_>>()?;
        // 添付はプロジェクトぶんをまとめて 1 回で引く。コメントごとに
        // 問い合わせると、一覧を開くだけで件数ぶんの往復になる。
        let mut by_comment = self.attachments_of_project(project)?;
        for comment in &mut comments {
            comment.attachments = by_comment.remove(comment.id.as_str()).unwrap_or_default();
        }
        Ok(comments)
    }

    fn comment(&self, id: &CommentId) -> ApiResult<Option<Comment>> {
        let rows = self.sql().query(
            &format!("SELECT {COMMENT_COLUMNS} FROM comments WHERE id = ?"),
            &[Value::text(id.as_str())],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let mut comment = read_comment(row)?;
        comment.attachments = self.attachments_of(id)?;
        Ok(Some(comment))
    }

    fn put_comment(&mut self, comment: Comment) -> ApiResult<()> {
        let key = Value::text(comment.id.as_str());
        self.sql().execute(
            "DELETE FROM comments WHERE id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql().execute(
            "INSERT INTO comments \
             (id, project_id, task_id, author, body, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                key,
                Value::text(comment.project_id.as_str()),
                Value::opt_text(comment.task_id.as_deref()),
                Value::text(comment.author.as_str()),
                Value::text(&comment.body),
                Value::text(&comment.created_at),
                Value::opt_text(comment.updated_at.as_deref()),
            ],
        )?;
        // 添付は毎回まるごと置き換える。`edit_comment` が送られた一覧を
        // そのまま新しい一覧とするので、差分を取る意味が無い。
        self.replace_attachments(&comment.id, &comment.attachments)
    }

    fn remove_comment(&mut self, id: &CommentId) -> ApiResult<bool> {
        if self.comment(id)?.is_none() {
            return Ok(false);
        }
        let key = Value::text(id.as_str());
        self.sql().execute(
            "DELETE FROM attachments WHERE comment_id = ?",
            std::slice::from_ref(&key),
        )?;
        self.sql()
            .execute("DELETE FROM comments WHERE id = ?", &[key])?;
        Ok(true)
    }
}

impl<C: Sql> SqlStore<C> {
    fn attachments_of(&self, id: &CommentId) -> ApiResult<Vec<Attachment>> {
        let rows = self.sql().query(
            &format!(
                "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE comment_id = ? \
                 ORDER BY position"
            ),
            &[Value::text(id.as_str())],
        )?;
        rows.iter().map(read_attachment).collect()
    }

    fn attachments_of_project(
        &self,
        project: &ProjectId,
    ) -> ApiResult<BTreeMap<String, Vec<Attachment>>> {
        let rows = self.sql().query(
            &format!(
                "SELECT comment_id, {ATTACHMENT_COLUMNS} FROM attachments \
                 WHERE comment_id IN (SELECT id FROM comments WHERE project_id = ?) \
                 ORDER BY comment_id, position"
            ),
            &[Value::text(project.as_str())],
        )?;
        let mut grouped: BTreeMap<String, Vec<Attachment>> = BTreeMap::new();
        for row in &rows {
            let comment_id = match row.first() {
                Some(Value::Text(text)) => text.clone(),
                _ => return Err(ApiError::internal("添付の comment_id が読めません")),
            };
            grouped
                .entry(comment_id)
                .or_default()
                .push(read_attachment(&row[1..].to_vec())?);
        }
        Ok(grouped)
    }

    fn replace_attachments(&self, id: &CommentId, attachments: &[Attachment]) -> ApiResult<()> {
        self.sql().execute(
            "DELETE FROM attachments WHERE comment_id = ?",
            &[Value::text(id.as_str())],
        )?;
        for (position, attachment) in attachments.iter().enumerate() {
            self.sql().execute(
                "INSERT INTO attachments \
                 (id, comment_id, position, filename, mime, size, data) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                &[
                    Value::text(&attachment.id),
                    Value::text(id.as_str()),
                    Value::Int(position as i64),
                    Value::text(&attachment.filename),
                    Value::text(&attachment.mime),
                    Value::Int(attachment.size as i64),
                    Value::text(&attachment.data),
                ],
            )?;
        }
        Ok(())
    }
}

const COMMENT_COLUMNS: &str = "id, project_id, task_id, author, body, created_at, updated_at";

fn read_comment(row: &Row) -> ApiResult<Comment> {
    let mut read = Reader::new(row);
    Ok(Comment {
        id: CommentId::new(read.text()?),
        project_id: ProjectId::new(read.text()?),
        task_id: read.opt_text()?,
        author: UserId::new(read.text()?),
        body: read.text()?,
        created_at: read.text()?,
        updated_at: read.opt_text()?,
        // 添付は別の表なので、呼び出し側が埋める。
        attachments: Vec::new(),
    })
}

const ATTACHMENT_COLUMNS: &str = "id, filename, mime, size, data";

fn read_attachment(row: &Row) -> ApiResult<Attachment> {
    let mut read = Reader::new(row);
    Ok(Attachment {
        id: read.text()?,
        filename: read.text()?,
        mime: read.text()?,
        size: read.int()?.max(0) as u64,
        data: read.text()?,
    })
}

fn read_user(row: &Row) -> ApiResult<User> {
    let mut read = Reader::new(row);
    Ok(User {
        id: UserId::new(read.text()?),
        name: read.text()?,
        email: read.opt_text()?,
        system_role: parse_system_role(&read.text()?)?,
        created_at: read.text()?,
    })
}
