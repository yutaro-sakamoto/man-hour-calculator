#!/usr/bin/env node
/**
 * Release に載せる説明を組み立てる。
 *
 * 置いてあるファイルから本文を作るので、添え忘れたものが本文にだけ
 * 載っている、ということが起きない。
 */

import { readdirSync } from "node:fs";

const version = process.argv[2] ?? "unknown";
const files = readdirSync("out").sort();

const isPrerelease = version.includes("-");

/** 配布物を、受け取る側が選びやすい順に並べる。 */
const platforms = [
  ["x86_64-unknown-linux-gnu", "Linux (x86_64)", "ふつうの Linux。まずこれ"],
  [
    "x86_64-unknown-linux-musl",
    "Linux (x86_64, 静的)",
    "glibc の版に縛られません。古い環境向け",
  ],
  [
    "aarch64-unknown-linux-gnu",
    "Linux (arm64)",
    "Apple Silicon の VM、Graviton など",
  ],
  ["aarch64-unknown-linux-musl", "Linux (arm64, 静的)", "同上。静的リンク"],
  ["x86_64-pc-windows-msvc", "Windows (x64)", ""],
  ["aarch64-pc-windows-msvc", "Windows (arm64)", ""],
];

const rows = platforms
  .map(([target, label, note]) => {
    const file = files.find((name) => name.includes(target));
    return file === undefined ? null : `| ${label} | \`${file}\` | ${note} |`;
  })
  .filter((row) => row !== null);

const html = files.find((name) => name.startsWith("man-hour-calculator-"));
const sboms = files.filter((name) => name.includes(".cdx.json"));
const audit = files.find((name) => name.startsWith("audit-"));
const deps = files.find((name) => name.startsWith("DEPENDENCIES-"));

// 省くものは `null` にする。空文字で表すと、本文の中の**意味のある空行**
// (コードブロックの中など) まで一緒に落ちてしまう。
const out = [
  isPrerelease
    ? [
        "> [!WARNING]",
        "> **これは開発中の前リリースです。**",
        ">",
        "> 仕様も保存形式も、予告なく変わります。**本番の見積もりには使わないでください。**",
        "> 試してみて気づいたことがあれば、",
        "> [Issue](https://github.com/yutaro-sakamoto/man-hour-calculator/issues/new) に",
        "> 書いてもらえると助かります。",
        "",
      ].join("\n")
    : null,
  "## ローカル版 (インストール不要)",
  "",
  html === undefined
    ? "_今回は含まれていません。_"
    : [
        `\`${html}\` をダウンロードしてダブルクリックするだけです。`,
        "サーバも、インストールも、ネットワークも要りません。**1 枚の HTML で完結**していて、",
        "計算コアは Rust を WebAssembly にしたものが同じファイルに埋め込まれています。",
        "",
        "書いた内容はブラウザのなかにだけ残ります。ファイルに書き出して持ち運べます。",
      ].join("\n"),
  "",
  "## サーバ版 (複数人で使う)",
  "",
  rows.length === 0
    ? "_今回は含まれていません。_"
    : [
        "単体のバイナリです。展開して実行するだけで、同梱の SQLite に保存します。",
        "PostgreSQL にも繋げます (`docs/SERVER.md`)。",
        "",
        "| 環境 | ファイル | |",
        "|---|---|---|",
        ...rows,
        "",
        "```sh",
        "./mhc-server --db sqlite:./mhc.db --listen 127.0.0.1:8080",
        "```",
        "",
        "初回の起動で管理者とトークンが 1 回だけ表示されます。控えてください。",
      ].join("\n"),
  "",
  "## 中身を確かめる",
  "",
  "```sh",
  "# 壊れていないか",
  "sha256sum -c SHA256SUMS",
  "",
  "# 本当にこのリポジトリの CI が作ったものか (GitHub が署名しています)",
  "gh attestation verify <ファイル> --repo yutaro-sakamoto/man-hour-calculator",
  "",
  "# バイナリに埋まっている依存を読む",
  "cargo audit bin mhc-server",
  "```",
  "",
  "| 添えてあるもの | 何か |",
  "|---|---|",
  "| `SHA256SUMS` | 全ファイルのハッシュ |",
  ...sboms.map(
    (name) =>
      `| \`${name}\` | SBOM (CycloneDX 1.5)。何が入っているかの機械可読な一覧 |`,
  ),
  audit === undefined
    ? null
    : `| \`${audit}\` | 既知の脆弱性の走査結果 (\`cargo audit\`) |`,
  deps === undefined ? null : `| \`${deps}\` | 依存とライセンスの一覧 |`,
  "| 出所証明 | SLSA provenance。この Release の「Attestations」から辿れます |",
  "",
  "ローカル版の HTML には、上の表に出てくる依存は **1 つも入っていません**。",
  "計算コアは依存クレートゼロの Rust で、JavaScript 側の依存もビルド時だけのものです。",
  "",
  "## 中身はどうやって確かめているか",
  "",
  "- **有界モデル検査 (Kani)** — 11 個の不変条件を、区間の*すべての*入力について証明",
  "- **モデル検査 (TLA+ / TLC)** — 権限の設計を、到達しうるすべての状態で検査",
  "- **miri** — FFI 層の未定義動作",
  "- 単体・性質・差分・E2E テストと、ミューテーションテスト",
  "",
  "詳しくは [`docs/VERIFICATION.md`](https://github.com/yutaro-sakamoto/man-hour-calculator/blob/main/docs/VERIFICATION.md)。",
]
  .filter((line) => line !== null)
  .join("\n");

console.log(out);
