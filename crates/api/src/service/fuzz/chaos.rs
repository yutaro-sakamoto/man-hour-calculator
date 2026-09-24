//! 障害の注入: 保存先がでたらめに失敗しても、約束が崩れないこと。
//!
//! 本物の保存先 (SQLite / PostgreSQL / 将来の DynamoDB) は、ディスク・網・
//! 相手の都合で**いつでも**失敗しうる。ここでは読み書きのどれかを
//! 確率で失敗させながら、ファジングと同じ操作の列を流す。
//!
//! 1. panic しない。失敗は 500 (`Internal`) として返る
//! 2. **失敗した操作は何も変えない**
//! 3. どの時点でも、所有者の居ないプロジェクト・入れ物ができない
//! 4. **1 つの操作が書き込むのは 1 回まで、書いたあとは読まない**
//!    (障害を入れなくても)
//!
//! 4 が 2 と 3 の理由。保存先は複数の対象にまたがるトランザクションを
//! 約束しない (`store/mod.rs` の設計上の約束) ので、2 回書く操作は、
//! 1 回目と 2 回目のあいだで落ちると半端な状態を残す。いまはどの操作も
//! 1 回しか書かない (連鎖する削除は保存先の仕事)。**2 回書く操作を足すと
//! この検査が落ちる** — そのときは書き込みを 1 回にまとめるか、
//! 保存先の約束 (トランザクション) から考え直す。
//!
//! 「書いたあとは読まない」も同じ理由。応答を組み立てるための読みが書いた
//! あとで落ちると、「失敗」と答えたのに書けている。呼び手はやり直して
//! 衝突する。`save_document` と `update_project` がそうなっていた
//! (この検査で見つかった)。応答は書く前に組み立てる。

use std::cell::Cell;

use super::*;
use crate::error::ErrorCode;
use crate::model::{
    Comment, CommentId, Project, ProjectGroup, ProjectGroupId, ProjectId, ProjectMeta, User,
    UserGroup, UserGroupId, UserId,
};

/// 確率で失敗する保存先。中身は `MemoryStore`。
struct Faulty {
    inner: MemoryStore,
    /// 失敗させる確率 (百分率)。0 なら失敗しない。
    percent: u64,
    rng: Cell<u64>,
    /// この操作で起こした失敗と、書き込みの回数。
    injected: Cell<u32>,
    writes: Cell<u32>,
    reads_after_write: Cell<u32>,
}

impl Faulty {
    fn gate(&self) -> ApiResult<()> {
        let mut rng = Rng(self.rng.get());
        let fail = rng.chance(self.percent);
        self.rng.set(rng.0);
        if fail {
            self.injected.set(self.injected.get() + 1);
            Err(ApiError::internal("注入した障害"))
        } else {
            Ok(())
        }
    }

    fn read(&self) -> ApiResult<()> {
        if self.writes.get() > 0 {
            self.reads_after_write.set(self.reads_after_write.get() + 1);
        }
        self.gate()
    }

    fn write(&self) -> ApiResult<()> {
        self.gate()?;
        self.writes.set(self.writes.get() + 1);
        Ok(())
    }
}

/// 読みは `read`、書きは `write` を通してから中身に渡す。
macro_rules! delegate {
    ($(read $r:ident($($ra:ident: $rt:ty),*) -> $rret:ty;)* $(write $w:ident($($wa:ident: $wt:ty),*) -> $wret:ty;)*) => {
        impl Store for Faulty {
            $(fn $r(&self, $($ra: $rt),*) -> ApiResult<$rret> {
                self.read()?;
                self.inner.$r($($ra),*)
            })*
            $(fn $w(&mut self, $($wa: $wt),*) -> ApiResult<$wret> {
                self.write()?;
                self.inner.$w($($wa),*)
            })*
        }
    };
}

delegate! {
    read users() -> Vec<User>;
    read user(id: &UserId) -> Option<User>;
    read user_groups() -> Vec<UserGroup>;
    read user_group(id: &UserGroupId) -> Option<UserGroup>;
    read project_groups() -> Vec<ProjectGroup>;
    read project_group(id: &ProjectGroupId) -> Option<ProjectGroup>;
    read comments(project: &ProjectId) -> Vec<Comment>;
    read comment(id: &CommentId) -> Option<Comment>;
    read project_metas() -> Vec<ProjectMeta>;
    read project(id: &ProjectId) -> Option<Project>;
    write put_user(user: User) -> ();
    write remove_user(id: &UserId) -> bool;
    write put_user_group(group: UserGroup) -> ();
    write remove_user_group(id: &UserGroupId) -> bool;
    write put_project_group(group: ProjectGroup) -> ();
    write remove_project_group(id: &ProjectGroupId) -> bool;
    write put_comment(comment: Comment) -> ();
    write remove_comment(id: &CommentId) -> bool;
    write put_project(project: Project) -> ();
    write remove_project(id: &ProjectId) -> bool;
}

/// いまの中身を、検査用に `MemoryStore` の `Service` として複製する。
fn snapshot(service: &Service<Faulty>) -> Service<MemoryStore> {
    Service::new(MemoryStore::from_json(&service.store().inner.to_json()).expect("読み直せる"))
}

fn run(percent: u64) {
    for seed in 0..iterations() as u64 {
        let mut rng = Rng(seed);
        let staged = stage(&mut rng).into_store();
        let mut service = Service::new(Faulty {
            inner: staged,
            percent,
            rng: Cell::new(seed ^ 0xc4a0_5000),
            injected: Cell::new(0),
            writes: Cell::new(0),
            reads_after_write: Cell::new(0),
        });
        let mut history = Vec::new();

        for step in 0..STEPS {
            let request = request(&mut rng);
            let actor = UserId::new(rng.id(USERS));
            history.push(format!("{} {request:?}", actor.0));
            let before = service.store().inner.to_json();
            service.store().injected.set(0);
            service.store().writes.set(0);
            service.store().reads_after_write.set(0);

            let outcome = dispatch(
                &mut service,
                Envelope {
                    actor,
                    now: format!("2026-01-01T00:{:02}:{:02}Z", step / 60, step % 60),
                    request,
                },
            );

            let trail = || history.join("\n  ");
            let writes = service.store().writes.get();
            assert!(
                writes <= 1,
                "種 {seed}: 1 つの操作が {writes} 回書いた (途中で落ちると半端が残る)\n  {}",
                trail()
            );
            let late = service.store().reads_after_write.get();
            assert_eq!(
                late,
                0,
                "種 {seed}: 書いたあとに {late} 回読んだ (そこで落ちると、失敗と答えたのに書けている)\n  {}",
                trail()
            );
            if service.store().injected.get() > 0 {
                let Outcome::Err { error, .. } = &outcome else {
                    panic!("種 {seed}: 障害を飲み込んで成功と答えた\n  {}", trail());
                };
                // 注入した障害は 500。403 や 404 に化けると、呼び手は
                // 「やり直しても無駄」と誤解する。
                if error.code == ErrorCode::Internal {
                    assert_eq!(
                        service.store().inner.to_json(),
                        before,
                        "種 {seed}: 失敗した操作が状態を変えた\n  {}",
                        trail()
                    );
                }
            }
            if let Some(what) = orphan(&snapshot(&service)) {
                panic!("種 {seed}: {what} の所有者が居なくなった\n  {}", trail());
            }
        }
    }
}

#[test]
fn a_flaky_store_never_leaves_a_half_done_change() {
    run(15);
}

/// 障害を入れなくても、1 つの操作は 1 回しか書かず、書いたあとは読まない。
#[test]
fn every_operation_writes_at_most_once() {
    run(0);
}
