//! 画面 (TypeScript) と API (Rust) のあいだの取り決め (コントラクトテスト)。
//!
//! 画面は API を 2 通りに呼ぶ。同じ `ApiClient` の 2 つの実装で、
//!
//! - ローカル版 (`web/src/api/local.ts`): `{"op": "createProject", …}` を WASM に渡す
//! - サーバ版 (`web/src/api/http.ts`): `POST /v1/projects` を送る
//!
//! どちらも Rust の [`Request`] と [`ROUTES`] に**書き写して**合わせている。
//! 片方だけ名前を変えると、型検査もどちらの単体テストも通ったまま、
//! 画面から呼んだときに初めて「知らない操作」で落ちる。ここで突き合わせる。
//!
//! Rust 側が唯一の正。TypeScript を読んで、次を見る。
//!
//! 1. ローカル版が使う `op` はすべて Rust にあり、Rust の操作はすべて使われている
//! 2. サーバ版が送る (メソッド, パス) はすべてルート表にあり、その逆も

use std::collections::BTreeSet;

use mhc_api::protocol::{Request, ROUTES};

const LOCAL: &str = include_str!("../../../web/src/api/local.ts");
const HTTP: &str = include_str!("../../../web/src/api/http.ts");
const PROTOCOL: &str = include_str!("../src/protocol.rs");

/// Rust の操作の名前 (serde の綴り = camelCase)。`route()` は全部の場合を
/// 並べた match なので、そこから拾えば漏れが無い。
fn rust_ops() -> BTreeSet<String> {
    let start = PROTOCOL
        .find("pub fn route(&self)")
        .expect("route() がある");
    let body = &PROTOCOL[start..start + PROTOCOL[start..].find("\n    }\n").expect("閉じる")];
    body.split("Self::")
        .skip(1)
        .map(|rest| {
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric()).collect();
            let mut chars = name.chars();
            let first = chars.next().expect("空でない").to_ascii_lowercase();
            std::iter::once(first).chain(chars).collect()
        })
        .collect()
}

/// `op: "…"` の綴りを拾う。
fn local_ops() -> BTreeSet<String> {
    LOCAL
        .split("op: \"")
        .skip(1)
        .map(|rest| rest.split('"').next().unwrap_or("").to_string())
        .collect()
}

/// パスの差し込み口を、名前を問わない形にそろえる。
fn shape(path: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in path.chars() {
        match c {
            '{' => {
                depth += 1;
                if depth == 1 {
                    out.push_str("{}");
                }
            }
            '}' => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// `this.send("PATCH", `/v1/users/${seg(id)}`, …)` から (メソッド, パスの形) を拾う。
fn http_routes() -> BTreeSet<(String, String)> {
    HTTP.split("this.send(\"")
        .skip(1)
        .map(|rest| {
            let method = rest.split('"').next().unwrap_or("").to_string();
            let after = &rest[method.len() + 1..];
            let quote = after
                .trim_start_matches([',', ' '])
                .chars()
                .next()
                .unwrap_or('"');
            let text = after.trim_start_matches([',', ' '])[1..]
                .split(quote)
                .next()
                .unwrap_or("")
                .to_string();
            // `${principalPath(p)}` は `{kind}/{id}` の 2 段になる。
            // `${query}` は `?task=…` を付けるだけで、パスの段ではない。
            let text = text
                .replace("${principalPath(principal)}", "{kind}/{id}")
                .replace("${query}", "")
                .replace('$', "");
            (method, shape(&text))
        })
        .collect()
}

#[test]
fn the_local_client_speaks_exactly_the_rust_operations() {
    let rust = rust_ops();
    let local = local_ops();
    assert_eq!(
        rust.len(),
        ROUTES.len(),
        "route() から拾った数がルート表と違う"
    );

    let unknown: Vec<_> = local.difference(&rust).collect();
    assert!(
        unknown.is_empty(),
        "Rust に無い操作を画面が呼んでいる: {unknown:?}"
    );
    let unused: Vec<_> = rust.difference(&local).collect();
    assert!(
        unused.is_empty(),
        "画面 (ローカル版) が呼べない操作がある: {unused:?}"
    );

    // 念のため、拾った名前は本当に Rust が読める綴りか。
    for op in &local {
        let error = serde_json::from_value::<Request>(serde_json::json!({ "op": op }))
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(!error.contains("unknown variant"), "{op}: {error}");
    }
}

#[test]
fn the_http_client_speaks_exactly_the_rust_routes() {
    let rust: BTreeSet<(String, String)> = ROUTES
        .iter()
        .map(|&(method, path)| (method.to_string(), shape(path)))
        .collect();
    let http = http_routes();
    assert!(
        http.len() >= 20,
        "http.ts から {} 件しか拾えていない",
        http.len()
    );

    let unknown: Vec<_> = http.difference(&rust).collect();
    assert!(
        unknown.is_empty(),
        "サーバに無いルートを画面が呼んでいる: {unknown:?}"
    );
    let unused: Vec<_> = rust.difference(&http).collect();
    assert!(
        unused.is_empty(),
        "画面 (サーバ版) が呼べないルートがある: {unused:?}"
    );
}
