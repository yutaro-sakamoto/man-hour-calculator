//! 呼び出し元を特定する。
//!
//! 暗号に触るのはこのファイルだけで、`crates/api` には持ち込まない。
//! `crates/api` は「`actor` は既に特定されている」という前提で書かれており、
//! ローカル (WASM) では持ち主が自明なので、そこに認証の仕組みは要らない。
//!
//! # 保存するもの
//!
//! トークンは**平文を保存しない**。発行のときに一度だけ表に出し、
//! 保存するのは SHA-256 のハッシュ。漏れた保存先からトークンは戻せない。
//! 256 ビットの乱数なので、総当たりも辞書も効かない。

use mhc_api::error::{ApiError, ApiResult};
use mhc_api::model::UserId;
use sha2::{Digest, Sha256};

use crate::store::{Sql, Value};

/// 発行したてのトークン。平文が入っているのはここだけ。
#[derive(Debug, Clone)]
pub struct IssuedToken {
    pub id: String,
    pub secret: String,
}

/// 一覧に出す情報。平文は含まない。
#[derive(Debug, Clone)]
pub struct TokenInfo {
    pub id: String,
    pub user_id: String,
    pub label: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

/// 16 進の乱数。`bytes` バイトぶん。
fn random_hex(bytes: usize) -> ApiResult<String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer)
        .map_err(|e| ApiError::internal(format!("乱数を取れません: {e}")))?;
    Ok(to_hex(&buffer))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 保存するのはこれ。平文からは一方向。
pub fn fingerprint(secret: &str) -> String {
    to_hex(&Sha256::digest(secret.as_bytes()))
}

/// 発行する。返ってきた平文を控えられるのはこの一度きり。
pub fn create(sql: &mut dyn Sql, user_id: &str, label: &str, now: &str) -> ApiResult<IssuedToken> {
    let id = random_hex(6)?;
    let secret = random_hex(32)?;
    sql.execute(
        "INSERT INTO api_tokens (id, user_id, hash, label, created_at, last_used_at) \
         VALUES (?, ?, ?, ?, ?, NULL)",
        &[
            Value::text(&id),
            Value::text(user_id),
            Value::text(fingerprint(&secret)),
            Value::text(label),
            Value::text(now),
        ],
    )?;
    Ok(IssuedToken { id, secret })
}

pub fn list(sql: &mut dyn Sql) -> ApiResult<Vec<TokenInfo>> {
    let rows = sql.query(
        "SELECT id, user_id, label, created_at, last_used_at FROM api_tokens \
         ORDER BY user_id, created_at",
        &[],
    )?;
    rows.iter()
        .map(|row| {
            let text = |at: usize| match row.get(at) {
                Some(Value::Text(value)) => Ok(value.clone()),
                _ => Err(ApiError::internal("トークンの行が読めません")),
            };
            Ok(TokenInfo {
                id: text(0)?,
                user_id: text(1)?,
                label: text(2)?,
                created_at: text(3)?,
                last_used_at: text(4).ok(),
            })
        })
        .collect()
}

pub fn revoke(sql: &mut dyn Sql, id: &str) -> ApiResult<bool> {
    let found = !sql
        .query("SELECT id FROM api_tokens WHERE id = ?", &[Value::text(id)])?
        .is_empty();
    if found {
        sql.execute("DELETE FROM api_tokens WHERE id = ?", &[Value::text(id)])?;
    }
    Ok(found)
}

/// トークンの持ち主を引く。見つからなければ `None`。
///
/// ついでに「最後に使った日」を書くが、同じ日ならもう書かない。
/// 読み取りのたびに書き込むのは無駄だし、日付より細かく持っても使い道がない。
pub fn resolve(sql: &mut dyn Sql, secret: &str, today: &str) -> ApiResult<Option<UserId>> {
    let rows = sql.query(
        "SELECT id, user_id, last_used_at FROM api_tokens WHERE hash = ?",
        &[Value::text(fingerprint(secret))],
    )?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let (Some(Value::Text(id)), Some(Value::Text(user_id))) = (row.first(), row.get(1)) else {
        return Err(ApiError::internal("トークンの行が読めません"));
    };
    let user_id = user_id.clone();

    let already = matches!(row.get(2), Some(Value::Text(seen)) if seen == today);
    if !already {
        sql.execute(
            "UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
            &[Value::text(today), Value::text(id)],
        )?;
    }
    Ok(Some(UserId::new(user_id)))
}

