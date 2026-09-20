//! 誰が何をしてよいかの判定。
//!
//! 判定はここ 1 か所にしかなく、ローカルでもサーバでも同じコードが動く。
//! 画面側で出し分けるのはあくまで見た目の話で、実際に止めるのはここ。

use serde::{Deserialize, Serialize};

use crate::model::{ProjectRole, SystemRole, UserId};

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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub user_id: UserId,
    pub system_role: SystemRole,
}

impl Actor {
    pub fn new(user_id: UserId, system_role: SystemRole) -> Self {
        Self {
            user_id,
            system_role,
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
    fn roles_are_ordered_by_strength() {
        assert!(ProjectRole::Owner > ProjectRole::Editor);
        assert!(ProjectRole::Editor > ProjectRole::Viewer);
        assert!(ProjectRole::Owner.at_least(ProjectRole::Viewer));
        assert!(!ProjectRole::Viewer.at_least(ProjectRole::Editor));
    }
}
