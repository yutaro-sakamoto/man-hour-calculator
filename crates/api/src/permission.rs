//! 誰が何をしてよいかの判定。
//!
//! 判定はここ 1 か所にしかなく、ローカルでもサーバでも同じコードが動く。
//! 画面側で出し分けるのはあくまで見た目の話で、実際に止めるのはここ。

use serde::{Deserialize, Serialize};

use crate::model::{
    AccessEntry, Principal, ProjectGroup, ProjectMeta, ProjectRole, SystemRole, UserGroupId, UserId,
};

/// 操作の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    /// プロジェクトを見る。
    ProjectRead,
    /// プロジェクトの内容を書き換える。
    ProjectWrite,
    /// 改名・削除・権限の付け替え。
    ProjectManage,
    /// 新しいプロジェクトを作る。
    ProjectCreate,
    /// アカウントを管理する。
    UserManage,
    /// コメントを書く。
    ///
    /// 閲覧できれば書ける。見積もりに口を出すのに編集権限まで要るのは
    /// 窮屈で、「見てもらって意見だけもらう」ができなくなる。
    CommentPost,
}

/// 操作している人。
///
/// 所属グループを持っているのは、権限がグループ経由でも届くため。
/// 呼び出しごとに解決して詰めておく。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub user_id: UserId,
    pub system_role: SystemRole,
    #[serde(default)]
    pub groups: Vec<UserGroupId>,
}

impl Actor {
    pub fn new(user_id: UserId, system_role: SystemRole) -> Self {
        Self {
            user_id,
            system_role,
            groups: Vec::new(),
        }
    }

    /// 所属グループを添えて作る。
    pub fn with_groups(mut self, groups: Vec<UserGroupId>) -> Self {
        self.groups = groups;
        self
    }

    /// この人を指しうる相手の一覧 (本人 + 所属グループ)。
    pub fn principals(&self) -> Vec<Principal> {
        let mut out = vec![Principal::User(self.user_id.clone())];
        out.extend(self.groups.iter().cloned().map(Principal::Group));
        out
    }

    /// 付与の一覧から、この人に届く最も強い役割を拾う。
    pub fn strongest(&self, access: &[AccessEntry]) -> Option<ProjectRole> {
        let mine = self.principals();
        access
            .iter()
            .filter(|entry| mine.contains(&entry.principal))
            .map(|entry| entry.role)
            .max()
    }

    /// プロジェクトに対する実効的な役割。
    ///
    /// プロジェクトへの直接の付与と、それが属するプロジェクトグループへの
    /// 付与のうち、**強いほうを採る**。どちらにも無ければ `None`。
    /// システム管理者は、共有されていなくても閲覧者として扱う
    /// (実際の可否は [`Actor::may`] が別途通す)。
    pub fn effective_role(
        &self,
        meta: &ProjectMeta,
        project_group: Option<&ProjectGroup>,
    ) -> Option<ProjectRole> {
        let direct = self.strongest(&meta.access);
        let inherited = project_group.and_then(|group| self.strongest(&group.access));
        match direct.into_iter().chain(inherited).max() {
            Some(role) => Some(role),
            None if self.is_admin() => Some(ProjectRole::Viewer),
            None => None,
        }
    }

    pub fn is_admin(&self) -> bool {
        self.system_role == SystemRole::Admin
    }

    /// プロジェクトに対する操作を許すか。
    ///
    /// `role` はそのプロジェクトでの役割。共有されていなければ `None`。
    /// システム管理者はどのプロジェクトにも通す (運用でどうしても必要になるため)。
    pub fn may(&self, permission: Permission, role: Option<ProjectRole>) -> bool {
        if self.is_admin() {
            return true;
        }
        match permission {
            // 誰でも自分のプロジェクトは作れる。
            Permission::ProjectCreate => true,
            // アカウント管理は管理者だけ (上で通っているのでここは常に false)。
            Permission::UserManage => false,
            Permission::ProjectRead => Self::has(role, ProjectRole::Viewer),
            Permission::ProjectWrite => Self::has(role, ProjectRole::Editor),
            Permission::ProjectManage => Self::has(role, ProjectRole::Owner),
            Permission::CommentPost => Self::has(role, ProjectRole::Viewer),
        }
    }