/// `Authorization: Bearer <トークン>` からトークンを取り出す。
pub fn bearer(header: Option<&str>) -> Option<&str> {
    let value = header?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty() {
        Some(token.trim())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::sqlite::SqliteConn;
    use crate::store::{schema, SqlStore};

    const NOW: &str = "2026-09-20T10:00:00Z";
    const TODAY: &str = "2026-09-20";

    fn sql() -> SqliteConn {
        let mut conn = SqliteConn::in_memory().unwrap();
        schema::migrate(&mut conn).unwrap();
        conn
    }

    #[test]
    fn a_token_is_only_ever_shown_once() {
        let mut conn = sql();
        let issued = create(&mut conn, "alice", "ノート PC", NOW).unwrap();

        let stored = conn
            .query(
                "SELECT hash FROM api_tokens WHERE id = ?",
                &[Value::text(&issued.id)],
            )
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0][0], Value::text(fingerprint(&issued.secret)));
        assert_ne!(
            stored[0][0],
            Value::text(&issued.secret),
            "平文が保存されている"
        );
    }

    #[test]
    fn a_token_resolves_to_its_owner_and_nothing_else_does() {
        let mut conn = sql();
        let issued = create(&mut conn, "alice", "", NOW).unwrap();

        assert_eq!(
            resolve(&mut conn, &issued.secret, TODAY).unwrap(),
            Some(UserId::new("alice"))
        );
        assert_eq!(resolve(&mut conn, "でたらめ", TODAY).unwrap(), None);
    }

    #[test]
    fn the_last_used_day_is_written_once_a_day() {
        let mut conn = sql();
        let issued = create(&mut conn, "alice", "", NOW).unwrap();

        fn seen(conn: &mut SqliteConn) -> Option<String> {
            list(conn)
                .unwrap()
                .first()
                .and_then(|info| info.last_used_at.clone())
        }

        resolve(&mut conn, &issued.secret, TODAY).unwrap();
        assert_eq!(seen(&mut conn), Some(TODAY.to_string()));

        resolve(&mut conn, &issued.secret, "2026-09-21").unwrap();
        assert_eq!(seen(&mut conn), Some("2026-09-21".to_string()));
    }

    #[test]
    fn revoking_a_token_stops_it_working() {
        let mut conn = sql();
        let issued = create(&mut conn, "alice", "", NOW).unwrap();

        assert!(revoke(&mut conn, &issued.id).unwrap());
        assert!(
            !revoke(&mut conn, &issued.id).unwrap(),
            "2 回目は何も起きない"
        );
        assert_eq!(resolve(&mut conn, &issued.secret, TODAY).unwrap(), None);
    }

    #[test]
    fn two_tokens_never_come_out_the_same() {
        let mut conn = sql();
        let first = create(&mut conn, "alice", "", NOW).unwrap();
        let second = create(&mut conn, "alice", "", NOW).unwrap();
        assert_ne!(first.secret, second.secret);
        assert_ne!(first.id, second.id);
        assert_eq!(first.secret.len(), 64, "32 バイトぶんの 16 進");
    }

    #[test]
    fn only_a_bearer_header_is_accepted() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("bearer  abc ")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(Some("Bearer")), None);
        assert_eq!(bearer(Some("Bearer ")), None);
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn a_store_and_its_tokens_share_one_connection() {
        // 表はどちらも同じ保存先にある (トークンだけ別の場所には置かない)。
        let store = SqlStore::open(SqliteConn::in_memory().unwrap()).unwrap();
        let issued = create(&mut *store.sql(), "alice", "", NOW).unwrap();
        assert_eq!(
            resolve(&mut *store.sql(), &issued.secret, TODAY).unwrap(),
            Some(UserId::new("alice"))
        );
    }
}
