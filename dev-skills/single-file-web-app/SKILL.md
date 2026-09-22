---
name: single-file-web-app
description: ダウンロードして開くだけで動く「1 枚の HTML」としてアプリを配るときのビルド設計。WASM を base64 で埋め込む理由、file:// で E2E を回して外部通信 0 件を見張るやり方、サイズ予算、wasm-opt のバージョン地雷。単一 HTML 配布、オフライン動作、静的サイト配布、GitHub Pages 公開を考えるときに読む。single file HTML, offline app, wasm embed, esbuild, no-server distribution.
---

# 1 枚の HTML で配る

「**ダウンロードしてダブルクリックすれば動く**」を要件として立てると、
インストール・サーバ・アカウントが全部要らなくなる。趣味のアプリで
最初に人に触ってもらうには、これが一番速い。

要件として立てた以上、**毎回検査する**。立てただけだと 3 回のコミットで壊れる。

## 組み立ての形

```text
web/index.html.template
  ├─ /*{{CSS}}*/         ← esbuild でまとめた CSS
  ├─ /*{{APP_JS}}*/      ← esbuild でまとめた JS (TypeScript から)
  └─ /*{{WASM_BASE64}}*/ ← .wasm を base64 にしたもの
          ↓  cargo xtask build
      dist/app.html   (これ 1 枚)
      dist/index.html (紹介ページ)
```

ビルドスクリプトは**言語を増やさず**に書く。Rust のプロジェクトなら
`cargo xtask` (ワークスペース内の普通のバイナリクレート)。`assets/xtask-build.rs`
に骨を置いてある。

## なぜ base64 で埋め込むのか

`file://` で開いたページからの `fetch()` は CORS で弾かれる。`.wasm` を別
ファイルにすると、**ローカルで開いた瞬間に動かない**。base64 でソースに
焼き込むしかない。

3 割ほど太るが、HTTP 配信なら gzip でほぼ相殺される。`file://` では
単に 1 ファイル。

外部クレートを足さずに済ませたいので、base64 の実装は 30 行書く。
**RFC 4648 のテストベクタを固定する**テストを付ける (空・`f`・`fo`・`foo`…)。

## インライン `<script>` の逃がし

埋め込む JS に `</script` が現れるとそこでタグが閉じる。**必ず置換する。**

```rust
fn escape_for_inline_script(content: &str) -> String {
    content.replace("</script", "<\\/script")
}
```

JavaScript では `</script` は文字列か正規表現リテラルの中にしか現れえず、
`<\/script` と書いても同じ文字列になるので、機械的に置換してよい。

## サイズ予算を置く

上限を定数で 1 つ置き、超えたらビルドを失敗させる。

```rust
const SIZE_BUDGET_BYTES: usize = 896 * 1024;
```

数字そのものより、**なぜその数字か**をコメントに書くほうが大事。
man-hour-calculator では「API 層を Rust に置いて serde_json が入り、
75 KiB → 330 KiB → 433 KiB と増えた。権限判定をローカルとサーバで
1 実装に保つための代償」と書いてある。次に増やすときの判断材料になる。

**最適化をかけたときだけ上限を見る。** `wasm-opt` の無い手元のビルドで
引っかかっても直しようがない。

## wasm-opt の地雷 (2 回踏んだ)

1. **apt の binaryen を使わない。** 古くて、rustc が既定で出す sign-ext
   命令を検証で弾く。公式リリースを**バージョン固定**で取ってくる
2. **`-all` を付ける。** 個別に機能フラグを並べると、binaryen を上げ下げする
   たびにビルドが壊れる (`bulk-memory` が `bulk-memory` と `bulk-memory-opt`
   に分かれた、など)

```sh
wasm-opt -Oz -all input.wasm -o output.wasm
```

3. **CI では `--require-wasm-opt` を立てる。** `wasm-opt` が見つからなかった
   ときに黙って最適化を飛ばすと、**最適化の外れた配布物が静かに出る**。
   手元では任意、CI では必須にする

## E2E で「配布の形そのもの」を検査する

`dist/app.html` を **`file://` で開く**。http サーバを立てない。
立てた瞬間に、検査したい要件が検査できなくなる。

```js
// 外部へのリクエストと、ページ内の例外を数える。
// どちらも 0 でなければ落とす。
page.on("request", (r) => {
  if (!r.url().startsWith("file://") && !r.url().startsWith("data:")) {
    external.push(r.url());
  }
});
page.on("pageerror", (e) => errors.push(e));
```

これがあると「アイコンを CDN から取る」「Google Fonts を足す」が
**入れた瞬間に赤くなる**。口で禁止するより強い。

### E2E を書くときの約束

- 位置ではなく**名前**で引く (`title`、`data-*`)。列が 1 つ増えるたびに
  壊れる書き方にしない
- 値は表示の文字列ではなく `data-*` の素の値を見る
- 計算が一巡するのを待つ。`waitForTimeout` で誤魔化さない
- **時計を固定する。** 実行した日で結果が変わるテストは、ある朝に落ちる
- 回す前に必ず `dist/` を作り直す。作り直さずに回して「直したはずが直って
  いない」に見え、時間を溶かした

## 紹介ページを入口に置く

`dist/index.html` (紹介) と `dist/app.html` (道具) を分ける。GitHub Pages の
ルートは紹介ページ。

いきなり道具が開くと「これは何なのか」「どこまで信用してよいのか」が
分からない。紹介ページのボタンから道具に入る形にすると、**そのページに
フィードバック導線・ソースへのリンク・「通信しません」の説明**が置ける
([ux-and-feedback](../ux-and-feedback/))。

紹介ページは**組み立てない**。書き換えるものが無いので、そのまま `dist/` に
コピーするだけにする。ビルドの段を増やさない。

## GitHub Pages への配り方

成果物が 1 枚の HTML なら、`dist/` をそのまま Pages に上げれば公開版になる。
**E2E まで通ったものだけを配る**ように、ジョブの `needs` を繋ぐ。

```yaml
pages:
  if: github.ref == 'refs/heads/main' && github.event_name == 'push'
  needs: e2e            # ここが肝
  permissions: { pages: write, id-token: write }
```

## 関連

- CI への組み込み → [ci-quality-gates](../ci-quality-gates/)
- 画面側の約束 (innerHTML 禁止など) → [secure-defaults](../secure-defaults/)
