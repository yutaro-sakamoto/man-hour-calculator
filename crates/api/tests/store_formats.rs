//! 保存データの**過去の形**を全部、いつまでも開けること (移行テスト)。
//!
//! `tests/fixtures/store-v{N}.json` は、版 N のアプリが実際に書いた形の見本。
//! 読み込んで今の形で書き出したものを、`store-v{N}.expected.json` (ゴールデン)
//! と突き合わせる。**移行で何かが落ちたり化けたりすると、差分で分かる。**
//!
//! 版を上げたら、上げた版の見本を足す (`scripts/check-sync.sh` が、今の版の
//! 見本があるかを見ている)。見本は一度置いたら書き換えない — 書き換えると、
//! その版で保存した利用者のファイルを試していないことになる。
//!
//! 読み込み結果の形を**わざと**変えたときは、ゴールデンを書き直す:
//!
//! ```sh
//! MHC_UPDATE_GOLDEN=1 cargo test -p mhc-api --test store_formats
//! ```
//!
//! 書き直した差分は、レビューで必ず目で見る。

use std::path::Path;

use mhc_api::store::{MemoryStore, STORE_VERSION};

fn pretty(json: &str) -> String {
    let value: serde_json::Value = serde_json::from_str(json).expect("JSON");
    serde_json::to_string_pretty(&value).expect("書ける") + "\n"
}

#[test]
fn every_saved_format_opens_into_exactly_the_expected_store() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let update = std::env::var_os("MHC_UPDATE_GOLDEN").is_some();
    let mut versions = Vec::new();

    for entry in std::fs::read_dir(&dir).expect("fixtures がある") {
        let path = entry.expect("読める").path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let Some(version) = name
            .strip_prefix("store-v")
            .and_then(|rest| rest.strip_suffix(".json"))
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        versions.push(version);

        let text = std::fs::read_to_string(&path).expect("読める");
        let store =
            MemoryStore::from_json(&text).unwrap_or_else(|e| panic!("{name} を開けない: {e:?}"));
        let actual = pretty(&store.to_json());
        assert!(
            actual.contains(&format!("\"version\": {STORE_VERSION}")),
            "{name} が今の版 ({STORE_VERSION}) に上がっていない"
        );

        let golden = dir.join(format!("store-v{version}.expected.json"));
        if update {
            std::fs::write(&golden, &actual).expect("書ける");
            continue;
        }
        let expected = std::fs::read_to_string(&golden).unwrap_or_else(|_| {
            panic!(
                "{} がありません。MHC_UPDATE_GOLDEN=1 で作り、中身を確かめてください",
                golden.display()
            )
        });
        assert_eq!(actual, expected, "{name} の読み込み結果がゴールデンと違う");

        // 今の形で書いたものは、読み直しても変わらない。
        let again = MemoryStore::from_json(&actual).expect("読み直せる");
        assert_eq!(pretty(&again.to_json()), actual, "{name}: 往復で変わる");
    }

    versions.sort();
    assert!(versions.contains(&1), "最初の版の見本が無い");
    assert!(
        versions.contains(&STORE_VERSION),
        "今の版 ({STORE_VERSION}) の見本 store-v{STORE_VERSION}.json が無い"
    );
}
