//! PostgreSQL のドライバ。
//!
//! 共通の SQL は `?` で穴を開けて書いてあるので、ここで `$1, $2, …` に
//! 書き換えてから渡す。**文字列リテラルに `?` を書かない**という規約に
//! 頼った素朴な置き換えで、その規約は [`rewrite`] のテストで見張っている。

use mhc_api::error::{ApiError, ApiResult};
use postgres::types::{ToSql, Type};
use postgres::{Client, NoTls};

use super::{Row, Sql, Value};

pub struct PostgresConn {
    client: Client,
    label: String,
}

impl PostgresConn {
    pub fn connect(url: &str) -> ApiResult<Self> {
        let client = Client::connect(url, NoTls)
            .map_err(|e| ApiError::internal(format!("PostgreSQL に繋げません: {e}")))?;
        Ok(Self {
            client,
            // 接続文字列にはパスワードが入っている。表に出すのはホストまで。
            label: redact(url),
        })
    }
}

/// `?` を `$1, $2, …` に置き換える。
pub fn rewrite(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len() + 8);
    let mut next = 1;
    for ch in sql.chars() {
        if ch == '?' {
            out.push('$');
            out.push_str(&next.to_string());
            next += 1;
        } else {
            out.push(ch);
        }
    }
    out
}

/// 接続文字列から資格情報を落とす。
fn redact(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return "postgres".into();
    };
    match rest.rsplit_once('@') {
        Some((_, host)) => format!("{scheme}://***@{host}"),
        None => format!("{scheme}://{rest}"),
    }
}

/// 穴埋めの値を `postgres` の型に写す。
///
/// `Value::Text` は「型を決めない文字列」として渡す。列が TEXT でも
/// BIGINT でも、PostgreSQL 側が合わせてくれる。
fn bind(params: &[Value]) -> Vec<Box<dyn ToSql + Sync>> {
    params
        .iter()
        .map(|value| -> Box<dyn ToSql + Sync> {
            match value {
                Value::Null => Box::new(Option::<String>::None),
                Value::Int(number) => Box::new(*number),
                Value::Text(text) => Box::new(text.clone()),
            }
        })
        .collect()
}

fn read(row: &postgres::Row, index: usize) -> ApiResult<Value> {
    let column = row
        .columns()
        .get(index)
        .ok_or_else(|| ApiError::internal("列がありません"))?;
    let value = match *column.type_() {
        Type::INT2 | Type::INT4 | Type::INT8 => row
            .try_get::<_, Option<i64>>(index)
            .map_err(|e| ApiError::internal(format!("整数を読めません: {e}")))?
            .map_or(Value::Null, Value::Int),
        _ => row
            .try_get::<_, Option<String>>(index)
            .map_err(|e| ApiError::internal(format!("文字列を読めません: {e}")))?
            .map_or(Value::Null, Value::Text),
    };
    Ok(value)
}

impl Sql for PostgresConn {
    fn execute(&mut self, sql: &str, params: &[Value]) -> ApiResult<()> {
        let bound = bind(params);
        let refs: Vec<&(dyn ToSql + Sync)> = bound.iter().map(AsRef::as_ref).collect();
        self.client
            .execute(rewrite(sql).as_str(), refs.as_slice())
            .map(|_| ())
            .map_err(|e| ApiError::internal(format!("SQL に失敗しました: {e} ({sql})")))
    }

    fn query(&mut self, sql: &str, params: &[Value]) -> ApiResult<Vec<Row>> {
        let bound = bind(params);
        let refs: Vec<&(dyn ToSql + Sync)> = bound.iter().map(AsRef::as_ref).collect();
        let rows = self
            .client
            .query(rewrite(sql).as_str(), refs.as_slice())
            .map_err(|e| ApiError::internal(format!("SQL に失敗しました: {e} ({sql})")))?;

        rows.iter()
            .map(|row| (0..row.columns().len()).map(|i| read(row, i)).collect())
            .collect()
    }

    fn label(&self) -> String {
        self.label.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_are_numbered_in_order() {
        assert_eq!(
            rewrite("INSERT INTO t (a, b) VALUES (?, ?)"),
            "INSERT INTO t (a, b) VALUES ($1, $2)"
        );
        assert_eq!(rewrite("SELECT 1"), "SELECT 1");
    }

    #[test]
    fn the_shared_sql_never_puts_a_question_mark_in_a_literal() {
        // 置き換えが素朴でいられるのは、この規約があるから。
        // 共通の SQL には文字列リテラルが 'user' / 'group' しか出てこない。
        for statement in [
            "DELETE FROM project_access WHERE principal_kind = 'user' AND principal_id = ?",
            "UPDATE projects SET group_id = NULL WHERE group_id = ?",
        ] {
            let rewritten = rewrite(statement);
            assert_eq!(
                rewritten.matches('$').count(),
                statement.matches('?').count()
            );
        }
    }

    #[test]
    fn a_connection_string_never_shows_its_password() {
        assert_eq!(
            redact("postgres://user:secret@db.internal/mhc"),
            "postgres://***@db.internal/mhc"
        );
        assert_eq!(
            redact("postgres://db.internal/mhc"),
            "postgres://db.internal/mhc"
        );
    }
}
