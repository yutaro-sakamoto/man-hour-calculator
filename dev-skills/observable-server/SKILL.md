---
name: observable-server
description: 単一バイナリのサーバに可観測性と運用の約束を入れる。認証なしの /healthz、tracing の既定フィルタとリクエストログの出しかた、graceful shutdown、panic をリクエスト単位に閉じ込める、起動時に何を標準出力へ出すか、運用の文書に何を書くか。サーバを作るとき、死活監視やログを決めるとき、「何をしていて何をしていないか」を書くときに読む。observability, healthz, tracing, RUST_LOG, graceful shutdown, catch panic, ops runbook.
---

# 可観測性と運用

1 人で運用するなら、**見るものを増やさない**。要るのは 3 つだけだった。

## 1. `/healthz` を認証なしで答えさせる

```rust
async fn healthz() -> Response {
    Json(serde_json::json!({
        "status": "ok",
        "api": API_VERSION,
        "schema": SCHEMA_VERSION,
    }))
    .into_response()
}
```

- **認証なし。** ロードバランサや監視から叩ける必要がある
- **版を返す。** 「どれが動いているか」が分かる。デプロイの確認がこれで済む
- CI とリリースのスモークテストでも同じ口を使う。**運用の道具とテストの道具を
  分けない**

## 2. ログは既定で静かに

```rust
tracing_subscriber::fmt()
    .with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info,tower_http=warn".into()),
    )
    .init();
```

**既定ではリクエストのログを出さない。** 個人が建てるサーバで、全リクエストが
流れ続けても読まない。見たいときだけ上げる。

```sh
RUST_LOG=info,tower_http=debug mhc-server
```

**この「既定では出ない」を運用文書に書く。** 書かないと「ログが出ない」と
騒ぐことになる (自分が)。

起動時の「保存先」「待ち受け」「管理者トークン」は `tracing` を通さず
**標準出力に直接**出す。フィルタの設定に関わらず必ず見える必要がある。

## 3. 止まりかたを決める

- Ctrl-C で、**処理中のリクエストを終えてから**止まる (graceful shutdown)
- 1 つのリクエストが panic しても、そのリクエストが 500 になるだけで
  プロセスは落ちない

```rust
.layer(tower_http::catch_panic::CatchPanicLayer::new())
.layer(tower_http::trace::TraceLayer::new_for_http())
```

`[profile.server]` で `panic = "unwind"` にする (`abort` だと
`CatchPanicLayer` が効かない)。

## 運用文書に「していないこと」を書く

`docs/SERVER.md` に**している / していない**の対で書くのが効いた。

```md
**している**
- データの置き場所
- 呼び出し元の特定 (トークン / ヘッダ)
- 書き込みの直列化 — 「読む → 判定 → 書く」のあいだ、他の書き込みを入れない

**していない**
- **見積もりの計算**。計算はクライアントがその場で回す
- **権限の判定**。API 層にあり、ローカルでもサーバでも同じ実装を通る
```

「していない」を書くと、**次に自分が読んだときに設計が思い出せる**。
エージェントに渡したときも、勝手に足されにくくなる。

## 既定のまま動かせるようにする

```rust
#[arg(long, default_value = "sqlite:mhc.db")] pub db: String,
#[arg(long, default_value = "127.0.0.1:8080")] pub listen: SocketAddr,
```

**打つだけで動く。** 待ち受けは `127.0.0.1` 既定 — 外に出すのは明示的な
操作にする。初回起動で管理者とトークンを作って標準出力に出す。

## 本番の外形監視

趣味の規模なら、`/healthz` を叩く cron 1 本で足りる。落ちたら通知。
メトリクスの収集基盤は、**見る人がいないうちは入れない**。

クラウド版に載せるなら、そこの既定 (CloudWatch Logs) に乗せる。
**自前で増やさない。**

## 関連

- スモークテスト → [ci-quality-gates](../ci-quality-gates/)
- 3 形態の設計 → [one-core-three-targets](../one-core-three-targets/)
