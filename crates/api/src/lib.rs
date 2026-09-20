//! クライアントとサーバが共有する API の定義。
//!
//! このクレートには I/O が無い。HTTP も、データベースも、時計も、乱数も持たない。
//! あるのは「どんなデータがあり」「誰が何をしてよく」「操作の結果どうなるか」
//! だけで、それを
//!
//! - **ローカル** … WASM に載せてブラウザのなかで呼ぶ
//! - **サーバ** … HTTP のハンドラから呼ぶ
//!
//! の両方から使う。権限の判定が 1 か所にしかないので、
//! 「画面では隠していたがサーバでは通ってしまう」といった食い違いが起きない。
//!
//! HTTP に載せたときの対応は `docs/API.md` と `docs/openapi.yaml` を参照。

pub mod error;
pub mod health;
pub mod model;
pub mod permission;
pub mod protocol;
pub mod service;
pub mod store;

pub use error::{ApiError, ApiResult, ErrorCode};
pub use health::{health, ProjectHealth};
pub use model::{
    AccessEntry, Comment, CommentId, Document, Principal, Project, ProjectGroup, ProjectGroupId,
    ProjectId, ProjectMeta, ProjectRole, ProjectStatus, ProjectSummary, SystemRole, User,
    UserGroup, UserGroupId, UserId,
};
pub use permission::{Actor, Permission};
pub use service::Service;
pub use store::{MemoryStore, Store, STORE_VERSION};

/// この API のバージョン。HTTP では `/v1` として現れる。
pub const API_VERSION: &str = "1";
