//! 起動時の設定。
//!
//! 既定のまま `mhc-server` と打てば動くことを大事にしている。
//! 置き場所は `./mhc.db`、待ち受けは `127.0.0.1:8080`、認証はトークン。
//! 外に出すときだけ `--listen` と、必要なら `--auth` を触る。

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Parser, Debug)]
#[command(
    name = "mhc-server",
    version,
    about = "工数見積もりのサーバ",
    long_about = "工数見積もりのサーバ。単体のバイナリで動き、\
                  画面 (HTML) も同じバイナリから配る。"
)]
pub struct Cli {
    /// 保存先。`sqlite:<path>` または `postgres://…`。
    #[arg(long, default_value = "sqlite:mhc.db", global = true)]
    pub db: String,

    /// 待ち受けるアドレス。
    #[arg(long, default_value = "127.0.0.1:8080")]
    pub listen: SocketAddr,

    /// 呼び出し元の特定のしかた。
    #[arg(long, value_enum, default_value_t = AuthKind::Token)]
    pub auth: AuthKind,

    /// `--auth header` のときに見るヘッダ名。
    #[arg(long, default_value = "X-Forwarded-User")]
    pub auth_header: String,

    /// `--auth none` のときに名乗るアカウント。
    #[arg(long)]
    pub auth_user: Option<String>,

    /// 配る画面の HTML。省略すると、埋め込んであるものを返す。
    #[arg(long)]
    pub ui: Option<PathBuf>,

    /// 最初に作る管理者の id。
    #[arg(long, default_value = "admin")]
    pub admin_id: String,

    /// 最初に作る管理者の表示名。
    #[arg(long, default_value = "管理者")]
    pub admin_name: String,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// API トークンを扱う。
    #[command(subcommand)]
    Token(TokenCommand),
}

#[derive(Subcommand, Debug)]
pub enum TokenCommand {
    /// 発行する。平文はこのときにしか出ない。
    Create {
        /// 誰のトークンか。
        #[arg(long)]
        user: String,
        /// 覚え書き (「佐藤のノート PC」など)。
        #[arg(long, default_value = "")]
        label: String,
    },
    /// 一覧する (ハッシュしか保存していないので、平文は出ない)。
    List,
    /// 失効させる。
    Revoke {
        /// `token list` に出る id。
        id: String,
    },
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum AuthKind {
    /// `Authorization: Bearer <トークン>` を見る。
    Token,
    /// 信頼するヘッダに入っているアカウント id を使う (SSO の前段がある場合)。
    Header,
    /// 誰でも通す。手元で試すとき専用。
    None,
}

/// 保存先の指定を読み解いたもの。
#[derive(Debug, Clone, PartialEq)]
pub enum Backend {
    Sqlite(PathBuf),
    Postgres(String),
}

/// `--db` の文字列を読み解く。
///
/// `sqlite:` を省いた素のパスも受け付ける。うっかり `./mhc.db` と
/// 打ったときに「知らない保存先です」と言われるのは不親切なので。
pub fn parse_backend(value: &str) -> Result<Backend, String> {
    if let Some(rest) = value.strip_prefix("sqlite://") {
        return Ok(Backend::Sqlite(PathBuf::from(rest)));
    }
    if let Some(rest) = value.strip_prefix("sqlite:") {
        return Ok(Backend::Sqlite(PathBuf::from(rest)));
    }
    if value.starts_with("postgres://") || value.starts_with("postgresql://") {
        return Ok(Backend::Postgres(value.to_string()));
    }
    if value.contains("://") {
        return Err(format!(
            "知らない保存先です: {value} (使えるのは sqlite: と postgres:// )"
        ));
    }
    Ok(Backend::Sqlite(PathBuf::from(value)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_backend_can_be_written_several_ways() {
        let db = PathBuf::from("mhc.db");
        for value in ["sqlite:mhc.db", "sqlite://mhc.db", "mhc.db"] {
            assert_eq!(
                parse_backend(value),
                Ok(Backend::Sqlite(db.clone())),
                "{value}"
            );
        }
        assert_eq!(
            parse_backend("postgres://u@h/d"),
            Ok(Backend::Postgres("postgres://u@h/d".into()))
        );
        assert!(parse_backend("mysql://h/d").is_err());
    }

    #[test]
    fn the_defaults_need_no_arguments() {
        let cli = Cli::parse_from(["mhc-server"]);
        assert_eq!(cli.db, "sqlite:mhc.db");
        assert_eq!(cli.auth, AuthKind::Token);
        assert_eq!(cli.listen.port(), 8080);
        assert!(cli.listen.ip().is_loopback(), "既定では外に出さない");
    }
}
