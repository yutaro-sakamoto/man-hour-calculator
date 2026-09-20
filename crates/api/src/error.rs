//! API が返す失敗。
//!
//! HTTP のステータスコードに素直に写せる粒度にしてある。ローカルで動いていても
//! 同じ `code` が返るので、画面側の扱いはどちらでも変わらない。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// 呼び出し元が特定できない。
    Unauthorized,
    /// 権限が足りない。
    Forbidden,
    /// 対象が無い。
    NotFound,
    /// 入力が不正。
    Invalid,
    /// すでに存在する、または状態が合わない。
    Conflict,
}

impl ErrorCode {
    /// 対応する HTTP ステータス。
    pub fn http_status(self) -> u16 {
        match self {
            Self::Unauthorized => 401,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::Invalid => 422,
            Self::Conflict => 409,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unauthorized, message)
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Forbidden, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    pub fn http_status(&self) -> u16 {
        self.code.http_status()
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_map_to_http_statuses() {
        assert_eq!(ErrorCode::Unauthorized.http_status(), 401);
        assert_eq!(ErrorCode::Forbidden.http_status(), 403);
        assert_eq!(ErrorCode::NotFound.http_status(), 404);
        assert_eq!(ErrorCode::Invalid.http_status(), 422);
        assert_eq!(ErrorCode::Conflict.http_status(), 409);
    }

    #[test]
    fn errors_round_trip_as_json() {
        let error = ApiError::forbidden("読み取り権限がありません");
        let text = serde_json::to_string(&error).unwrap();
        assert!(text.contains("\"forbidden\""));
        assert_eq!(serde_json::from_str::<ApiError>(&text).unwrap(), error);
    }
}
