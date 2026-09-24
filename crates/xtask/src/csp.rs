//! 配布する HTML に Content-Security-Policy を差し込む。
//!
//! 画面は「文字は必ず textContent に入れる」ことで XSS を防いでいる
//! (ESLint が innerHTML を禁じ、E2E が全欄に HTML を書いて確かめる)。
//! CSP はその**一段外側の網**で、どこかで HTML を組み立ててしまっても、
//! 差し込まれた `<script>` やイベント属性 (`onerror=`) を**ブラウザが走らせない**。
//!
//! スクリプトはすべてインラインなので `'unsafe-inline'` を使わず、
//! **組み立て終わった中身の SHA-256 を名指しする。** 1 バイトでも違う
//! スクリプトは走らない。ハッシュはビルドのたびに計算し直すので、
//! 手で書き写す必要はない。
//!
//! `frame-ancestors` は `<meta>` では効かない。サーバから配るときは
//! 応答ヘッダで付ける (`crates/server/src/http.rs`)。

/// 道具本体 (`dist/app.html`) の方針。`{scripts}` にハッシュが入る。
///
/// - `wasm-unsafe-eval`: 同梱した WASM をコンパイルするのに要る。`eval` は許さない
/// - `style-src 'unsafe-inline'`: 画面は `style` 属性で位置を決めている。
///   スタイルからスクリプトは走らないので、ここは緩めてよい
/// - `img-src data: blob:`: 添付の画像とグラフの書き出し。外の URL は読まない
/// - `connect-src`: サーバに繋ぐとき、その接続先は利用者が決める。
///   `file://` で開いたときは何も通信しない (E2E が 0 件を見張っている)
pub const APP_POLICY: &str = "default-src 'none'; \
     script-src {scripts} 'wasm-unsafe-eval'; \
     style-src 'unsafe-inline'; \
     img-src data: blob:; \
     connect-src 'self' http: https:; \
     base-uri 'none'; form-action 'none'; object-src 'none'";

/// 紹介ページ (`dist/index.html`) の方針。言語の切り替えだけのスクリプト。
pub const LANDING_POLICY: &str = "default-src 'none'; \
     script-src {scripts}; \
     style-src 'unsafe-inline'; \
     img-src data:; \
     base-uri 'none'; form-action 'none'; object-src 'none'";

/// インラインの `<script>` の中身を、書かれた順に全部拾う。
///
/// `src` 付きのものは想定していない (1 枚の HTML に外のスクリプトは無い)。
/// 見つけたら失敗にして、方針の外に出たことに気づけるようにする。
fn inline_scripts(html: &str) -> Result<Vec<&str>, String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("<script") {
        let after = &rest[start..];
        let open_end = after
            .find('>')
            .ok_or_else(|| "閉じていない <script> があります".to_string())?;
        let tag = &after[..open_end];
        if tag.contains("src") {
            return Err(format!("外のスクリプトは想定していません: {tag}>"));
        }
        let body = &after[open_end + 1..];
        let close = body
            .find("</script>")
            .ok_or_else(|| "</script> が見つかりません".to_string())?;
        out.push(&body[..close]);
        rest = &body[close + "</script>".len()..];
    }
    Ok(out)
}

/// `policy` の `{scripts}` をハッシュで埋めて、`<meta charset>` の直後に差し込む。
///
/// **スクリプトより前に置く。** `<meta>` の CSP は、それより後に読まれた
/// ものにしか効かない。
pub fn inject(html: &str, policy: &str) -> Result<String, String> {
    let scripts = inline_scripts(html)?;
    if scripts.is_empty() {
        return Err("インラインのスクリプトが 1 つもありません".into());
    }
    let hashes = scripts
        .iter()
        .map(|body| {
            format!(
                "'sha256-{}'",
                crate::base64_encode(&sha256(body.as_bytes()))
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let content = policy.replace("{scripts}", &hashes);

    let charset = html
        .find("<meta charset")
        .ok_or_else(|| "<meta charset> が見つかりません".to_string())?;
    let end = charset
        + html[charset..]
            .find('>')
            .ok_or_else(|| "<meta charset> が閉じていません".to_string())?
        + 1;
    let first_script = html.find("<script").unwrap_or(html.len());
    if end > first_script {
        return Err("<meta charset> より前にスクリプトがあります".into());
    }
    Ok(format!(
        "{}\n<meta http-equiv=\"Content-Security-Policy\" content=\"{content}\">{}",
        &html[..end],
        &html[end..]
    ))
}

/// SHA-256 (FIPS 180-4)。ハッシュのためだけに依存を足さないための最小実装。
/// 正しさは下のテストで公式の検査値に当てている。
pub fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // 末尾に 1 ビット、0 で埋め、最後の 8 バイトにビット長。
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());

    for block in message.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(value);
        }
    }

    let mut out = [0u8; 32];
    for (chunk, word) in out.chunks_mut(4).zip(h) {
        chunk.copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// NIST の検査値 (FIPS 180-2 付録 B)。境界の 55/56/64 バイトも見る。
    #[test]
    fn sha256_matches_the_published_vectors() {
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&sha256(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(
            hex(&sha256(&[b'a'; 1_000_000])),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
        // 1 ブロックに収まる最後の長さと、収まらない最初の長さ。
        assert_eq!(
            hex(&sha256(&[b'a'; 55])),
            "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
        );
        assert_eq!(
            hex(&sha256(&[b'a'; 56])),
            "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
        );
    }

    #[test]
    fn every_inline_script_is_named_by_its_hash() {
        let html = "<html><head><meta charset=\"utf-8\"></head>\
                    <body><script>a()</script><script>b()</script></body></html>";
        let out = inject(html, "script-src {scripts}").unwrap();
        let a = crate::base64_encode(&sha256(b"a()"));
        let b = crate::base64_encode(&sha256(b"b()"));
        assert!(out.contains(&format!("'sha256-{a}' 'sha256-{b}'")), "{out}");
        // 差し込む場所はスクリプトより前。
        assert!(out.find("Content-Security-Policy").unwrap() < out.find("<script").unwrap());
    }

    #[test]
    fn an_external_script_is_refused() {
        let html = "<meta charset=\"utf-8\"><script src=\"https://x\"></script>";
        assert!(inject(html, "script-src {scripts}").is_err());
    }
}
