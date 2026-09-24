//! 状態つきのファジング: でたらめな操作の列を [`dispatch`] に流し続ける。
//!
//! 単体テストは「この操作でこうなる」を 1 本ずつ確かめる。TLC は設計を
//! 全状態で確かめる。ここはその間を埋める — **実装そのもの**に、人が
//! 思いつかない順序の操作を大量に当てて、次の約束が崩れないかを見る。
//!
//! 1. どの操作でも panic しない (エラーは `Outcome::Err` で返る)
//! 2. どのプロジェクトにも、どの入れ物 (プロジェクトグループ) にも、実在の
//!    所有者が必ず 1 人以上居る (`spec/Permissions.tla` の不変条件の実装側)
//! 3. 失敗した操作は、保存先を 1 バイトも変えない
//! 4. 読むだけの操作 (`is_mutating() == false`) は、成功しても何も変えない
//! 5. 保存先は JSON を往復しても同じものに戻る
//!
//! 乱数は種で決まるので、落ちたら同じ種で必ず再現する。回数は
//! `MHC_FUZZ_ITERS` で増やせる (既定は `cargo test` を重くしない程度)。

use super::*;
use crate::model::{Principal, ProjectRole, SystemRole, User};
use crate::protocol::{dispatch, Envelope, Outcome, Request};
use crate::store::MemoryStore;

mod chaos;

/// splitmix64。`mhc-api` は `mhc-core` に依存しないので、ここで小さく持つ。
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }

    /// id を引く。存在しない id (`ghost`、末尾に置く) は 1 割だけ。
    /// 等確率で引くと「見つかりません」「認証できません」ばかりになる。
    fn id<'a>(&mut self, items: &[&'a str]) -> &'a str {
        if self.chance(10) {
            items[items.len() - 1]
        } else {
            items[self.below(items.len() - 1)]
        }
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

/// id は小さな集合から引く。**大きな空間から引くと、ほとんどの操作が
/// 「見つかりません」で終わって**、面白い状態に届かない。存在しない id
/// (`ghost`) も混ぜて、見つからない経路も通す。
const USERS: &[&str] = &["root", "alice", "bob", "carol", "ghost"];
const USER_GROUPS: &[&str] = &["g1", "g2", "ghost"];
const PROJECT_GROUPS: &[&str] = &["pg1", "pg2", "ghost"];
const PROJECTS: &[&str] = &["p1", "p2", "ghost"];
const COMMENTS: &[&str] = &["c1", "c2", "ghost"];
/// 空文字・空白だけ・制御文字・長い文字列・HTML もどきを混ぜる。
const NAMES: &[&str] = &[
    "名前",
    "",
    "   ",
    "\u{0}\u{7}",
    "<script>alert(1)</script>",
    "とても長い名前とても長い名前とても長い名前とても長い名前とても長い名前",
];

/// 1 本の列の長さ。所有権の抜け穴は「入れ物を作る → 権限を配る → 自分の
/// 付与を外す → 入れ物から出す」のように 4〜5 手かかるので、短すぎると届かない。
const STEPS: usize = 80;

