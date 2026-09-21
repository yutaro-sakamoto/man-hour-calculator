//! [`Store`] の実装が守るべき約束を、実装によらない形で確かめる。
//!
//! # なぜ要るのか
//!
//! 保存先は既に 3 つある (メモリ・SQL・これから DynamoDB) が、**同じ筋書きで
//! 突き合わせる仕掛けがこれまで無かった**。`SqlStore` には単体テストが 1 つも
//! 無く、`MemoryStore` との食い違いは HTTP を通した先で初めて出ていた。
//! 実際、`put_project` が件数を数え直すかどうかと、権限の並びが
//! 2 つの実装で違っていた。
//!
//! 新しい保存先を足すときは、**書く前にこれを通す**。受け入れ基準を先に
//! 固めておかないと、契約の食い違いに実装が終わるまで気づけない。
//!
//! # 使い方
//!
//! 呼ぶたびに**まっさらな**ストアを返す関数を渡す。検査ごとに作り直す。
//!
//! ```ignore
//! mhc_api::store::conformance::run_all(|| MemoryStore::new());
//! ```
//!
//! # ここで確かめないもの
//!
//! - **並び順のうち、一覧の並び** (`users()`, `project_metas()` など)。
//!   [`crate::service::Service`] が並べ直すので、実装に任せる
//! - 同時に書いたときの振る舞い。`Store` は直列化を前提にしない
//! - トークン。`Store` の外にある

use crate::model::{
    AccessEntry, Attachment, Comment, CommentId, Document, Principal, Project, ProjectGroup,
    ProjectGroupId, ProjectId, ProjectMeta, ProjectRole, SystemRole, User, UserGroup, UserGroupId,
    UserId,
};
use crate::store::Store;

const NOW: &str = "2026-01-01T00:00:00Z";

/* ===== 検査に使う値 ===== */

fn user(id: &str) -> User {
    User {
        id: UserId::new(id),
        name: format!("{id} さん"),
        email: None,
        system_role: SystemRole::Member,
        created_at: NOW.to_string(),
    }
}

fn user_group(id: &str, members: &[&str]) -> UserGroup {
    UserGroup {
        id: UserGroupId::new(id),
        name: format!("{id} 班"),
        members: members.iter().map(|m| UserId::new(*m)).collect(),
        created_at: NOW.to_string(),
    }
}

fn project_group(id: &str, access: Vec<AccessEntry>) -> ProjectGroup {
    ProjectGroup {
        id: ProjectGroupId::new(id),
        name: format!("{id} 群"),
        access,
        created_at: NOW.to_string(),
    }
}

fn project(id: &str, access: Vec<AccessEntry>) -> Project {
    Project {
        meta: ProjectMeta {
            id: ProjectId::new(id),
            name: format!("{id} の計画"),
            created_at: NOW.to_string(),
            updated_at: NOW.to_string(),
            group_id: None,
            due_date: None,
            access,
            status: None,
            task_count: 0,
            member_count: 0,
        },
        document: Document::default(),
    }
}

fn comment(id: &str, project: &str, created_at: &str) -> Comment {
    Comment {
        id: CommentId::new(id),
        project_id: ProjectId::new(project),
        task_id: None,
        author: UserId::new("u1"),
        body: format!("{id} の本文"),
        created_at: created_at.to_string(),
        updated_at: None,
        attachments: Vec::new(),
    }
}

fn attachment(id: &str) -> Attachment {
    Attachment {
        id: id.to_string(),
        filename: format!("{id}.png"),
        mime: "image/png".to_string(),
        size: 3,
        // "abc" を base64 にしたもの。中身は誰も解釈しない。
        data: "YWJj".to_string(),
    }
}

fn owner(id: &str) -> AccessEntry {
    AccessEntry::new(Principal::user(id), ProjectRole::Owner)
}

/// 権限を (種別, id) の順に並べたものに直す。突き合わせ用。
fn access_keys(access: &[AccessEntry]) -> Vec<String> {
    access
        .iter()
        .map(|e| format!("{}/{}", e.principal.kind(), e.principal.id()))
        .collect()
}

