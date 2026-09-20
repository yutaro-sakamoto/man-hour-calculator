//! `dist/app.html` (道具そのもの) をバイナリに取り込む。
//!
//! 画面を別に配らなくて済むようにするため。まだ作っていなければ、
//! 作り方を書いた案内ページを入れる (ビルドは止めない。サーバだけ先に
//! 建てて API を試す、という使い方ができるように)。

use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("crates/server の 2 つ上がリポジトリの根")
        .to_path_buf();
    let dist = root.join("dist/app.html");
    println!("cargo:rerun-if-changed={}", dist.display());

    let html = std::fs::read_to_string(&dist).unwrap_or_else(|_| PLACEHOLDER.to_string());

    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR がある")).join("ui.html");
    std::fs::write(&out, html).expect("ui.html を書けない");
}

const PLACEHOLDER: &str = r#"<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>画面がまだ埋め込まれていません</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 40rem;
             padding: 3rem 1rem; line-height: 1.7; }
      code { background: #f0efec; border-radius: 4px; padding: 0.1em 0.4em; }
      @media (prefers-color-scheme: dark) {
        body { background: #1a1a19; color: #fff; }
        code { background: #2c2c2a; }
      }
    </style>
  </head>
  <body>
    <h1>画面がまだ埋め込まれていません</h1>
    <p>API は動いています。画面も配るには、先に作ってからサーバを組み立て直してください。</p>
    <pre><code>cargo xtask build
cargo build --profile server -p mhc-server</code></pre>
    <p>すでに手元に HTML があるなら <code>--ui &lt;path&gt;</code> で指せます。</p>
  </body>
</html>
"#;
