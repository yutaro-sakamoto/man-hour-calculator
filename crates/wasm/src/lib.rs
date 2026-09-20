//! Rust のロジックを WebAssembly から呼び出すための薄い FFI 層。
//!
//! このクレートだけが `unsafe` を使う。中身のロジックは
//! `#![forbid(unsafe_code)]` な [`mhc_core`] と [`mhc_api`] にあり、
//! ここは「線形メモリ上のバッファを Rust のスライスに読み替える」だけを担当する。
//!
//! 入口は 2 系統ある。
//!
//! - **計算** … `compute` / `last_response_len`。`f64` の平坦なバッファで
//!   やり取りする速い経路。1 打鍵ごとに走るのでここは JSON を通さない。
//! - **API** … `api_call` / `import_state` / `export_state`。JSON でやり取りし、
//!   プロジェクト・アカウント・権限を扱う。サーバを建てたときに HTTP へ
//!   差し替わるのはこちらで、[`mhc_api`] の同じコードが動く。
//!
//! # JavaScript から見た使い方
//!
//! ```text
//! const ptr  = alloc(req.length * 8);
//! new Float64Array(memory.buffer, ptr, req.length).set(req);
//! const out  = compute(ptr, req.length);
//! const len  = last_response_len();
//! const resp = new Float64Array(memory.buffer, out, len).slice();  // 必ずコピーする
//! dealloc(ptr, req.length * 8);
//! ```
//!
//! `compute` が返すポインタは**次に `compute` を呼ぶまで**しか有効でないので、
//! JS 側は読んだ内容をコピーしてから使う。

use std::alloc::Layout;
use std::cell::RefCell;

use mhc_api::protocol::{dispatch, Envelope, Outcome};
use mhc_api::{ApiError, MemoryStore, Service};

/// `f64` バッファのアラインメント。
const ALIGN: usize = 8;

/// 一度に確保を許すバイト数の上限 (64 MiB)。
/// 壊れた長さが渡されたときにアロケータを巻き込まないための歯止め。
const MAX_ALLOC: usize = 64 * 1024 * 1024;

thread_local! {
    /// 直近の計算結果。JS がコピーし終えるまで生かしておく必要があるので、
    /// ここで所有を保持する。次の `compute` で置き換わる。
    static RESPONSE: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };

    /// 直近の API 応答 (UTF-8 の JSON)。同じく次の呼び出しまで有効。
    static TEXT: RefCell<String> = const { RefCell::new(String::new()) };

    /// ワークスペース。サーバで言えばデータベースにあたるものを、
    /// ローカルではここに丸ごと持つ。JS が `export_state` で取り出して保存し、
    /// 起動時に `import_state` で戻す。
    static WORKSPACE: RefCell<Service<MemoryStore>> =
        RefCell::new(Service::new(MemoryStore::new()));
}

/// JS が書き込むための領域を確保する。失敗したら null を返す。
///
/// 解放は必ず同じ `len_bytes` を添えて [`dealloc`] を呼ぶこと。
#[no_mangle]
pub extern "C" fn alloc(len_bytes: usize) -> *mut u8 {
    if len_bytes == 0 || len_bytes > MAX_ALLOC {
        return std::ptr::null_mut();
    }
    let Ok(layout) = Layout::from_size_align(len_bytes, ALIGN) else {
        return std::ptr::null_mut();
    };
    // SAFETY: layout は size > 0 で、ALIGN は 2 の冪。
    unsafe { std::alloc::alloc(layout) }
}

/// [`alloc`] で確保した領域を解放する。
///
/// # Safety
///
/// `ptr` は同じ `len_bytes` で [`alloc`] が返したものでなければならず、
/// 二重解放してはならない。
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len_bytes: usize) {
    if ptr.is_null() || len_bytes == 0 || len_bytes > MAX_ALLOC {
        return;
    }
    let Ok(layout) = Layout::from_size_align(len_bytes, ALIGN) else {
        return;
    };
    // SAFETY: 呼び出し側の契約により、ptr は同じ layout で確保されたもの。
    unsafe { std::alloc::dealloc(ptr, layout) }
}