/* ===== 検査 ===== */

/// すべての約束を確かめる。
///
/// `make` は呼ぶたびに**まっさらな**ストアを返すこと。検査は互いに
/// 影響しないよう、1 つごとに作り直す。
pub fn run_all<S: Store>(make: impl Fn() -> S) {
    put_is_upsert(&make);
    remove_reports_whether_it_existed(&make);
    missing_ids_are_none(&make);
    removing_a_user_takes_its_grants_with_it(&make);
    removing_a_user_group_takes_its_grants_with_it(&make);
    removing_a_project_group_keeps_its_projects(&make);
    removing_a_project_takes_its_comments_with_it(&make);
    project_metas_has_no_document(&make);
    comments_come_back_oldest_first(&make);
    comments_are_scoped_to_one_project(&make);
    put_comment_replaces_the_whole_attachment_list(&make);
    counts_are_stored_as_given(&make);
    access_order_is_normalized(&make);
    group_members_are_normalized(&make);
}

/// `put_*` は「無ければ足す、あれば置き換える」。二重に増えない。
fn put_is_upsert<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    let mut renamed = user("u1");
    renamed.name = "別の名前".to_string();
    store.put_user(renamed).unwrap();

    let users = store.users().unwrap();
    assert_eq!(users.len(), 1, "put_user が同じ id を二重に足しています");
    assert_eq!(users[0].name, "別の名前", "put_user が置き換えていません");

    store.put_project(project("p1", vec![owner("u1")])).unwrap();
    let mut renamed = project("p1", vec![owner("u1")]);
    renamed.meta.name = "別の計画".to_string();
    store.put_project(renamed).unwrap();
    assert_eq!(
        store.project_metas().unwrap().len(),
        1,
        "put_project が同じ id を二重に足しています"
    );

    store.put_comment(comment("c1", "p1", NOW)).unwrap();
    let mut edited = comment("c1", "p1", NOW);
    edited.body = "書き直した".to_string();
    store.put_comment(edited).unwrap();
    let comments = store.comments(&ProjectId::new("p1")).unwrap();
    assert_eq!(comments.len(), 1, "put_comment が二重に足しています");
    assert_eq!(comments[0].body, "書き直した");
}

/// `remove_*` は「本当に消したか」を返す。無いものを消しても `false`。
fn remove_reports_whether_it_existed<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    assert!(
        !store.remove_user(&UserId::new("居ない")).unwrap(),
        "無いものを消して true を返しています"
    );
    store.put_user(user("u1")).unwrap();
    assert!(store.remove_user(&UserId::new("u1")).unwrap());
    assert!(
        !store.remove_user(&UserId::new("u1")).unwrap(),
        "2 度目の remove_user が true を返しています"
    );

    assert!(!store
        .remove_user_group(&UserGroupId::new("居ない"))
        .unwrap());
    assert!(!store
        .remove_project_group(&ProjectGroupId::new("居ない"))
        .unwrap());
    assert!(!store.remove_project(&ProjectId::new("居ない")).unwrap());
    assert!(!store.remove_comment(&CommentId::new("居ない")).unwrap());
}

/// 無い id を引いたらエラーではなく `None`。「無い」は異常ではない。
fn missing_ids_are_none<S: Store>(make: &impl Fn() -> S) {
    let store = make();
    assert!(store.user(&UserId::new("居ない")).unwrap().is_none());
    assert!(store
        .user_group(&UserGroupId::new("居ない"))
        .unwrap()
        .is_none());
    assert!(store
        .project_group(&ProjectGroupId::new("居ない"))
        .unwrap()
        .is_none());
    assert!(store.project(&ProjectId::new("居ない")).unwrap().is_none());
    assert!(store.comment(&CommentId::new("居ない")).unwrap().is_none());
    assert!(store
        .comments(&ProjectId::new("居ない"))
        .unwrap()
        .is_empty());
}

