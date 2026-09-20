//! `mhc-core` を WebAssembly から呼び出すための薄い FFI 層。
//!
//! このクレートだけが `unsafe` を使う。中身の計算ロジックは
//! `#![forbid(unsafe_code)]` な [`mhc_core`] にあり、ここは
//! 「線形メモリ上のバッファを Rust のスライスに読み替える」だけを担当する。
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

/// `f64` バッファのアラインメント。
const ALIGN: usize = 8;

/// 一度に確保を許すバイト数の上限 (64 MiB)。
/// 壊れた長さが渡されたときにアロケータを巻き込まないための歯止め。
const MAX_ALLOC: usize = 64 * 1024 * 1024;

thread_local! {
    /// 直近のレスポンス。JS がコピーし終えるまで生かしておく必要があるので、
    /// ここで所有を保持する。次の `compute` で置き換わる。
    static RESPONSE: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
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
    }
}
