//! 工数見積もりのサーバ。
//!
//! やることは**データの置き場所と、呼び出し元の特定**だけ。権限の判定も
//! 不変条件も `crates/api` の [`Service`](mhc_api::service::Service) にあり、
//! ここには書かない。ローカル (WASM) から呼んでもサーバ経由で呼んでも
//! 同じ実装を通るので、振る舞いが食い違うことがない。
//!
//! 見積もりの計算もここには無い。計算はクライアントの WASM がその場で回す。
//!
//! ```text
//!   HTTP  →  http.rs (ルート → Request)
//!                 ↓
//!         mhc_api::protocol::dispatch
//!                 ↓
//!         mhc_api::service::Service
//!                 ↓
//!            store::Store
//!          ┌──────┴──────┐
//!       SQLite        PostgreSQL
//! ```

#![forbid(unsafe_code)]

pub mod auth;
pub mod clock;
pub mod config;
pub mod http;
pub mod store;

/// 埋め込んである画面 (`dist/index.html`)。
///
/// `build.rs` がビルド時に取り込む。作っていなければ、作り方を書いた
/// 案内ページが入る。**配るのはこのバイナリ 1 つで済む。**
pub const EMBEDDED_UI: &str = include_str!(concat!(env!("OUT_DIR"), "/ui.html"));