/// アカウントを消したら、そのアカウント宛ての権限とメンバーシップも消える。
///
/// **残すと宙に浮く。** 同じ id でアカウントを作り直したときに、消した
/// はずの権限がそのまま復活する。
fn removing_a_user_takes_its_grants_with_it<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    store.put_user(user("u2")).unwrap();
    store
        .put_user_group(user_group("g1", &["u1", "u2"]))
        .unwrap();
    store
        .put_project(project("p1", vec![owner("u1"), owner("u2")]))
        .unwrap();
    store
        .put_project_group(project_group("pg1", vec![owner("u1"), owner("u2")]))
        .unwrap();

    assert!(store.remove_user(&UserId::new("u1")).unwrap());

    let meta = store.project(&ProjectId::new("p1")).unwrap().unwrap().meta;
    assert_eq!(
        access_keys(&meta.access),
        vec!["user/u2"],
        "消したアカウント宛ての権限がプロジェクトに残っています"
    );
    let group = store
        .project_group(&ProjectGroupId::new("pg1"))
        .unwrap()
        .unwrap();
    assert_eq!(
        access_keys(&group.access),
        vec!["user/u2"],
        "消したアカウント宛ての権限がプロジェクト群に残っています"
    );
    let members = store
        .user_group(&UserGroupId::new("g1"))
        .unwrap()
        .unwrap()
        .members;
    assert_eq!(
        members,
        vec![UserId::new("u2")],
        "消したアカウントがグループに残っています"
    );
}

/// アカウントのグループを消したら、そのグループ宛ての権限も消える。
fn removing_a_user_group_takes_its_grants_with_it<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    store.put_user_group(user_group("g1", &["u1"])).unwrap();
    let to_group = AccessEntry::new(Principal::group("g1"), ProjectRole::Editor);
    store
        .put_project(project("p1", vec![owner("u1"), to_group.clone()]))
        .unwrap();
    store
        .put_project_group(project_group("pg1", vec![owner("u1"), to_group]))
        .unwrap();

    assert!(store.remove_user_group(&UserGroupId::new("g1")).unwrap());

    let meta = store.project(&ProjectId::new("p1")).unwrap().unwrap().meta;
    assert_eq!(
        access_keys(&meta.access),
        vec!["user/u1"],
        "消したグループ宛ての権限がプロジェクトに残っています"
    );
    let group = store
        .project_group(&ProjectGroupId::new("pg1"))
        .unwrap()
        .unwrap();
    assert_eq!(
        access_keys(&group.access),
        vec!["user/u1"],
        "消したグループ宛ての権限がプロジェクト群に残っています"
    );
}

/// プロジェクト群を消しても、**配下のプロジェクトは消さない**。
///
/// 入れ物を畳んだだけで中身が消えるのは、取り返しがつかない。
/// どこにも属さない状態に戻すだけにする。
fn removing_a_project_group_keeps_its_projects<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    store
        .put_project_group(project_group("pg1", vec![owner("u1")]))
        .unwrap();
    let mut child = project("p1", vec![owner("u1")]);
    child.meta.group_id = Some(ProjectGroupId::new("pg1"));
    store.put_project(child).unwrap();

    assert!(store
        .remove_project_group(&ProjectGroupId::new("pg1"))
        .unwrap());

    let meta = store
        .project(&ProjectId::new("p1"))
        .unwrap()
        .expect("プロジェクトごと消えています")
        .meta;
    assert_eq!(
        meta.group_id, None,
        "消えた群への参照が残っています (宙に浮いた group_id)"
    );
}

/// プロジェクトを消したら、そこに付いていたコメントと添付も消える。
/// 行き先の無いコメントを残しても、読み返す手立てが無い。
fn removing_a_project_takes_its_comments_with_it<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    store.put_project(project("p1", vec![owner("u1")])).unwrap();
    store.put_project(project("p2", vec![owner("u1")])).unwrap();
    let mut with_file = comment("c1", "p1", NOW);
    with_file.attachments = vec![attachment("a1")];
    store.put_comment(with_file).unwrap();
    store.put_comment(comment("c2", "p2", NOW)).unwrap();

    assert!(store.remove_project(&ProjectId::new("p1")).unwrap());

    assert!(
        store.comment(&CommentId::new("c1")).unwrap().is_none(),
        "消したプロジェクトのコメントが残っています"
    );
    assert!(
        store.comment(&CommentId::new("c2")).unwrap().is_some(),
        "関係のないプロジェクトのコメントまで消えています"
    );
}

