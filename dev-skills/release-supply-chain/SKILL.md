---
name: release-supply-chain
description: タグ push で配布物を組み立てて公開するリリースパイプライン。クロスプラットフォームのバイナリ (Linux/Windows × x86_64/aarch64、musl 静的リンク)、SBOM (CycloneDX)、依存とライセンスの一覧、脆弱性走査、SHA256SUMS、SLSA の出所証明 (attest-build-provenance)、cargo-auditable。配布物を出すとき、サプライチェーンの成果物を添えるときに読む。release pipeline, cross-platform binary, SBOM, SLSA provenance, attestation, musl, supply chain.
---

# 配布物とサプライチェーンの成果物

`v*.*.*` のタグを push したら全部できる。**手で作る工程を残さない。**
骨は `assets/release.yml`。

添えるもの:

- サーバの単体バイナリ (Windows / Linux × x86_64 / aarch64)
- ローカル版の 1 枚 HTML
- **SBOM (CycloneDX)**、依存とライセンスの一覧、脆弱性の走査結果
- **`SHA256SUMS`** と、**署名された出所証明 (SLSA provenance)**

## 先に版を突き合わせる

タグと `Cargo.toml` の版が食い違ったまま配らない。**最初のジョブで落とす。**

```sh
version="${GITHUB_REF_NAME#v}"
base="${version%%-*}"
cargo_version="$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)"
[ "$base" = "$cargo_version" ] || { echo "::error::タグと Cargo.toml の版が違います"; exit 1; }
case "$version" in *-*) pre=true ;; *) pre=false ;; esac   # v0.1.0-alpha.1 は prerelease
```

## タグを打つ前に試す道を作る

`workflow_dispatch` の `dry_run` で、**Release を作らずに組み立てだけ**通す。
タグは打ち直せないので、これが無いと本番で初めて失敗する。

## クロスプラットフォーム

### 実機で組む (クロスコンパイルにしない)

SQLite を同梱ビルドすると C コンパイラが要り、クロスは途端に面倒になる。
GitHub の runner に arm64 があるので、**その CPU の実機で組む**ほうが速くて確実。

```yaml
matrix:
  include:
    - { os: ubuntu-latest,    target: x86_64-unknown-linux-gnu,   ext: "" }
    - { os: ubuntu-latest,    target: x86_64-unknown-linux-musl,  ext: "" }
    - { os: ubuntu-24.04-arm, target: aarch64-unknown-linux-gnu,  ext: "" }
    - { os: ubuntu-24.04-arm, target: aarch64-unknown-linux-musl, ext: "" }
    - { os: windows-latest,   target: x86_64-pc-windows-msvc,     ext: ".exe" }
    - { os: windows-11-arm,   target: aarch64-pc-windows-msvc,    ext: ".exe" }
```

`fail-fast: false`。1 つの target が落ちても他は組ませる。

**musl 版を必ず入れる。** 静的リンクになるので glibc の版に縛られず、
古いディストリビューションでもそのまま動く。「動きません」の問い合わせが
いちばん減る 1 行。

### 組んだその場で動かす

**動かないものは配らない。** 起動 → `/healthz` → 画面が**本物**であること
(仮ページを抱えたまま配らない) まで見る。

```sh
# 保存先は**作業ディレクトリからの相対**にする。Windows の bash で mktemp -d が
# 返す /tmp/... は、Rust から見るとドライブの無い読めない綴りになり起動しない。
"$bin" --db sqlite:./smoke.db --listen 127.0.0.1:8080 > server.log 2>&1 &
server_pid=$!
for _ in $(seq 30); do
  curl -sf localhost:8080/healthz > /dev/null && { ok=yes; break; }
  # 起動に失敗していたら待つだけ無駄。理由を出して止める。
  kill -0 "$server_pid" 2> /dev/null || break
  sleep 1
done
[ -n "${ok:-}" ] || { echo "::error::サーバが応答しません"; cat server.log; exit 1; }
```

### 画面を埋め込むなら、先に作る

サーバが HTML をバイナリに取り込む形なら、`server` ジョブは `html` ジョブに
`needs` で依存させる。**忘れると「画面がまだ埋め込まれていません」の仮ページを
抱えたものを配る。**

## サプライチェーンの成果物

### cargo-auditable — バイナリの中に依存表を埋める

```yaml
- uses: taiki-e/install-action@v2
  with: { tool: cargo-auditable }
- run: cargo auditable build --profile server -p <<<server>>> --target ${{ matrix.target }}
```

手元に届いたあとでも `cargo audit bin <binary>` で調べられる。**受け取る側が
自分で確かめられる**のが利点。

### SBOM (CycloneDX)

```sh
cargo cyclonedx --all --format json --spec-version 1.5
# crate ごとに出るので 1 つにまとめる
node .github/scripts/merge-sbom.mjs "out/sbom-rust-${VERSION}.cdx.json"

npm --prefix web ci
(cd web && npm sbom --sbom-format cyclonedx > "../out/sbom-web-${VERSION}.cdx.json")
```

**npm 側に `--omit dev` を付けない。** ビルド時だけの依存でも
「何で組み立てたか」こそが知りたいことで、付けると中身が空になる
(実際に空の SBOM を配った)。**件数が 0 なら落とす検査を入れる。**

### 脆弱性走査は止めない

```sh
cargo audit --json > "out/audit-${VERSION}.json" || true
```

見つかっても**リリースを止めない**。結果を添えるのが目的で、止める判断は
受け取る側がする。

### 依存とライセンスの一覧

人が読む `DEPENDENCIES-<version>.md` を作る。**`CARGO_TERM_COLOR: never` を
立てる** — 色のエスケープが文書に混ざる (踏んだ)。

「配布物にはこの表のものは入っていません」のような、**どの成果物に効く話かを
先頭に書く**。書かないと全部が入っていると読まれる。

### SHA256SUMS と SLSA provenance

```yaml
- run: |
    find staging -type f -exec cp {} out/ \;
    cd out && sha256sum * > SHA256SUMS

# 「この成果物は、このリポジトリのこのワークフローが作った」ことを署名付きで残す。
- uses: actions/attest-build-provenance@v4
  with:
    subject-path: |
      out/*.tar.gz
      out/*.zip
      out/*.html
```

`permissions: { contents: write, id-token: write, attestations: write }` が要る。
受け取った側は `gh attestation verify <file> --repo <owner>/<repo>` で確かめられる。

## Release ノート

生成するスクリプトを 1 本置く (`.github/scripts/release-notes.mjs`)。
**「どのファイルを取ればよいか」を最初に書く。** 6 つのアーカイブと
SBOM と HTML が並んだ画面は、初めて見る人には読めない。

- 「ふつうはこれ」を 1 行で (Linux なら musl の x86_64)
- 1 枚 HTML は**ダウンロードして開くだけ**であることを書く
- 検証の手順 (`sha256sum -c`、`gh attestation verify`) を書く

## 関連

- CI の段 → [ci-quality-gates](../ci-quality-gates/)
- 認証・依存の方針 → [secure-defaults](../secure-defaults/)
