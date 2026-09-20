//! `dist/index.html` を組み立てるビルドツール。
//!
//! やることは 4 つだけ:
//!
//! 1. `mhc-wasm` を `wasm32-unknown-unknown` 向けにビルドする
//! 2. `wasm-opt` があればサイズ最適化をかける
//! 3. `.wasm` を base64 に変換する
//! 4. `web/` のテンプレートに CSS・JS・base64 を流し込んで 1 枚の HTML にする
//!
//! WASM を base64 で埋め込むのは、`fetch()` を使わずに済ませるため。
//! `file://` で開いたページからの `fetch()` は CORS で弾かれるので、
//! 「HTML ファイルをダブルクリックすれば動く」を満たすにはこの形しかない。
//!
//! 使い方: `cargo xtask build [--debug]`

use std::path::{Path, PathBuf};
use std::process::Command;

/// 生成する HTML の上限サイズ。オフライン配布物として現実的な大きさに保つための歯止め。
const SIZE_BUDGET_BYTES: usize = 400 * 1024;

/// テンプレート中の差し込み位置と、対応する `web/` 配下のファイル。
const PARTS: [(&str, &str); 4] = [
    ("/*{{CSS}}*/", "style.css"),
    ("/*{{I18N}}*/", "i18n.js"),
    ("/*{{CHART_JS}}*/", "chart.js"),
    ("/*{{APP_JS}}*/", "app.js"),
];

const WASM_PLACEHOLDER: &str = "/*{{WASM_BASE64}}*/";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("build");
    let release = !args.iter().any(|a| a == "--debug");

    let result = match command {
        "build" => build(release),
        other => Err(format!(
            "未知のコマンド `{other}`。使えるのは `build` だけ (オプション: --debug)"
        )),
    };

    if let Err(message) = result {
        eprintln!("error: {message}");
        std::process::exit(1);
    }
}

fn build(release: bool) -> Result<(), String> {
    let root = workspace_root();
    let profile = if release { "release" } else { "debug" };

    println!("==> mhc-wasm を wasm32-unknown-unknown 向けにビルド ({profile})");
    let mut cargo = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    cargo.current_dir(&root).args([
        "build",
        "--package",
        "mhc-wasm",
        "--target",
        "wasm32-unknown-unknown",
    ]);
    if release {
        cargo.arg("--release");
    }
    let status = cargo
        .status()
        .map_err(|e| format!("cargo の起動に失敗: {e}"))?;
    if !status.success() {
        return Err("wasm のビルドに失敗しました".into());
    }

    let wasm_path = root
        .join("target/wasm32-unknown-unknown")
        .join(profile)
        .join("mhc_wasm.wasm");
    let raw_size = std::fs::metadata(&wasm_path)
        .map_err(|e| format!("{} が読めません: {e}", wasm_path.display()))?
        .len();
    println!("    {} ({} KiB)", wasm_path.display(), raw_size / 1024);

    let wasm_path = optimize(&wasm_path)?;
    let wasm = std::fs::read(&wasm_path)
        .map_err(|e| format!("{} が読めません: {e}", wasm_path.display()))?;
    println!("==> WASM {} KiB を base64 に変換", wasm.len() / 1024);

    let mut html = read(&root.join("web/index.html.template"))?;
    for (placeholder, file) in PARTS {
        let content = read(&root.join("web").join(file))?;
        if !html.contains(placeholder) {
            return Err(format!("テンプレートに {placeholder} が見つかりません"));
        }
        html = html.replace(placeholder, &content);
    }
    if !html.contains(WASM_PLACEHOLDER) {
        return Err(format!(
            "テンプレートに {WASM_PLACEHOLDER} が見つかりません"
        ));
    }
    html = html.replace(WASM_PLACEHOLDER, &base64_encode(&wasm));

    let dist = root.join("dist");
    std::fs::create_dir_all(&dist).map_err(|e| format!("dist/ を作れません: {e}"))?;
    let out = dist.join("index.html");
    std::fs::write(&out, &html).map_err(|e| format!("{} を書けません: {e}", out.display()))?;

    let size = html.len();
    println!("==> {} ({} KiB)", out.display(), size / 1024);
    if size > SIZE_BUDGET_BYTES {
        return Err(format!(
            "サイズ上限を超えました: {} KiB > {} KiB",
            size / 1024,
            SIZE_BUDGET_BYTES / 1024
        ));
    }
    println!(
        "    サイズ上限まで残り {} KiB",
        (SIZE_BUDGET_BYTES - size) / 1024
    );
    Ok(())
}

/// `wasm-opt` があればサイズ最適化をかけ、出力先のパスを返す。
/// 入っていない環境でもビルド自体は通るようにしている。
fn optimize(wasm: &Path) -> Result<PathBuf, String> {
    let optimized = wasm.with_extension("opt.wasm");
    let result = Command::new("wasm-opt")
        .args(["-Oz", "--enable-bulk-memory"])
        .arg(wasm)
        .arg("-o")
        .arg(&optimized)
        .status();

    match result {
        Ok(status) if status.success() => {
            let size = std::fs::metadata(&optimized).map(|m| m.len()).unwrap_or(0);
            println!("==> wasm-opt -Oz 適用後 {} KiB", size / 1024);
            Ok(optimized)
        }
        Ok(_) => Err("wasm-opt がエラー終了しました".into()),
        Err(_) => {
            println!(
                "==> wasm-opt が見つからないので最適化を省略 (binaryen を入れると小さくなります)"
            );
            Ok(wasm.to_path_buf())
        }
    }
}

fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{} が読めません: {e}", path.display()))
}

/// このクレートの位置からワークスペースルートを求める。
/// `cargo xtask` をどのディレクトリから呼んでも同じ結果になるようにするため。
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/xtask の 2 つ上がワークスペースルート")
        .to_path_buf()
}

/// 標準の base64 (パディングあり)。外部クレートを足さずに済ませるための最小実装。
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_the_rfc4648_test_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_handles_high_bytes_and_wasm_magic() {
        assert_eq!(base64_encode(&[0x00, 0x61, 0x73, 0x6d]), "AGFzbQ==");
        assert_eq!(base64_encode(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64_encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }

    #[test]
    fn base64_output_length_is_always_a_multiple_of_four() {
        for n in 0..64 {
            let bytes: Vec<u8> = (0..n).map(|i| i as u8).collect();
            assert_eq!(base64_encode(&bytes).len() % 4, 0, "n = {n}");
        }
    }
}
