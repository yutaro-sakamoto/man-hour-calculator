//! SQLite のドライバ。
//!
//! `rusqlite` を `bundled` で使うので、**SQLite 本体もバイナリに入る**。
//! 配るのが 1 ファイルで済み、置いた先に何も入れなくてよい。

use std::path::Path;

use mhc_api::error::{ApiError, ApiResult};
use rusqlite::types::ValueRef;
use rusqlite::Connection;

use super::{Row, Sql, Value};

pub struct SqliteConn {
    conn: Connection,
    label: String,
}

impl SqliteConn {
    /// ファイルを開く (無ければ作る)。
    pub fn open(path: &Path) -> ApiResult<Self> {
        let conn = Connection::open(path).map_err(|e| {
            ApiError::internal(format!("SQLite を開けません ({}): {e}", path.display()))
        })?;
        Self::configure(conn, path.display().to_string())
    }

    /// 消える保存先。テストで使う。
    pub fn in_memory() -> ApiResult<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| ApiError::internal(format!("SQLite を開けません: {e}")))?;
        Self::configure(conn, "sqlite (メモリ上)".into())
    }

    fn configure(conn: Connection, label: String) -> ApiResult<Self> {
        // WAL は読み手が書き手を待たない。外部キーは入れておくが、
        // 参照の後始末は `Store` 側でも明示的に行っている。
        for pragma in ["PRAGMA journal_mode = WAL", "PRAGMA foreign_keys = ON"] {
            conn.execute_batch(pragma)
                .map_err(|e| ApiError::internal(format!("SQLite の設定に失敗: {e}")))?;
        }
        Ok(Self { conn, label })
    }
}

/// 穴埋めの値を rusqlite に渡せる形にする。
fn bind(params: &[Value]) -> Vec<Box<dyn rusqlite::ToSql>> {
    params
        .iter()
        .map(|value| -> Box<dyn rusqlite::ToSql> {
            match value {
                Value::Null => Box::new(Option::<String>::None),
                Value::Int(number) => Box::new(*number),
                Value::Text(text) => Box::new(text.clone()),
            }
        })
        .collect()
}

fn read(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::Int(number),
        // 実数と BLOB は使っていないが、読めたものは落とさず文字にする。
        ValueRef::Real(number) => Value::Text(number.to_string()),
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
            Value::Text(String::from_utf8_lossy(bytes).into_owned())
        }
    }
}

impl Sql for SqliteConn {
    fn execute(&mut self, sql: &str, params: &[Value]) -> ApiResult<()> {
        let bound = bind(params);
        let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(AsRef::as_ref).collect();
        self.conn
            .execute(sql, refs.as_slice())
            .map(|_| ())
            .map_err(|e| ApiError::internal(format!("SQL に失敗しました: {e} ({sql})")))
    }

    fn query(&mut self, sql: &str, params: &[Value]) -> ApiResult<Vec<Row>> {
        let bound = bind(params);
        let refs: Vec<&dyn rusqlite::ToSql> = bound.iter().map(AsRef::as_ref).collect();
        let mut statement = self
            .conn
            .prepare(sql)
            .map_err(|e| ApiError::internal(format!("SQL を用意できません: {e} ({sql})")))?;
        let columns = statement.column_count();
        let mut rows = statement
            .query(refs.as_slice())
            .map_err(|e| ApiError::internal(format!("SQL に失敗しました: {e} ({sql})")))?;

        let mut out = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|e| ApiError::internal(format!("行を読めません: {e}")))?
        {
            let mut values = Vec::with_capacity(columns);
            for index in 0..columns {
                let raw = row
                    .get_ref(index)
                    .map_err(|e| ApiError::internal(format!("列を読めません: {e}")))?;
                values.push(read(raw));
            }
            out.push(values);
        }
        Ok(out)
    }

    fn label(&self) -> String {
        format!("sqlite:{}", self.label)
    }
}