/// 一覧は中身を読まない。`project_metas()` は 1 件 1 行で、`Document` を含まない。
///
/// 型の上で `Document` を持てないので、ここで確かめられるのは「件数と
/// 見出しが揃っていること」まで。**中身を読みに行っていないこと**は
/// 型が保証している。
fn project_metas_has_no_document<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    for id in ["p1", "p2", "p3"] {
        let mut item = project(id, vec![owner("u1")]);
        item.document.tasks = Vec::new();
        store.put_project(item).unwrap();
    }
    let mut metas = store.project_metas().unwrap();
    metas.sort_by(|a, b| a.id.cmp(&b.id));
    let ids: Vec<&str> = metas.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["p1", "p2", "p3"], "一覧の件数が合いません");
    assert_eq!(metas[0].name, "p1 の計画");
    assert_eq!(access_keys(&metas[0].access), vec!["user/u1"]);
}

/// コメントは古い順。同じ時刻なら id の順。**並べるのは Store の仕事**。
///
/// 会話として読めるようにするため。`Service` は並べ直さない。
fn comments_come_back_oldest_first<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    store.put_project(project("p1", vec![owner("u1")])).unwrap();
    // わざと時刻の順とは違う順に入れる。
    store
        .put_comment(comment("c3", "p1", "2026-01-03T00:00:00Z"))
        .unwrap();
    store
        .put_comment(comment("c1", "p1", "2026-01-01T00:00:00Z"))
        .unwrap();
    // 同じ時刻のものを 2 件。id で決着がつくこと。
    store
        .put_comment(comment("c2b", "p1", "2026-01-02T00:00:00Z"))
        .unwrap();
    store
        .put_comment(comment("c2a", "p1", "2026-01-02T00:00:00Z"))
        .unwrap();

    let comments = store.comments(&ProjectId::new("p1")).unwrap();
    let ids: Vec<&str> = comments.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["c1", "c2a", "c2b", "c3"],
        "コメントが (created_at, id) の順に並んでいません"
    );
}

/// `comments()` は、そのプロジェクトのものだけを返す。
fn comments_are_scoped_to_one_project<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    store.put_project(project("p1", vec![owner("u1")])).unwrap();
    store.put_project(project("p2", vec![owner("u1")])).unwrap();
    store.put_comment(comment("c1", "p1", NOW)).unwrap();
    store.put_comment(comment("c2", "p2", NOW)).unwrap();

    let comments = store.comments(&ProjectId::new("p1")).unwrap();
    let ids: Vec<&str> = comments.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["c1"],
        "他のプロジェクトのコメントが混ざっています"
    );
}

/// 添付は `put_comment` で**全置換**。差分ではない。
///
/// 並びは入れた順のまま返す (画面がその順で出す)。
fn put_comment_replaces_the_whole_attachment_list<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    store.put_project(project("p1", vec![owner("u1")])).unwrap();

    let mut first = comment("c1", "p1", NOW);
    first.attachments = vec![attachment("a1"), attachment("a2"), attachment("a3")];
    store.put_comment(first).unwrap();

    let got = store.comment(&CommentId::new("c1")).unwrap().unwrap();
    let ids: Vec<&str> = got.attachments.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["a1", "a2", "a3"],
        "添付の並びが入れた順と違います"
    );
    assert_eq!(got.attachments[0].filename, "a1.png");
    assert_eq!(
        got.attachments[0].data, "YWJj",
        "添付の中身が変わっています"
    );

    // 1 件だけにして入れ直す。残り 2 件は消えること。
    let mut second = comment("c1", "p1", NOW);
    second.attachments = vec![attachment("a9")];
    store.put_comment(second).unwrap();

    let got = store.comment(&CommentId::new("c1")).unwrap().unwrap();
    let ids: Vec<&str> = got.attachments.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids, vec!["a9"], "put_comment が添付を全置換していません");

    // 空にもできること。
    store.put_comment(comment("c1", "p1", NOW)).unwrap();
    assert!(
        store
            .comment(&CommentId::new("c1"))
            .unwrap()
            .unwrap()
            .attachments
            .is_empty(),
        "添付を空にできていません"
    );
    // 一覧から読んでも同じこと。
    assert!(store.comments(&ProjectId::new("p1")).unwrap()[0]
        .attachments
        .is_empty());
}

