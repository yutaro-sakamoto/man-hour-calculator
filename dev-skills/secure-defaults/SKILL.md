---
name: secure-defaults
description: 個人開発の Web アプリで、最初から安全側に倒しておく既定。innerHTML を使わない DOM の作り、利用者の文字列を扱う経路、API トークンのハッシュ保存、CORS を既定で拒否、外部への通信を増やさない、依存を増やさない方針、npm audit / cargo audit、秘密を読ませない権限設定。認証や XSS、依存や CORS の方針を決めるときに読む。XSS, innerHTML, textContent, token hashing, CORS, dependency audit, secrets, secure defaults.
---

# 安全側の既定

あとから直すのが高いものを、最初に決めておく。
**「今は要らない」で外したものは、要るようになったときには入らない。**

## 1. HTML の文字列を組み立てない

**`innerHTML` を使わない。** 文字は必ず `textContent` に入れる。
タスク名もコメントも利用者が書いた文字列で、そこに何が書かれていても
スクリプトになってはいけない。

lint で禁止し、`.claude/rules/` にも書く。**禁止だけでは足りない**ので、
文字列を受け取る API を作らないところまでやる。

- Markdown は木に解いてから DOM を生やす
- グラフの吹き出しは**部品**を受け取る。文字列を受け取る形に戻さない —
  戻すと「名前をそのまま差し込む」書き方ができてしまう
- 画像は自前の綴り (`attachment:`) だけ許す。**外の URL を画像にしない**
  (開いただけでそこへ取りに行くことになる)

最後の 2 つが肝。**「危ない書き方ができない形」にする**と、レビューが要らなくなる。

## 2. 外へ通信しない (できるなら)

外部のアイコン・フォント・画像を足さない。`fetch()` を増やさない。
**E2E で「`file://` 以外へのリクエストが 1 件でもあれば落ちる」**を見張る
([single-file-web-app](../single-file-web-app/))。

口で禁止するより強い。足した瞬間に赤くなる。

素の `<a>` は押すまで通信しないので置いてよい。

## 3. トークンは平文を保存しない

```rust
// 発行のときに一度だけ表に出し、保存するのは SHA-256 のハッシュ。
// 漏れた保存先からトークンは戻せない。256 ビットの乱数なので総当たりも効かない。
pub fn fingerprint(secret: &str) -> String {
    to_hex(&Sha256::digest(secret.as_bytes()))
}
```

- **暗号に触るファイルを 1 つに閉じ込める。** API 層には持ち込まない。
  API 層は「呼び出し元は既に特定されている」前提で書く
- 発行は**API に置かず CLI に置く**。「配る権限を持つ人」を API の外に
  置いておきたい
- **重なった認証ヘッダを断る。** `Authorization` が 2 つ来たときに
  片方だけ見ると、通す気のないものが通る
- 「最後に使った日」の更新は 1 日 1 回に抑える。読み取りのたびに書き込みが走る

## 4. CORS は既定で拒否

```rust
/// 別の場所に置いた画面から API を呼ぶことを許す (繰り返し指定できる)。
/// 省略すると、**どこからも許さない**。
#[arg(long = "allow-origin", value_name = "ORIGIN")]
pub allow_origins: Vec<String>,
```

サーバが自分で配る画面を開くぶんには同一オリジンなので、既定では要らない。
**必要な人だけが明示的に開ける。** 読めない出どころは警告を出して無視する。

## 5. 依存を増やさない

- コアと API の**依存クレートはゼロ** (シリアライズ 1 つだけ)。
  外のクレートを使うのはサーバだけ
- base64 のような小物は 30 行書く。**RFC のテストベクタを固定する**
- `#![forbid(unsafe_code)]`。`unsafe` は FFI 層だけ

依存が少ないと、SBOM も脆弱性走査も「読める量」になる。
**読めない量の依存表は、あっても見ない。**

```yaml
- run: npm audit --audit-level=moderate   # CI 毎回
- run: cargo audit --json > out/audit.json || true   # リリース時。止めない
```

Dependabot は `github-actions` と各エコシステムに入れる。

## 6. 保存はいつでも失敗しうる

`localStorage` は容量不足やプライベートモードで書けない。**返り値を捨てない。**
黙って捨てると、利用者は成功したと思ったまま全部失う。

サーバ側の書き込みは**原子的に**する (一時ファイル → rename)。
途中で落ちたときに半端なファイルが残らないように。

## 7. 秘密をエージェントに読ませない

```json
"deny": ["Read(./.env)", "Read(./.env.*)", "Bash(git push --force:*)"]
```

`ask` には外に出るもの (merge / release / push)。
詳しくは [agent-ready-repo](../agent-ready-repo/)。

## 8. 入力は 1 項目ずつ確かめる

外から読み込んだ JSON / CSV は 1 項目ずつ型を確かめ、駄目なものは既定値に
落とす。**まとめて `as` でキャストしない。**

TypeScript は `strict` に加えて `noUncheckedIndexedAccess` と
`exactOptionalPropertyTypes` まで有効にする。配列の添字アクセスが
`T | undefined` になるので、外来データの扱いが一段安全になる。

## 9. 落ちても止まらない

1 つのリクエストが panic しても、そのリクエストが 500 になるだけで
プロセスは落ちないようにする (`CatchPanicLayer` + `panic = "unwind"`)。

**計算の入口は panic しない設計にする。** 入力の不正はすべてステータス
コードで返す。FFI の向こうで panic すると、何が起きたか分からない形で死ぬ。

## 関連

- リリース成果物 (SBOM/SLSA) → [release-supply-chain](../release-supply-chain/)
- 権限の不変条件 → [verification-ladder](../verification-ladder/)
