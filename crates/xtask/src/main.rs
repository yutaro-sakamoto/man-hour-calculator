//! `dist/index.html` を組み立てるビルドツール。
//!
//! やることは 4 つだけ:
//!
//! 1. `web/` の TypeScript を esbuild で 1 本の JS と 1 枚の CSS にまとめる
//! 2. `mhc-wasm` を `wasm32-unknown-unknown` 向けにビルドする
//! 3. `wasm-opt` があればサイズ最適化をかける
//! 4. `.wasm` を base64 に変換する
//! 5. `web/` のテンプレートに CSS・JS・base64 を流し込んで 1 枚の HTML にする
//!
//! WASM を base64 で埋め込むのは、`fetch()` を使わずに済ませるため。
//! `file://` で開いたページからの `fetch()` は CORS で弾かれるので、
//! 「HTML ファイルをダブルクリックすれば動く」を満たすにはこの形しかない。
//!
//! 使い方: `cargo xtask build [--debug] [--require-wasm-opt]`

use std::path::{Path, PathBuf};
use std::process::Command;

/// 生成する HTML の上限サイズ。青天井に膨らんでいないかを見る歯止め。
///
/// API 層 (プロジェクト・アカウント・権限) を Rust に置き、JSON でやり取りする
/// ようにした時点で、serde_json のぶんだけ WASM が 75 KiB から 330 KiB に増えた。
/// 権限の判定と不変条件をローカルとサーバで 1 つの実装に保つための代償で、
/// 二重実装にして食い違わせるよりは良いと判断している。
/// HTTP 配信では gzip で 1/4 ほどに縮み、`file://` では単なる 1 ファイル。
const SIZE_BUDGET_BYTES: usize = 768 * 1024;

/// テンプレート中の差し込み位置と、対応する `web/` 配下のビルド成果物。
const PARTS: [(&str, &str); 2] = [
    ("/*{{CSS}}*/", "dist/bundle.css"),
    ("/*{{APP_JS}}*/", "dist/bundle.js"),
];

const WASM_PLACEHOLDER: &str = "/*{{WASM_BASE64}}*/";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("build");
    let options = Options {
        release: !args.iter().any(|a| a == "--debug"),
        require_wasm_opt: args.iter().any(|a| a == "--require-wasm-opt"),
    };

    let result = match command {
        "build" => build(options),
        other => Err(format!(
            "未知のコマンド `{other}`。使えるのは `build` だけ (オプション: --debug, --require-wasm-opt)"
        )),
    };

    if let Err(message) = result {
        eprintln!("error: {message}");
        std::process::exit(1);
    }
}

#[derive(Debug, Clone, Copy)]
struct Options {
    release: bool,
    /// wasm-opt をかけられなかったらビルドを失敗させる。CI でだけ立てて、
    /// 最適化が静かに外れたまま配布物が出てしまうのを防ぐ。
    require_wasm_opt: bool,
}

fn build(options: Options) -> Result<(), String> {
    let root = workspace_root();
    let profile = if options.release { "release" } else { "debug" };

    build_web(&root)?;

    println!("==> mhc-wasm を wasm32-unknown-unknown 向けにビルド ({profile})");
    let mut cargo = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    cargo.current_dir(&root).args([
        "build",
        "--package",
        "mhc-wasm",
        "--target",
        "wasm32-unknown-unknown",
    ]);
    if options.release {
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

    let wasm_path = optimize(&wasm_path, options.require_wasm_opt)?;
    let wasm = std::fs::read(&wasm_path)
        .map_err(|e| format!("{} が読めません: {e}", wasm_path.display()))?;
    println!("==> WASM {} KiB を base64 に変換", wasm.len() / 1024);

    let mut html = read(&root.join("web/index.html.template"))?;
    for (placeholder, file) in PARTS {
        let content = read(&root.join("web").join(file))?;
        if !html.contains(placeholder) {
            return Err(format!("テンプレートに {placeholder} が見つかりません"));
        }
        html = html.replace(placeholder, &escape_for_inline_script(&content));
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

/// `web/` の TypeScript をバンドルする。
///
/// 依存が入っていなければ `npm ci` から走らせる。ビルドに Node が要るのは
/// フロントを TypeScript で書いているためで、配布物そのものには影響しない
/// (出力は普通の JS と CSS)。
fn build_web(root: &Path) -> Result<(), String> {
    let web = root.join("web");
    if !web.join("node_modules").exists() {
        println!("==> web の依存を取得 (npm ci)");
        run_npm(&web, &["ci"])?;
    }
    println!("==> web の TypeScript をバンドル (esbuild)");
    run_npm(&web, &["run", "build"])
}

fn run_npm(dir: &Path, args: &[&str]) -> Result<(), String> {
    let status = Command::new(npm_command())
        .current_dir(dir)
        .args(args)
        .status()
        .map_err(|e| format!("npm の起動に失敗しました ({e})。Node.js が必要です"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("npm {} が失敗しました", args.join(" ")))
    }
}

/// Windows では `npm.cmd` を呼ぶ必要がある。
fn npm_command() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

/// `wasm-opt` があればサイズ最適化をかけ、使うべき `.wasm` のパスを返す。
///
/// `-all` で全機能を許可しているのは、rustc が wasm32-unknown-unknown 向けに
/// 既定で sign-ext・bulk-memory・nontrapping-float-to-int を含む出力をするのに対し、
/// wasm-opt 側の既定の許可集合はそれより狭く、しかも binaryen のバージョンごとに
/// 変わるため (bulk-memory が bulk-memory と bulk-memory-opt に分かれた、など)。
/// 個別にフラグを並べると binaryen を上げ下げするたびにビルドが壊れる。
///
/// 最適化は任意で、wasm-opt が無い環境でもビルドは通る。ただし `require` が
/// 立っているとき (CI) は、最適化が静かに外れたまま配布物が出ないように失敗させる。
fn optimize(wasm: &Path, require: bool) -> Result<PathBuf, String> {
    let optimized = wasm.with_extension("opt.wasm");
    let result = Command::new("wasm-opt")
        .args(["-Oz", "-all"])
        .arg(wasm)
        .arg("-o")
        .arg(&optimized)
        .status();

    let reason = match result {
        Ok(status) if status.success() => {
            let size = std::fs::metadata(&optimized).map(|m| m.len()).unwrap_or(0);
            println!("==> wasm-opt -Oz 適用後 {} KiB", size / 1024);
            return Ok(optimized);
        }
        Ok(status) => format!("wasm-opt が失敗しました ({status})"),
        Err(_) => "wasm-opt が見つかりません".to_string(),
    };

    if require {
        return Err(format!("{reason} (--require-wasm-opt が指定されています)"));
    }
    println!("==> {reason}。最適化を省略します (binaryen を入れると小さくなります)");
    Ok(wasm.to_path_buf())
}

/// インライン `<script>` に流し込む前の逃がし処理。
///
/// 中身に `</script` が現れるとそこでタグが閉じてしまう。JavaScript では
/// 文字列か正規表現リテラルの中にしか現れえず、`<\/script` と書いても同じ
/// 文字列になるため、機械的に置き換えてよい (CSS には現れない)。
fn escape_for_inline_script(content: &str) -> String {
    content.replace("</script", "<\\/script")
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