    fn has(role: Option<ProjectRole>, needed: ProjectRole) -> bool {
        role.is_some_and(|actual| actual.at_least(needed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member() -> Actor {
        Actor::new(UserId::new("u1"), SystemRole::Member)
    }

    fn meta(access: Vec<AccessEntry>) -> ProjectMeta {
        ProjectMeta {
            id: crate::model::ProjectId::new("p"),
            name: "p".into(),
            created_at: String::new(),
            updated_at: String::new(),
            group_id: None,
            due_date: None,
            access,
            status: None,
            task_count: 0,
            member_count: 0,
        }
    }

    fn folder(access: Vec<AccessEntry>) -> ProjectGroup {
        ProjectGroup {
            id: crate::model::ProjectGroupId::new("folder"),
            name: "folder".into(),
            access,
            created_at: String::new(),
        }
    }

    fn admin() -> Actor {
        Actor::new(UserId::new("root"), SystemRole::Admin)
    }

    #[test]
    fn the_permission_matrix() {
        use Permission::*;
        use ProjectRole::*;

        // (役割, 読む, 書く, 管理する)
        for (role, read, write, manage) in [
            (None, false, false, false),
            (Some(Viewer), true, false, false),
            (Some(Editor), true, true, false),
            (Some(Owner), true, true, true),
        ] {
            assert_eq!(member().may(ProjectRead, role), read, "{role:?} の読み");
            assert_eq!(member().may(ProjectWrite, role), write, "{role:?} の書き");
            assert_eq!(member().may(ProjectManage, role), manage, "{role:?} の管理");
        }
    }

    #[test]
    fn a_viewer_may_still_comment() {
        // 見てもらって意見だけもらう、ができるようにしておく。
        use Permission::CommentPost;
        use ProjectRole::*;
        assert!(!member().may(CommentPost, None), "見られない人は書けない");
        for role in [Viewer, Editor, Owner] {
            assert!(member().may(CommentPost, Some(role)), "{role:?}");
        }
    }

    #[test]
    fn anyone_can_create_a_project() {
        assert!(member().may(Permission::ProjectCreate, None));
    }

    #[test]
    fn only_admins_manage_accounts() {
        assert!(!member().may(Permission::UserManage, None));
        assert!(admin().may(Permission::UserManage, None));
    }

    #[test]
    fn an_admin_reaches_every_project() {
        for permission in [
            Permission::ProjectRead,
            Permission::ProjectWrite,
            Permission::ProjectManage,
        ] {
            assert!(admin().may(permission, None), "{permission:?}");
        }
    }

    #[test]
    fn a_grant_to_my_group_reaches_me() {
        let actor = member().with_groups(vec![UserGroupId::new("team")]);
        let project = meta(vec![AccessEntry::new(
            Principal::group("team"),
            ProjectRole::Editor,
        )]);
        assert_eq!(
            actor.effective_role(&project, None),
            Some(ProjectRole::Editor)
        );

        // 所属していなければ届かない。
        assert_eq!(member().effective_role(&project, None), None);
    }

    #[test]
    fn the_strongest_grant_wins() {
        let actor = member().with_groups(vec![UserGroupId::new("team")]);
        // 本人には閲覧、グループには編集。強いほうを採る。
        let project = meta(vec![
            AccessEntry::new(Principal::user("u1"), ProjectRole::Viewer),
            AccessEntry::new(Principal::group("team"), ProjectRole::Editor),
        ]);
        assert_eq!(
            actor.effective_role(&project, None),
            Some(ProjectRole::Editor)
        );
    }

    #[test]
    fn a_grant_on_the_project_group_is_inherited() {
        let actor = member().with_groups(vec![UserGroupId::new("team")]);
        let project = meta(Vec::new());
        let parent = folder(vec![AccessEntry::new(
            Principal::group("team"),
            ProjectRole::Owner,
        )]);
        assert_eq!(
            actor.effective_role(&project, Some(&parent)),
            Some(ProjectRole::Owner)
        );
        // 入れ物を外せば届かなくなる。
        assert_eq!(actor.effective_role(&project, None), None);
    }

    #[test]
    fn a_direct_grant_can_be_stronger_than_the_inherited_one() {
        let actor = member();
        let project = meta(vec![AccessEntry::new(
            Principal::user("u1"),
            ProjectRole::Owner,
        )]);
        let parent = folder(vec![AccessEntry::new(
            Principal::user("u1"),
            ProjectRole::Viewer,
        )]);
        assert_eq!(
            actor.effective_role(&project, Some(&parent)),
            Some(ProjectRole::Owner)
        );
    }

    #[test]
    fn an_admin_sees_projects_that_were_never_shared() {
        assert_eq!(
            admin().effective_role(&meta(Vec::new()), None),
            Some(ProjectRole::Viewer)
        );
    }

    #[test]
    fn roles_are_ordered_by_strength() {
        assert!(ProjectRole::Owner > ProjectRole::Editor);
        assert!(ProjectRole::Editor > ProjectRole::Viewer);
        assert!(ProjectRole::Owner.at_least(ProjectRole::Viewer));
        assert!(!ProjectRole::Viewer.at_least(ProjectRole::Editor));
    }
}

/// 権限の判定を**有界モデル検査**で確かめる。
///
/// ここは「画面で隠す」のではなく「実際に止める」唯一の場所なので、
/// 効き方に穴があると、そのまま権限の抜け道になる。役割も操作も有限個なので、
/// **すべての組み合わせ**を虱潰しに証明できる。
#[cfg(kani)]
mod verification {
    use super::*;

    fn any_role() -> Option<ProjectRole> {
        match kani::any::<u8>() % 4 {
            0 => None,
            1 => Some(ProjectRole::Viewer),
            2 => Some(ProjectRole::Editor),
            _ => Some(ProjectRole::Owner),
        }
    }

    fn any_permission() -> Permission {
        match kani::any::<u8>() % 6 {
            0 => Permission::ProjectRead,
            1 => Permission::ProjectWrite,
            2 => Permission::ProjectManage,
            3 => Permission::ProjectCreate,
            4 => Permission::UserManage,
            _ => Permission::CommentPost,
        }
    }

    /// 役割は全順序で、`at_least` はその順序と一致すること。
    #[kani::proof]
    fn roles_are_totally_ordered() {
        let (a, b, c) = (
            any_role().unwrap_or(ProjectRole::Viewer),
            any_role().unwrap_or(ProjectRole::Viewer),
            any_role().unwrap_or(ProjectRole::Viewer),
        );
        assert!(a.at_least(a), "反射律");
        if a.at_least(b) && b.at_least(a) {
            assert!(a == b, "反対称律");
        }
        if a.at_least(b) && b.at_least(c) {
            assert!(a.at_least(c), "推移律");
        }
        assert!(a.at_least(b) || b.at_least(a), "全順序");
        assert!(ProjectRole::Owner.at_least(a), "owner は最強");
        assert!(a.at_least(ProjectRole::Viewer), "viewer は最弱");
    }

    /// **強い役割でできることは、弱い役割でもできる、ということはない。**
    ///
    /// 逆向き — 役割を上げて、できることが減らないこと (単調性) を示す。
    /// ここが破れていると「編集者にしたら見られなくなった」が起こりうる。
    #[kani::proof]
    fn a_stronger_role_can_never_do_less() {
        let weak = any_role();
        let strong = any_role();
        let permission = any_permission();
        kani::assume(match (weak, strong) {
            (None, _) => true,
            (Some(w), Some(s)) => s.at_least(w),
            (Some(_), None) => false,
        });

        let actor = Actor::new(UserId::new("u"), SystemRole::Member);
        if actor.may(permission, weak) {
            assert!(
                actor.may(permission, strong),
                "役割を上げたのにできなくなった"
            );
        }
    }

    /// 共有されていない人 (`role` が `None`) は、一般ユーザなら
    /// **プロジェクトを作ること以外は何もできない**。
    #[kani::proof]
    fn an_unshared_member_can_do_nothing_to_the_project() {
        let permission = any_permission();
        let actor = Actor::new(UserId::new("u"), SystemRole::Member);
        let allowed = actor.may(permission, None);
        assert_eq!(
            allowed,
            permission == Permission::ProjectCreate,
            "共有されていないのに通った"
        );
    }

    /// 管理する権限は、**必ず所有者以上**でなければ通らない。
    #[kani::proof]
    fn managing_always_requires_owner() {
        let role = any_role();
        let actor = Actor::new(UserId::new("u"), SystemRole::Member);
        if actor.may(Permission::ProjectManage, role) {
            assert_eq!(role, Some(ProjectRole::Owner), "所有者でないのに管理できた");
        }
        // 書き換えは編集者以上。
        if actor.may(Permission::ProjectWrite, role) {
            assert!(
                role.is_some_and(|r| r.at_least(ProjectRole::Editor)),
                "編集者未満なのに書き換えられた"
            );
        }
    }
}
