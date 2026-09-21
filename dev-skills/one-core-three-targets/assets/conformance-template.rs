//! `Store` の実装が守るべき約束を、実装によらない形で確かめる骨。
//!
//! # なぜ要るのか
//!
//! 保存先が 2 つ以上になった時点で、**同じ筋書きで突き合わせる仕掛け**が
//! 無いと食い違う。食い違いは単体テストでは出ず、HTTP を通した先で初めて出る。
//!
//! 新しい保存先を足すときは、**書く前にこれを通す**。受け入れ基準を先に
//! 固めておかないと、契約の食い違いに実装が終わるまで気づけない。
//!
//! # 使い方
//!
//! 呼ぶたびに**まっさらな**ストアを返す関数を渡す。検査ごとに作り直す。
//!
//! ```ignore
//! <<<CRATE>>>::store::conformance::run_all(|| MemoryStore::new());
//! ```
//!
//! # ここで確かめないもの
//!
//! - **一覧の並び順**。呼び出し側 (Service) が並べ直すので実装に任せる
//! - **同時に書いたときの振る舞い**。`Store` は直列化を前提にしない
//! - 認証・トークン。`Store` の外にある

use crate::store::Store;

const NOW: &str = "2026-01-01T00:00:00Z";

/// 全部を順に当てる。落ちたものは panic で名前ごと出る。
pub fn run_all<S: Store>(fresh: impl Fn() -> S) {
    put_is_upsert(&fresh);
    remove_reports_whether_it_existed(&fresh);
    missing_ids_are_none(&fresh);
    removing_a_parent_takes_its_grants_with_it(&fresh);
    removing_a_group_keeps_its_children(&fresh);
    counts_are_stored_as_given(&fresh);
    // <<<ここに約束を足す。足したら docs/VERIFICATION.md の表にも 1 行足す>>>
}

/// `put_*` は upsert。同じ id で二重に増えない。
fn put_is_upsert<S: Store>(fresh: &impl Fn() -> S) {
    let mut store = fresh();
    // <<<...>>>
    let _ = (&mut store, NOW);
}

/// `remove_*` は「本当に消したか」を返す。無いものを消して true にしない。
fn remove_reports_whether_it_existed<S: Store>(fresh: &impl Fn() -> S) {
    let mut store = fresh();
    let _ = &mut store;
}

/// 無い id は `None` / 空。**エラーにしない。**
fn missing_ids_are_none<S: Store>(fresh: &impl Fn() -> S) {
    let _ = fresh();
}

/// 親を消したら、その親宛ての権限と所属も一緒に消える。
fn removing_a_parent_takes_its_grants_with_it<S: Store>(fresh: &impl Fn() -> S) {
    let _ = fresh();
}

/// **入れ物を消しても、配下は消さない。** ここは実装ごとに割れやすい。
fn removing_a_group_keeps_its_children<S: Store>(fresh: &impl Fn() -> S) {
    let _ = fresh();
}

/// 件数は数え直さない。渡された値をそのまま持つ。
/// (実装の片方だけが数え直していて、ローカル版とサーバ版で応答が違っていた)
fn counts_are_stored_as_given<S: Store>(fresh: &impl Fn() -> S) {
    let _ = fresh();
}