/// `put_project` は件数を**数え直さない**。渡されたものをそのまま保存する。
///
/// 数え直すのは `Service` の仕事 (`Project::refresh_counts`)。ここで
/// 数えると、中身を持たない保存先 (列に持つ SQL、項目を分ける DynamoDB) と
/// 振る舞いが分かれる。
fn counts_are_stored_as_given<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    store.put_user(user("u1")).unwrap();
    let mut item = project("p1", vec![owner("u1")]);
    // 中身は空のまま、件数だけ嘘の値を入れる。
    item.meta.task_count = 7;
    item.meta.member_count = 3;
    store.put_project(item).unwrap();

    let meta = store.project(&ProjectId::new("p1")).unwrap().unwrap().meta;
    assert_eq!(
        (meta.task_count, meta.member_count),
        (7, 3),
        "put_project が件数を数え直しています (Store の仕事ではありません)"
    );
    let metas = store.project_metas().unwrap();
    assert_eq!((metas[0].task_count, metas[0].member_count), (7, 3));
}

/// 権限は (種別, id) の順で返る。入れた順は残らない。
fn access_order_is_normalized<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    for id in ["u1", "u2"] {
        store.put_user(user(id)).unwrap();
    }
    store.put_user_group(user_group("g1", &["u1"])).unwrap();
    // わざと逆順に入れる。
    let access = vec![
        AccessEntry::new(Principal::user("u2"), ProjectRole::Viewer),
        owner("u1"),
        AccessEntry::new(Principal::group("g1"), ProjectRole::Editor),
    ];
    store.put_project(project("p1", access.clone())).unwrap();
    store
        .put_project_group(project_group("pg1", access))
        .unwrap();

    let expected = vec!["group/g1", "user/u1", "user/u2"];
    let meta = store.project(&ProjectId::new("p1")).unwrap().unwrap().meta;
    assert_eq!(
        access_keys(&meta.access),
        expected,
        "プロジェクトの権限が (種別, id) の順になっていません"
    );
    let metas = store.project_metas().unwrap();
    assert_eq!(
        access_keys(&metas[0].access),
        expected,
        "一覧の権限が (種別, id) の順になっていません"
    );
    let group = store
        .project_group(&ProjectGroupId::new("pg1"))
        .unwrap()
        .unwrap();
    assert_eq!(
        access_keys(&group.access),
        expected,
        "プロジェクト群の権限が (種別, id) の順になっていません"
    );

    // 役割は相手ごとに正しく付いたままであること (並べ替えでずれない)。
    assert_eq!(
        meta.role_for(&Principal::user("u1")),
        Some(ProjectRole::Owner)
    );
    assert_eq!(
        meta.role_for(&Principal::user("u2")),
        Some(ProjectRole::Viewer)
    );
    assert_eq!(
        meta.role_for(&Principal::group("g1")),
        Some(ProjectRole::Editor)
    );
}

/// グループのメンバーは id の順で返る。理由は権限と同じ。
fn group_members_are_normalized<S: Store>(make: &impl Fn() -> S) {
    let mut store = make();
    for id in ["u1", "u2", "u3"] {
        store.put_user(user(id)).unwrap();
    }
    store
        .put_user_group(user_group("g1", &["u3", "u1", "u2"]))
        .unwrap();

    let members = store
        .user_group(&UserGroupId::new("g1"))
        .unwrap()
        .unwrap()
        .members;
    assert_eq!(
        members,
        vec![UserId::new("u1"), UserId::new("u2"), UserId::new("u3")],
        "グループのメンバーが id の順になっていません"
    );
    let groups = store.user_groups().unwrap();
    assert_eq!(
        groups[0].members.len(),
        3,
        "一覧から読んだときにメンバーが落ちています"
    );
}
