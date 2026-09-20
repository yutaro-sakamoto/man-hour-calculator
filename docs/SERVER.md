# サーバを建てる

複数人で使うときだけ必要。**1 人で使うなら建てなくてよい** —
`dist/app.html` をブラウザで開けば、同じものがオフラインで動く。

## 何が要るか

**バイナリ 1 つだけ。** SQLite も画面 (HTML) もバイナリのなかに入っている。
データベースを先に用意する必要も、Web サーバを別に立てる必要もない。

```sh
cargo build --profile server -p mhc-server
./target/server/mhc-server
```

```text
管理者「管理者」(admin) を作りました。

  トークン: 368ad89c8b56e5e6fd3f921271c89c1bdd97c9757b379887a7c5bba2d87dcfd6

この 1 回しか表示されません。控えてください。
失くしたら: mhc-server token create --user admin

保存先: sqlite:mhc.db
待ち受け: http://127.0.0.1:8080
```

ブラウザで `http://127.0.0.1:8080` を開けば画面が出る。

> 画面を埋め込むには、サーバを組み立てる**前に** `cargo xtask build` を
> 走らせて `dist/app.html` を作っておく。無いまま組み立てると、
> API は動くが画面の代わりに案内ページが出る。

## 起動のしかた

```sh
mhc-server                                        # 既定: sqlite:mhc.db / 127.0.0.1:8080 / トークン認証
mhc-server --listen 0.0.0.0:8080                  # 他の端末からも繋ぐ
mhc-server --db postgres://user:pw@host/mhc       # PostgreSQL に保存する
mhc-server --auth header --auth-header X-Forwarded-User   # SSO の後ろに置く
mhc-server --auth none                            # 手元で試すときだけ
mhc-server --ui ./dist/app.html                   # 埋め込みではなくファイルを配る
mhc-server --allow-origin https://example.github.io       # 別の場所の画面から呼ぶ
```

| 項目 | 既定 | 備考 |
|---|---|---|
| `--db` | `sqlite:mhc.db` | `sqlite:<path>` / `postgres://…`。素のパスも可 |
| `--listen` | `127.0.0.1:8080` | **既定では外に出さない**。外に出すときだけ変える |
| `--auth` | `token` | `token` / `header` / `none` |
| `--admin-id` | `admin` | 最初に作る管理者 |
| `--allow-origin` | (なし) | 別の場所に置いた画面から呼ぶときだけ。繰り返し指定できる |

## 認証

### `token` (既定)

`Authorization: Bearer <トークン>` を見る。

```sh
mhc-server token create --user alice --label "佐藤のノート PC"
mhc-server token list      # 平文は出ない (ハッシュしか保存していない)
mhc-server token revoke <id>
```

保存するのは SHA-256 のハッシュだけで、**平文は発行のときに一度しか出ない**。
保存先が漏れてもトークンは戻せない。失くしたら作り直す。

トークンの発行を HTTP の API に置いていないのは意図的で、
「サーバに入れる人だけがトークンを配れる」という境界をそのまま使うため。

### `header`

前段 (リバースプロキシや SSO) が入れたヘッダのアカウント id を信じる。

```
mhc-server --auth header --auth-header X-Forwarded-User
```

**そのヘッダを必ず上書きする前段の後ろに置くこと。** 直接インターネットに
晒すと、ヘッダを自分で付けるだけで誰にでもなりすませる。
アカウントは先に作っておく必要がある (自動では作らない)。

### `none`

繋いだ全員が管理者として操作できる。起動時に警告が出る。手元で試すとき専用。

## 別の場所に置いた画面から呼ぶ

サーバが自分で配る画面 (`http://…:8080/`) を開くぶんには、**何も要らない**。
同じ出どころなのでブラウザは黙って通す。これが普通の使い方。

GitHub Pages に置いた HTML や、手元に保存した 1 枚の HTML
(`file://`) から社内サーバを呼びたいときだけ、その出どころを挙げる。

```sh
mhc-server --allow-origin https://example.github.io
mhc-server --allow-origin null            # file:// から開いた HTML
```

省略すると**どこからも許さない**。`*` は用意していない — トークンを載せる
API を誰からでも呼べるようにする理由が無いため。

> `null` は `file://` で開いたページの出どころだが、**サンドボックスの
> iframe など別のものも `null` を名乗る**。手元で試すとき以外には使わないこと。

画面側は「サーバへの接続先」に URL とトークンを入れる。サーバが配る画面なら
URL は既に入っている。繋がらなければローカルに戻り、理由が出る。

## 保存先

### SQLite

既定。`rusqlite` を `bundled` で使っているので、SQLite 本体もバイナリに入る。
置いた先に何も入れなくてよい。バックアップはファイルを 1 つ (と WAL) 取るだけ。

### PostgreSQL

```sh
mhc-server --db postgres://user:pw@host/mhc
```

表は起動時に作られる。`schema_version` に版が 1 行だけ入っていて、
足りない段だけが当たる。**古いデータベースを新しいバイナリで開ける**。
逆 (新しいデータベースを古いバイナリで開く) は、気づいて止まる。

手元で PostgreSQL 版を試すには:

```sh
docker run -d -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17
MHC_TEST_POSTGRES_URL=postgres://postgres:pw@localhost/postgres cargo test -p mhc-server
```

この変数が無ければ、PostgreSQL のテストは黙って飛ばす。CI には
PostgreSQL を立てたジョブがあるので、方言の食い違いはそこで捕まる。

## 何をしていて、何をしていないか

**している**

- データの置き場所
- 呼び出し元の特定 (トークン / ヘッダ)
- 書き込みの直列化 — 「読む → 判定 → 書く」のあいだ、他の書き込みを入れない。
  これで「所有者が 1 人もいなくならない」などの条件が競合で破れない

**していない**

- **見積もりの計算**。計算はクライアントの WASM がその場で回す。
  サーバを増やさなくても人数が増やせるし、オフラインで動く性質も保てる
- **権限の判定**。`crates/api` の `Service` にあり、ローカルでもサーバでも
  同じ実装を通る。ここに書き足すものは無い

## 運用

- `GET /healthz` は認証なしで答える (`{"status":"ok","api":…,"schema":…}`)。
  死活監視やロードバランサの検査に使う
- ログは `tracing`。`RUST_LOG=debug` などで細かくできる
- Ctrl-C で、処理中のリクエストを終えてから止まる
- 1 つのリクエストが panic しても、そのリクエストが 500 になるだけで
  プロセスは落ちない (`CatchPanicLayer` と `panic = "unwind"`)

## 将来: AWS に置く

`Store` の後ろを差し替えれば、API Gateway + Lambda + DynamoDB でも動く形に
してある (`project_metas()` が中身を読まないのはそのため)。
構成と手順は [AWS.md](AWS.md) に書いてある (実装はまだ)。
