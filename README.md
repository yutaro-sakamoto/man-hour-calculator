# 工数見積もり / Effort Estimator

タスクごとの **3 点見積もり（最小・最可能・最大）** から、**総工数の確率分布**を求めるツールです。

「各タスクの最可能値を足す」という見積もりは、ほぼ必ず過小評価になります。
遅れは足し合わさるのに、前倒しはめったに起きないからです。
このツールは各タスクを確率分布として扱い、その和の分布を計算して
「P80 で何人日か」「N 人日以内に収まる確率は何 % か」を答えます。

成果物は **HTML ファイル 1 枚**です。ダウンロードしてダブルクリックすれば動きます。
サーバも、インストールも、ネットワークも要りません。

```
タスク       最小  最可能  最大
要件定義       5     8     20
API 実装       2     3      5
画面実装      10    15     40
                 ─────────────
最可能値の合計         26 人日
P80                  35.8 人日   ← 実際に約束できるのはこちら
```

## 使う

[Releases](../../releases) の `index.html` をダウンロードして、ブラウザで開くだけです。
自分でビルドする場合は次章へ。

- タスクを入力すると即座に再計算されます
- **分布**: PERT（ベータ）/ 三角分布
- **エンジン**: モンテカルロ / 数値畳み込み（切り替えて結果を突き合わせられます）
- 日本語 / English 切り替え
- ダークモードは OS の設定に追従します

## ビルド

```sh
cargo xtask build          # → dist/index.html
```

必要なもの:

- Rust 1.92 以降（`rust-toolchain.toml` が `wasm32-unknown-unknown` も含めて面倒を見ます）
- 任意: [binaryen](https://github.com/WebAssembly/binaryen) の `wasm-opt`
  （あれば HTML が 147 KiB → 133 KiB になります。無くてもビルドは通ります）

  なお `wasm-opt` には `-all` を渡しています。rustc が wasm32 向けに既定で出す
  sign-ext などの命令を、binaryen の既定の許可集合が受け付けないためです
  （許可される機能の内訳は binaryen のバージョンごとに変わるので、
  個別フラグを並べるより全許可のほうが壊れません）。CI では
  `--require-wasm-opt` を付けて、最適化が静かに外れた配布物が出ないようにしています。

外部クレートへの依存はゼロです。

## 検証

```sh
cargo test --workspace                                  # 単体テストと性質テスト
cargo clippy --workspace --all-targets -- -D warnings
cd e2e && npm ci && npx playwright test                 # file:// で開いて E2E
```

E2E は `dist/index.html` を **`file://` で開いて**検査します。
「1 枚の HTML でオフラインで動く」という前提そのものを毎回確かめるためで、
外部へのリクエストが 1 件でも飛んだらテストは落ちます。

## しくみ

```
              ┌──────────── dist/index.html（1 ファイル） ────────────┐
 cargo xtask  │  <style> …CSS… </style>                              │
    build ──▶ │  <script> const WASM_BASE64 = "AGFzbQ…";  …JS…        │
              │  WebAssembly.instantiate(atob(WASM_BASE64))           │
              └──────────────────────────────────────────────────────┘
                                    ▲
                crates/wasm   ─ 薄い FFI 層（unsafe はここだけ）
                                    ▲
                crates/core   ─ 計算ロジック（#![forbid(unsafe_code)]）
```

`fetch()` を一切使わないのは、`file://` で開いたページからの `fetch()` が
CORS で弾かれるためです。WASM は base64 文字列として HTML に埋め込んでいます。

| ディレクトリ | 中身 |
|---|---|
| `crates/core` | 分布・乱数・2 つのエンジン・統計・ABI。純粋な計算だけ |
| `crates/wasm` | `alloc` / `dealloc` / `compute` だけの FFI 層 |
| `crates/xtask` | `dist/index.html` を組み立てるビルドツール |
| `web` | HTML テンプレート・CSS・JS（ライブラリ不使用） |
| `e2e` | Playwright による `file://` テスト |
| `docs/ABI.md` | JS ↔ WASM のバッファレイアウト仕様 |

### 分布

3 点見積もり `(a, m, b)` に当てはめる分布は 2 つ選べます。

- **PERT（ベータ）** — 実務で標準的。平均は `(a + λm + b) / (λ + 2)`（既定 `λ = 4` で
  おなじみの `(a + 4m + b) / 6`）。閉形式の逆関数がないので、ベータ PDF を数値積分して
  CDF グリッドを作り、そこから逆 CDF テーブルを前計算します。累積和から作るため、
  テーブルの単調性と両端（ちょうど `a` と `b`）が構成上保証されます。
- **三角分布** — CDF もその逆関数も閉形式。両端が厚いぶん PERT よりばらつきが大きく出ます。

### 2 つのエンジン

| | モンテカルロ | 数値畳み込み |
|---|---|---|
| やること | 各タスクから乱数サンプリングして合計、を繰り返す | 各タスクの分布を共通グリッド上で逐次畳み込む |
| 乱数 | xoshiro256++（シード固定で完全に再現可能） | 使わない |
| 誤差 | サンプリング誤差が残る | 離散化誤差のみ。決定論的 |
| 相関 | 対応予定（M2） | 独立性を仮定するため非対応 |

**2 つを別々に実装しているのは、互いのオラクルにするためです。**
片方だけにあるバグはもう片方を通らないので、
「両エンジンの P50 / P80 / P90 がレンジの 1% 以内で一致する」というテストが、
数値コアの正しさを実質的に担保します（`crates/core/src/convolve.rs` のテスト）。

## 品質のつくり方

- `crates/core` は `#![forbid(unsafe_code)]`。`unsafe` は `crates/wasm` の FFI 層だけ
- `TaskEstimate` は smart constructor（parse, don't validate）。値が存在する時点で
  `0 <= min <= likely <= max` かつ有限であることが型で保証される
- `compute` は panic しない。入力の不正はすべてステータスコードで返す
- 逆 CDF テーブルの単調性、CDF の単調性、ヒストグラム確率の非負性、
  レスポンス長とヘッダ宣言の一致などを、ランダム入力を含むテストで検査

## これから（ロードマップ）

- **M2 — 形式検証と分析**
  - [Kani](https://model-checking.github.io/kani/) による有界モデル検査（整数・添字・ビット演算領域）
  - proptest による性質検査（浮動小数点領域）と、不変条件 ⇔ 検証手段の追跡表（`docs/VERIFICATION.md`）
  - `cargo miri` で FFI 層の未定義動作検査
  - タスク間相関（単一ファクター・ガウシアンコピュラ）と感度分析の UI
- **M3 — 永続化と仕上げ**
  - localStorage への自動保存、JSON / CSV の入出力
  - タグ push で `dist/index.html` を Release に添付

## ライセンス

MIT
