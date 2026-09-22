//! 1 枚の HTML を組み立てるビルドツールの骨。
//!
//! `crates/xtask/src/main.rs` に置き、`.cargo/config.toml` に
//! `[alias] xtask = "run --package xtask --"` を書けば `cargo xtask build` で動く。
//!
//! <<<PROJECT>>> などは差し替える。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 配るファイルの上限。**なぜこの数字かをここに書く。**
/// 数字だけ置いても、次に増やすときの判断ができない。
const SIZE_BUDGET_BYTES: usize = 896 * 1024;

/// テンプレートの差し込み位置と、対応するビルド成果物。
const PARTS: [(&str, &str); 2] = [
    ("/*{{CSS}}*/", "dist/bundle.css"),
    ("/*{{APP_JS}}*/", "dist/bundle.js"),
];
const WASM_PLACEHOLDER: &str = "/*{{WASM_BASE64}}*/";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = Options {
        release: !args.iter().any(|a| a == "--debug"),
        // CI でだけ立てる。最適化が静かに外れたまま配布物が出るのを防ぐ。
        require_wasm_opt: args.iter().any(|a| a == "--require-wasm-opt"),
    };
    if let Err(message) = build(options) {
        eprintln!("error: {message}");
        std::process::exit(1);
    }
}

#[derive(Clone, Copy)]
struct Options {
    release: bool,
    require_wasm_opt: bool,
}

fn build(options: Options) -> Result<(), String> {
    let root = workspace_root();
    let profile = if options.release { "release" } else { "debug" };

    // 1. TypeScript を esbuild で 1 本の JS と 1 枚の CSS に
    build_web(&root)?;

    // 2. WASM を組む
    let mut cargo = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    cargo.current_dir(&root).args([
        "build", "--package", "<<<WASM_CRATE>>>",
        "--target", "wasm32-unknown-unknown",
    ]);
    if options.release {
        cargo.arg("--release");
    }
    if !cargo.status().map_err(|e| e.to_string())?.success() {
        return Err("wasm のビルドに失敗しました".into());
    }

    let wasm_path = root
        .join("target/wasm32-unknown-unknown")
        .join(profile)
        .join("<<<WASM_CRATE_SNAKE>>>.wasm");

    // 3. wasm-opt (任意。CI では必須)
    let (wasm_path, optimized) = optimize(&wasm_path, options.require_wasm_opt)?;
    let wasm = std::fs::read(&wasm_path).map_err(|e| e.to_string())?;

    // 4-5. テンプレートに流し込む
    let mut html = read(&root.join("web/index.html.template"))?;
    for (placeholder, file) in PARTS {
        let content = read(&root.join("web").join(file))?;
        if !html.contains(placeholder) {
            return Err(format!("テンプレートに {placeholder} がありません"));
        }
        html = html.replace(placeholder, &escape_for_inline_script(&content));
    }
    html = html.replace(WASM_PLACEHOLDER, &base64_encode(&wasm));

    let dist = root.join("dist");
    std::fs::create_dir_all(&dist).map_err(|e| e.to_string())?;
    // 6. 紹介ページはそのまま置く (組み立てるものが無い)
    std::fs::write(dist.join("index.html"), read(&root.join("web/landing.html"))?)
        .map_err(|e| e.to_string())?;
    std::fs::write(dist.join("app.html"), &html).map_err(|e| e.to_string())?;

    // 上限は**配るファイル**についての約束。最適化を省いた手元のビルドで
    // 引っかかっても直しようがないので、かけたときだけ見る。
    if optimized && html.len() > SIZE_BUDGET_BYTES {
        return Err(format!(
            "サイズ上限を超えました: {} KiB > {} KiB",
            html.len() / 1024,
            SIZE_BUDGET_BYTES / 1024
        ));
    }
    Ok(())
}

fn build_web(root: &Path) -> Result<(), String> {
    let web = root.join("web");
    if !web.join("node_modules").exists() {
        run_npm(&web, &["ci"])?;
    }
    run_npm(&web, &["run", "build"])
}

fn run_npm(dir: &Path, args: &[&str]) -> Result<(), String> {
    // Windows では npm.cmd を呼ぶ必要がある。
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let status = Command::new(npm)
        .current_dir(dir)
        .args(args)
        .status()
        .map_err(|e| format!("npm の起動に失敗 ({e})。Node.js が必要です"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("npm {} が失敗しました", args.join(" ")))
    }
}

/// `-all` を付ける。個別に機能フラグを並べると binaryen を上げるたびに壊れる。
/// rustc の既定出力 (sign-ext / bulk-memory / nontrapping-float-to-int) に対して
/// wasm-opt 側の既定の許可集合は狭く、しかも版ごとに変わる。
fn optimize(wasm: &Path, require: bool) -> Result<(PathBuf, bool), String> {
    let optimized = wasm.with_extension("opt.wasm");
    let result = Command::new("wasm-opt")
        .args(["-Oz", "-all"])
        .arg(wasm)
        .arg("-o")
        .arg(&optimized)
        .status();
    let reason = match result {
        Ok(s) if s.success() => return Ok((optimized, true)),
        Ok(s) => format!("wasm-opt が失敗しました ({s})"),
        Err(_) => "wasm-opt が見つかりません".to_string(),
    };
    if require {
        return Err(format!("{reason} (--require-wasm-opt)"));
    }
    println!("==> {reason}。最適化を省略します");
    Ok((wasm.to_path_buf(), false))
}

/// インライン `<script>` の中に `</script` が現れるとそこでタグが閉じる。
/// JS では文字列か正規表現リテラルの中にしか現れえないので機械的に置換してよい。
fn escape_for_inline_script(content: &str) -> String {
    content.replace("</script", "<\\/script")
}

fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{} が読めません: {e}", path.display()))
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/xtask の 2 つ上")
        .to_path_buf()
}

/// 外部クレートを足さないための最小実装。RFC 4648。
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    /// RFC 4648 のテストベクタを固定する。自前実装はこれを付けてから使う。
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

    /// 上位ビットの立ったバイトと wasm のマジックナンバー。
    #[test]
    fn base64_handles_high_bytes() {
        assert_eq!(base64_encode(&[0x00, 0x61, 0x73, 0x6d]), "AGFzbQ==");
        assert_eq!(base64_encode(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64_encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }
}