/// リクエストバッファを処理し、レスポンスバッファの先頭ポインタを返す。
///
/// 長さは [`last_response_len`] で取得する。
///
/// # Safety
///
/// `ptr` は `len` 個の `f64` が読み出せる、8 バイト境界に揃った領域を
/// 指していなければならない。
#[no_mangle]
pub unsafe extern "C" fn compute(ptr: *const f64, len: usize) -> *const f64 {
    let request: &[f64] = if ptr.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: 呼び出し側の契約により、ptr..ptr+len は有効で揃っている。
        unsafe { std::slice::from_raw_parts(ptr, len) }
    };

    let response = mhc_core::abi::handle(request);

    RESPONSE.with(|cell| {
        let mut slot = cell.borrow_mut();
        *slot = response;
        slot.as_ptr()
    })
}

/// 直近の [`compute`] が返したバッファの長さ (`f64` の個数)。
#[no_mangle]
pub extern "C" fn last_response_len() -> usize {
    RESPONSE.with(|cell| cell.borrow().len())
}

/// ABI のバージョン。JS 側のグルーコードと食い違っていないか起動時に照合する。
#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    mhc_core::abi::VERSION as u32
}

/// API のバージョン。HTTP では `/v1` として現れるものと同じ。
#[no_mangle]
pub extern "C" fn api_version() -> u32 {
    mhc_api::API_VERSION.parse().unwrap_or(0)
}

/* ===== API 層 ===============================================
文字列は UTF-8 のバイト列としてやり取りする。JS 側は
TextEncoder / TextDecoder で変換する。                      */

/// 直近の文字列応答の長さ (バイト数)。
#[no_mangle]
pub extern "C" fn last_text_len() -> usize {
    TEXT.with(|cell| cell.borrow().len())
}

/// 応答を保持して、その先頭を返す。
fn emit(text: String) -> *const u8 {
    TEXT.with(|cell| {
        let mut slot = cell.borrow_mut();
        *slot = text;
        slot.as_ptr()
    })
}

/// 渡されたバイト列を UTF-8 として読む。
///
/// # Safety
///
/// `ptr` は `len` バイトが読み出せる領域を指していなければならない。
unsafe fn read_utf8<'a>(ptr: *const u8, len: usize) -> Result<&'a str, ApiError> {
    if ptr.is_null() || len == 0 {
        return Ok("");
    }
    // SAFETY: 呼び出し側の契約により、ptr..ptr+len は有効。
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).map_err(|e| ApiError::invalid(format!("UTF-8 ではありません: {e}")))
}

