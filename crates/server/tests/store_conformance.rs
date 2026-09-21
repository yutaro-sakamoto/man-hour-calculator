//! `SqlStore` が `Store` の約束を守っていることを確かめる。
//!
//! 検査そのものは `mhc_api::store::conformance` にあり、`MemoryStore` にも
//! 同じものを当てている。**2 つの実装を同じ筋書きで突き合わせるのがここの
//! 目的**で、片方だけの都合をここに書き足さないこと。
//!
//! SQLite は毎回メモリ上に開き直す。検査は互いに影響しない。

use mhc_api::store::conformance;
use mhc_server::store::sqlite::SqliteConn;
use mhc_server::store::SqlStore;

#[test]
fn the_sql_store_keeps_the_contract() {
    conformance::run_all(|| {
        // `Store` を実装しているのは `SqlStore` ではなく **`&SqlStore`**
        // (中身は `Mutex` なので `&self` で書ける。サーバは `Arc` で持つ)。
        // ここで作ったものへの参照をそのまま返すことはできないので、
        // 寿命を切る。検査 1 回につき 1 つ、メモリ上の SQLite が
        // 14 個できるだけで、プロセスの終わりまで生き残っても困らない。
        let store = SqlStore::open(SqliteConn::in_memory().expect("開ける")).expect("開ける");
        &*Box::leak(Box::new(store))
    });
}