fn iterations() -> usize {
    std::env::var("MHC_FUZZ_ITERS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(200)
}

fn principal(rng: &mut Rng) -> Principal {
    if rng.chance(70) {
        Principal::user(rng.id(USERS))
    } else {
        Principal::group(rng.id(USER_GROUPS))
    }
}

fn role(rng: &mut Rng) -> ProjectRole {
    [ProjectRole::Viewer, ProjectRole::Editor, ProjectRole::Owner][rng.below(3)]
}

fn system_role(rng: &mut Rng) -> SystemRole {
    if rng.chance(20) {
        SystemRole::Admin
    } else {
        SystemRole::Member
    }
}

fn opt_name(rng: &mut Rng) -> Option<String> {
    rng.chance(50).then(|| rng.pick(NAMES).to_string())
}

/// 操作を 1 つでたらめに作る。`Request` の全種類を引けるようにしてある
/// (種類を足したら、ここにも足す — 足さないと、その操作は撃たれない)。
///
/// 半分は所有権を動かす操作に寄せる。等確率だと、所有者が居なくなる筋
/// (権限を外す・人やグループを消す・入れ物を移る) にほとんど届かない。
/// **番人を外すとこの検査が落ちる**ことを確かめてある。
fn request(rng: &mut Rng) -> Request {
    if rng.chance(50) {
        return ownership_move(rng);
    }
    use crate::model::{CommentId, ProjectGroupId, ProjectId, UserGroupId, UserId};
    let user = |rng: &mut Rng| UserId::new(rng.id(USERS));
    let user_group = |rng: &mut Rng| UserGroupId::new(rng.id(USER_GROUPS));
    let project_group = |rng: &mut Rng| ProjectGroupId::new(rng.id(PROJECT_GROUPS));
    let project = |rng: &mut Rng| ProjectId::new(rng.id(PROJECTS));
    let comment = |rng: &mut Rng| CommentId::new(rng.id(COMMENTS));
    // 名前は 3/4 を素直なものにする。変な名前ばかりだと作る操作が通らず、
    // 状態が育たない。
    let name = |rng: &mut Rng| {
        if rng.chance(75) {
            NAMES[0].to_string()
        } else {
            rng.pick(NAMES).to_string()
        }
    };

    match rng.below(32) {
        0 => Request::Me,
        1 => Request::ListUsers,
        2 => Request::CreateUser {
            id: user(rng),
            name: name(rng),
            email: None,
            system_role: system_role(rng),
        },
        3 => Request::UpdateUser {
            id: user(rng),
            name: opt_name(rng),
            email: rng.chance(30).then(|| "a@example.com".to_string()),
            clear_email: rng.chance(20),
            system_role: rng.chance(40).then(|| system_role(rng)),
        },
        4 => Request::DeleteUser { id: user(rng) },
        5 => Request::ListUserGroups,
        6 => Request::CreateUserGroup {
            id: user_group(rng),
            name: name(rng),
        },
        7 => Request::RenameUserGroup {
            id: user_group(rng),
            name: name(rng),
        },
        8 => Request::DeleteUserGroup {
            id: user_group(rng),
        },
        9 | 10 => Request::AddGroupMember {
            id: user_group(rng),
            user_id: user(rng),
        },
        11 => Request::RemoveGroupMember {
            id: user_group(rng),
            user_id: user(rng),
        },
        12 => Request::ListProjectGroups,
        13 => Request::CreateProjectGroup {
            id: project_group(rng),
            name: name(rng),
        },
        14 => Request::RenameProjectGroup {
            id: project_group(rng),
            name: name(rng),
        },
        15 => Request::DeleteProjectGroup {
            id: project_group(rng),
        },
        16 => Request::SetGroupAccess {
            id: project_group(rng),
            principal: principal(rng),
            role: role(rng),
        },
        17 => Request::RemoveGroupAccess {
            id: project_group(rng),
            principal: principal(rng),
        },
        18 => Request::ListProjects,
        19 | 20 => Request::CreateProject {
            id: project(rng),
            name: name(rng),
            document: Default::default(),
        },
        21 => Request::GetProject { id: project(rng) },
        22 => Request::SaveDocument {
            id: project(rng),
            document: Default::default(),
            status: None,
        },
        23 => Request::UpdateProject {
            id: project(rng),
            name: opt_name(rng),
            group_id: rng.chance(50).then(|| project_group(rng)),
            clear_group: rng.chance(20),
            due_date: rng
                .chance(30)
                .then(|| rng.pick(&["2026-10-01", "not-a-date", ""]).to_string()),
            clear_due_date: rng.chance(20),
        },
        24 => Request::DeleteProject { id: project(rng) },
        25 => Request::DuplicateProject {
            id: project(rng),
            new_id: project(rng),
            name: name(rng),
        },
        26 => Request::ListComments {
            id: project(rng),
            task_id: None,
        },
        27 => Request::PostComment {
            id: project(rng),
            comment_id: comment(rng),
            task_id: rng.chance(30).then(|| "t1".to_string()),
            body: name(rng),
            attachments: Vec::new(),
        },
        28 => Request::EditComment {
            comment_id: comment(rng),
            body: name(rng),
            attachments: Vec::new(),
        },
        29 => Request::DeleteComment {
            comment_id: comment(rng),
        },
        30 => Request::ListAccess { id: project(rng) },
        _ => {
            if rng.chance(70) {
                Request::SetAccess {
                    id: project(rng),
                    principal: principal(rng),
                    role: role(rng),
                }
            } else {
                Request::RemoveAccess {
                    id: project(rng),
                    principal: principal(rng),
                }
            }
        }
    }
}

/// 所有権を動かす操作。
fn ownership_move(rng: &mut Rng) -> Request {
    use crate::model::{ProjectGroupId, ProjectId, UserGroupId, UserId};
    let project = ProjectId::new(rng.id(PROJECTS));
    let group = UserGroupId::new(rng.id(USER_GROUPS));
    let folder = ProjectGroupId::new(rng.id(PROJECT_GROUPS));
    match rng.below(10) {
        0 | 1 => Request::SetAccess {
            id: project,
            principal: principal(rng),
            role: role(rng),
        },
        2 | 3 => Request::RemoveAccess {
            id: project,
            principal: principal(rng),
        },
        4 => Request::SetGroupAccess {
            id: folder,
            principal: principal(rng),
            role: role(rng),
        },
        5 => Request::RemoveGroupAccess {
            id: folder,
            principal: principal(rng),
        },
        6 => Request::AddGroupMember {
            id: group,
            user_id: UserId::new(rng.id(USERS)),
        },
        7 => Request::RemoveGroupMember {
            id: group,
            user_id: UserId::new(rng.id(USERS)),
        },
        8 => Request::UpdateProject {
            id: project,
            name: None,
            group_id: rng.chance(70).then_some(folder),
            clear_group: rng.chance(30),
            due_date: None,
            clear_due_date: false,
        },
        _ => {
            if rng.chance(50) {
                Request::DeleteUser {
                    id: UserId::new(rng.id(USERS)),
                }
            } else {
                Request::DeleteUserGroup { id: group }
            }
        }
    }
}

fn seeded() -> Service<MemoryStore> {
    let mut store = MemoryStore::new();
    for (id, role) in [
        ("root", SystemRole::Admin),
        ("alice", SystemRole::Member),
        ("bob", SystemRole::Member),
        ("carol", SystemRole::Member),
    ] {
        store
            .put_user(User {
                id: crate::model::UserId::new(id),
                name: id.into(),
                email: None,
                system_role: role,
                created_at: "2026-01-01T00:00:00Z".into(),
            })
            .expect("メモリには必ず書ける");
    }
    Service::new(store)
}

/// 列を撃つ前の舞台。**空から始めると、ほとんどの操作が「見つかりません」で
/// 終わる** (実測で 6 割)。所有権の抜け穴は、入れ物に入ったプロジェクトや
/// グループ経由の付与があって初めて通れるので、そこまでは先に作っておく。
///
/// 作るのも `dispatch` を通す (保存先に直接書かない)。誰が作るか、入れ物に
/// 入れるかは種で変える。
fn stage(rng: &mut Rng) -> Service<MemoryStore> {
    use crate::model::{ProjectGroupId, ProjectId, UserGroupId, UserId};
    let mut service = seeded();
    let members = ["alice", "bob", "carol"];
    let run = |service: &mut Service<MemoryStore>, actor: &str, request: Request| {
        dispatch(
            service,
            Envelope {
                actor: UserId::new(actor),
                now: "2026-01-01T00:00:00Z".into(),
                request,
            },
        )
    };

    for group in ["g1", "g2"] {
        run(
            &mut service,
            "root",
            Request::CreateUserGroup {
                id: UserGroupId::new(group),
                name: group.into(),
            },
        );
        for member in members {
            if rng.chance(50) {
                run(
                    &mut service,
                    "root",
                    Request::AddGroupMember {
                        id: UserGroupId::new(group),
                        user_id: UserId::new(member),
                    },
                );
            }
        }
    }
    let folder_owner = rng.pick(&members);
    run(
        &mut service,
        folder_owner,
        Request::CreateProjectGroup {
            id: ProjectGroupId::new("pg1"),
            name: "pg1".into(),
        },
    );
    for project in ["p1", "p2"] {
        let owner = if rng.chance(60) {
            folder_owner
        } else {
            rng.pick(&members)
        };
        run(
            &mut service,
            owner,
            Request::CreateProject {
                id: ProjectId::new(project),
                name: project.into(),
                document: Default::default(),
            },
        );
        if rng.chance(60) {
            run(
                &mut service,
                owner,
                Request::UpdateProject {
                    id: ProjectId::new(project),
                    name: None,
                    group_id: Some(ProjectGroupId::new("pg1")),
                    clear_group: false,
                    due_date: None,
                    clear_due_date: false,
                },
            );
        }
    }
    service
}

/// 約束 2。所有者の居ないプロジェクトか入れ物があれば、その id を返す。
fn orphan<S: Store>(service: &Service<S>) -> Option<String> {
    let groups = service
        .store
        .project_groups()
        .expect("メモリからは必ず読める");
    // 入れ物に所有者が居ないと、誰も改名も削除もできない入れ物が残る。
    if let Some(group) = groups.iter().find(|group| {
        service
            .owner_users_of_folder(group)
            .map_or(true, |owners| owners.is_empty())
    }) {
        return Some(format!("入れ物 {}", group.id.0));
    }
    service
        .store
        .project_metas()
        .expect("メモリからは必ず読める")
        .into_iter()
        .find(|meta| {
            let parent = Service::<S>::parent_of(meta, &groups);
            service
                .owner_users(meta, parent)
                .map_or(true, |owners| owners.is_empty())
        })
        .map(|meta| format!("プロジェクト {}", meta.id.0))
}

#[test]
fn random_operation_sequences_keep_every_promise() {
    for seed in 0..iterations() as u64 {
        let mut rng = Rng(seed);
        let mut service = stage(&mut rng);
        let mut history = Vec::new();

        for step in 0..STEPS {
            let request = request(&mut rng);
            let actor = crate::model::UserId::new(rng.id(USERS));
            let mutating = request.is_mutating();
            history.push(format!("{} {request:?}", actor.0));
            let before = service.store().to_json();

            let outcome = dispatch(
                &mut service,
                Envelope {
                    actor,
                    now: format!("2026-01-01T00:{:02}:{:02}Z", step / 60, step % 60),
                    request,
                },
            );

            let after = service.store().to_json();
            let trail = || history.join("\n  ");
            match outcome {
                Outcome::Err { .. } => assert_eq!(
                    before,
                    after,
                    "種 {seed}: 失敗した操作が状態を変えた\n  {}",
                    trail()
                ),
                Outcome::Ok { .. } if !mutating => assert_eq!(
                    before,
                    after,
                    "種 {seed}: 読むだけの操作が状態を変えた\n  {}",
                    trail()
                ),
                Outcome::Ok { .. } => {}
            }
            if let Some(project) = orphan(&service) {
                panic!("種 {seed}: {project} の所有者が居なくなった\n  {}", trail());
            }
            let reloaded = MemoryStore::from_json(&after)
                .unwrap_or_else(|e| panic!("種 {seed}: 書き出した状態を読めない: {e:?}"));
            assert_eq!(
                reloaded.to_json(),
                after,
                "種 {seed}: JSON を往復すると状態が変わる\n  {}",
                trail()
            );
        }
    }
}

/// でたらめな文字列を、JSON の入口 (`Envelope` と保存データ) に当てる。
///
/// 正しい JSON を少しずつ壊したものを使う。完全なでたらめは入口の
/// 1 行目で弾かれて、奥まで届かないため。
#[test]
fn mangled_json_never_panics() {
    let valid = [
        r#"{"actor":"root","now":"2026-01-01T00:00:00Z","request":{"op":"createProject","id":"p1","name":"x"}}"#,
        r#"{"actor":"root","now":"2026-01-01T00:00:00Z","request":{"op":"setAccess","id":"p1","principal":{"kind":"user","id":"bob"},"role":"owner"}}"#,
        r#"{"version":1,"users":[],"projects":[{"id":"p1","access":[{"userId":"a","role":"owner"}]}]}"#,
        r#"{"version":3,"users":[{"id":"root","name":"r","systemRole":"admin","createdAt":""}]}"#,
    ];
    const NOISE: &[&str] = &[
        "",
        "\"",
        "{",
        "}",
        "[",
        "]",
        ",",
        ":",
        "null",
        "-1",
        "1e999",
        "\u{fffd}",
        "\\u0000",
        "true",
        "\"version\":99",
        "\"op\":\"deleteUser\"",
    ];
    for seed in 0..(iterations() * 10) as u64 {
        let mut rng = Rng(seed);
        let mut text = valid[rng.below(valid.len())].to_string();
        for _ in 0..=rng.below(4) {
            // 文字の境界でだけ切る。UTF-8 の途中で切るのは str が許さない
            // (そこは FFI の手前で弾いている — `crates/wasm` の検査)。
            // 末尾も切れ目に入れる (空になった文字列にも足せるように)。
            let mut cuts: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
            cuts.push(text.len());
            let at = cuts[rng.below(cuts.len())];
            match rng.below(3) {
                0 => text.insert_str(at, rng.pick(NOISE)),
                1 => text.truncate(at),
                _ => {
                    let end = cuts[rng.below(cuts.len())].max(at);
                    text.replace_range(at..end, rng.pick(NOISE));
                }
            }
        }

        if let Ok(envelope) = serde_json::from_str::<Envelope>(&text) {
            let mut service = seeded();
            let _ = dispatch(&mut service, envelope);
        }
        if let Ok(store) = MemoryStore::from_json(&text) {
            // 読めたなら、書き出して読み直せる。
            let again = MemoryStore::from_json(&store.to_json());
            assert!(
                again.is_ok(),
                "種 {seed}: 読めた保存データを往復できない: {text}"
            );
        }
    }
}