/// 失敗を、成功時と同じ形の JSON に包む。
fn failure(error: ApiError) -> String {
    let status = error.http_status();
    serde_json::to_string(&Outcome::Err { error, status })
        .unwrap_or_else(|_| r#"{"ok":"false","status":500}"#.to_string())
}

/// API を 1 回呼ぶ。入力も出力も JSON。
///
/// 長さは [`last_text_len`] で取得する。
///
/// # Safety
///
/// `ptr` は `len` バイトの UTF-8 を指していなければならない。
#[no_mangle]
pub unsafe extern "C" fn api_call(ptr: *const u8, len: usize) -> *const u8 {
    // SAFETY: 呼び出し側の契約をそのまま引き継ぐ。
    let text = match unsafe { read_utf8(ptr, len) } {
        Ok(text) => text,
        Err(error) => return emit(failure(error)),
    };
    let envelope: Envelope = match serde_json::from_str(text) {
        Ok(envelope) => envelope,
        Err(e) => {
            return emit(failure(ApiError::invalid(format!(
                "リクエストを読めません: {e}"
            ))))
        }
    };

    let outcome = WORKSPACE.with(|cell| dispatch(&mut cell.borrow_mut(), envelope));
    emit(
        serde_json::to_string(&outcome)
            .unwrap_or_else(|_| failure(ApiError::invalid("応答を作れません"))),
    )
}

/// 保存しておいたワークスペースを読み込む。
///
/// # Safety
///
/// `ptr` は `len` バイトの UTF-8 を指していなければならない。
#[no_mangle]
pub unsafe extern "C" fn import_state(ptr: *const u8, len: usize) -> *const u8 {
    // SAFETY: 呼び出し側の契約をそのまま引き継ぐ。
    let text = match unsafe { read_utf8(ptr, len) } {
        Ok(text) => text,
        Err(error) => return emit(failure(error)),
    };
    match MemoryStore::from_json(text) {
        Ok(store) => {
            WORKSPACE.with(|cell| *cell.borrow_mut() = Service::new(store));
            emit(
                serde_json::to_string(&Outcome::Ok {
                    reply: mhc_api::protocol::Reply::Empty,
                })
                .unwrap_or_else(|_| r#"{"ok":"true","reply":{"kind":"empty"}}"#.to_string()),
            )
        }
        Err(error) => emit(failure(error)),
    }
}

/// いまのワークスペースを JSON で取り出す。JS 側はこれを保存する。
#[no_mangle]
pub extern "C" fn export_state() -> *const u8 {
    let text = WORKSPACE.with(|cell| cell.borrow().store().to_json());
    emit(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mhc_core::abi::{Engine, Request, Status, TaskInput, RESP_HEADER};

    /// JS 側がやる手順をそのままネイティブで再現する。
    /// `cargo miri test` でこの経路の未定義動作を検査できる。
    fn round_trip(request: &[f64]) -> Vec<f64> {
        let bytes = std::mem::size_of_val(request);
        let ptr = alloc(bytes);
        assert!(!ptr.is_null());

        // SAFETY: alloc が bytes 分を 8 バイト境界で返している。
        unsafe {
            let buf = std::slice::from_raw_parts_mut(ptr as *mut f64, request.len());
            buf.copy_from_slice(request);

            let out = compute(ptr as *const f64, request.len());
            let len = last_response_len();
            let response = std::slice::from_raw_parts(out, len).to_vec();

            dealloc(ptr, bytes);
            response
        }
    }

    #[test]
    fn a_full_round_trip_produces_a_valid_response() {
        let request = Request {
            engine: Engine::Convolution,
            iterations: 1_000,
            n_bins: 40,
            grid_points: 1_024,
            tasks: vec![
                TaskInput::estimate_only(5.0, 8.0, 20.0),
                TaskInput::estimate_only(2.0, 3.0, 5.0),
            ],
            ..Request::default()
        };
        let resp = round_trip(&request.encode());
        assert_eq!(resp[0], Status::Ok as u8 as f64);

        let n_bins = resp[2] as usize;
        let n_pct = resp[3] as usize;
        let n_tasks = resp[4] as usize;
        let prefix_width = if resp[13] > 0.0 {
            resp[13] as usize + 1
        } else {
            0
        };
        let n_days = resp[14] as usize;
        let n_members = resp[17] as usize;
        let expected = mhc_core::abi::response_offsets(
            n_bins,
            n_pct,
            n_tasks,
            prefix_width,
            n_members,
            n_days,
        )[mhc_core::abi::LAST_OFFSET];
        assert_eq!(resp.len(), expected, "宣言長とバッファ長が一致しない");
    }

    #[test]
    fn a_garbage_request_comes_back_as_an_error_not_a_crash() {
        let resp = round_trip(&[1.0, 2.0, 3.0]);
        assert_eq!(resp[0], Status::BadHeader as u8 as f64);
        assert_eq!(resp.len(), RESP_HEADER);
    }

    #[test]
    fn an_empty_request_is_handled() {
        // SAFETY: null と長さ 0 は compute が明示的に許容している。
        let resp = unsafe {
            let out = compute(std::ptr::null(), 0);
            std::slice::from_raw_parts(out, last_response_len()).to_vec()
        };
        assert_eq!(resp[0], Status::BadHeader as u8 as f64);
    }

    #[test]
    fn oversized_and_zero_allocations_return_null() {
        assert!(alloc(0).is_null());
        assert!(alloc(usize::MAX).is_null());
        // null の解放は何もしない (二重解放にならない)。
        // SAFETY: null を渡すのは契約上許されている。
        unsafe { dealloc(std::ptr::null_mut(), 0) };
    }

    #[test]
    fn the_abi_version_matches_the_core() {
        assert_eq!(abi_version(), mhc_core::abi::VERSION as u32);
        assert_eq!(api_version(), 1);
    }

    /* ===== API 層 ===== */

    /// JS 側がやる手順をそのままネイティブで再現する。
    fn call_api(json: &str) -> String {
        // SAFETY: 渡すのは有効な UTF-8 のスライス。
        unsafe {
            let ptr = api_call(json.as_ptr(), json.len());
            let bytes = std::slice::from_raw_parts(ptr, last_text_len());
            String::from_utf8(bytes.to_vec()).expect("UTF-8 のはず")
        }
    }

    fn load_state(json: &str) -> String {
        // SAFETY: 渡すのは有効な UTF-8 のスライス。
        unsafe {
            let ptr = import_state(json.as_ptr(), json.len());
            let bytes = std::slice::from_raw_parts(ptr, last_text_len());
            String::from_utf8(bytes.to_vec()).expect("UTF-8 のはず")
        }
    }

    fn dump_state() -> String {
        // SAFETY: export_state は保持した文字列の先頭を返す。
        unsafe {
            let ptr = export_state();
            let bytes = std::slice::from_raw_parts(ptr, last_text_len());
            String::from_utf8(bytes.to_vec()).expect("UTF-8 のはず")
        }
    }

    const SEED_STATE: &str = r#"{
        "version": 1,
        "users": [
            {"id":"me","name":"わたし","systemRole":"admin","createdAt":"2026-09-20T00:00:00Z"}
        ],
        "projects": []
    }"#;

    /// 成功の応答は `{"ok":"true","reply":{"kind":...,"value":...}}` の形。
    /// JS 側はこの形に合わせて読むので、ずれたら気づけるようにしておく。
    #[test]
    fn a_successful_reply_has_the_shape_the_client_expects() {
        load_state(SEED_STATE);
        let listed = call_api(
            r#"{"actor":"me","now":"2026-09-20T10:00:00Z","request":{"op":"listProjects"}}"#,
        );
        assert!(listed.contains(r#""ok":"true""#), "{listed}");
        assert!(
            listed.contains(r#""reply":{"kind":"projects","value":[]}"#),
            "{listed}"
        );

        // 状態の読み込みも同じ形で返る。
        assert!(load_state(SEED_STATE).contains(r#""reply":{"kind":"empty"}"#));
    }

    #[test]
    fn the_api_works_end_to_end_through_the_bridge() {
        assert!(load_state(SEED_STATE).contains(r#""ok":"true""#));

        let created = call_api(
            r#"{"actor":"me","now":"2026-09-20T10:00:00Z","request":{"op":"createProject","id":"p1","name":"新規案件"}}"#,
        );
        assert!(created.contains(r#""ok":"true""#), "{created}");
        assert!(created.contains("新規案件"), "{created}");

        let listed = call_api(
            r#"{"actor":"me","now":"2026-09-20T10:00:00Z","request":{"op":"listProjects"}}"#,
        );
        assert!(listed.contains("新規案件"), "{listed}");

        // 取り出した状態を読み直しても同じものが残る。
        let saved = dump_state();
        assert!(load_state(&saved).contains(r#""ok":"true""#));
        assert!(call_api(
            r#"{"actor":"me","now":"2026-09-20T10:00:00Z","request":{"op":"listProjects"}}"#
        )
        .contains("新規案件"));
    }

    #[test]
    fn an_unknown_caller_is_refused_with_401() {
        load_state(SEED_STATE);
        let outcome = call_api(
            r#"{"actor":"侵入者","now":"2026-09-20T10:00:00Z","request":{"op":"listProjects"}}"#,
        );
        assert!(outcome.contains(r#""ok":"false""#), "{outcome}");
        assert!(outcome.contains(r#""status":401"#), "{outcome}");
    }

    #[test]
    fn malformed_json_comes_back_as_an_error_not_a_crash() {
        for bad in ["", "{", "これは JSON ではない", r#"{"actor":"me"}"#] {
            let outcome = call_api(bad);
            assert!(outcome.contains(r#""ok":"false""#), "{bad} → {outcome}");
        }
    }

    #[test]
    fn a_broken_saved_state_is_refused_without_wiping_what_is_loaded() {
        load_state(SEED_STATE);
        call_api(
            r#"{"actor":"me","now":"2026-09-20T10:00:00Z","request":{"op":"createProject","id":"p1","name":"残るはず"}}"#,
        );

        let outcome = load_state("壊れたデータ");
        assert!(outcome.contains(r#""ok":"false""#), "{outcome}");
        // 読み込みに失敗しても、いま持っているものは消さない。
        assert!(dump_state().contains("残るはず"));
    }

    #[test]
    fn a_state_from_a_newer_version_is_refused() {
        let outcome = load_state(r#"{"version":999,"users":[],"projects":[]}"#);
        assert!(outcome.contains(r#""ok":"false""#), "{outcome}");
    }
}
