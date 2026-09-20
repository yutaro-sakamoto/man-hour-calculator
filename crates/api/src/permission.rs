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
