//! API の中身。権限を確かめてから [`Store`] を触る。
//!
//! 時刻と新しい ID は**呼び出し側から渡す**。WASM のなかに時計も乱数源も
//! 持ち込まずに済み、同じ入力なら必ず同じ結果になるのでテストしやすい。
//! サーバで動かすときは、サーバがそれらを用意する。

use crate::error::{ApiError, ApiResult};
use crate::model::{
    Document, Project, ProjectAccess, ProjectId, ProjectRole, ProjectSummary, SystemRole, User,
    UserId,
};
use crate::permission::{Actor, Permission};
use crate::store::Store;

/// 新しいアカウントの中身。
#[derive(Debug, Clone)]
pub struct NewUser {
    pub id: UserId,
    pub name: String,
    pub email: Option<String>,
    pub system_role: SystemRole,
}

/// アカウントの変更内容。`None` の項目は据え置き。
#[derive(Debug, Clone, Default)]
pub struct UserPatch {
    pub name: Option<String>,
    pub email: Option<Option<String>>,
    pub system_role: Option<SystemRole>,
}

pub struct Service<S: Store> {
    store: S,
}

fn trimmed(value: &str, field: &str) -> ApiResult<String> {
    let text = value.trim();
    if text.is_empty() {
        return Err(ApiError::invalid(format!("{field} が空です")));
    }
    Ok(text.to_string())
}

impl<S: Store> Service<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    pub fn into_store(self) -> S {
        self.store
    }

    /// 呼び出し元を組み立てる。存在しないアカウントは通さない。
    pub fn actor(&self, user_id: &UserId) -> ApiResult<Actor> {
        let user = self
            .store
            .user(user_id)
            .ok_or_else(|| ApiError::unauthorized("アカウントが見つかりません"))?;
        Ok(Actor::new(user.id, user.system_role))
    }

    /* ===== アカウント ===== */

    pub fn me(&self, actor: &Actor) -> ApiResult<User> {
        self.store
            .user(&actor.user_id)
            .ok_or_else(|| ApiError::unauthorized("アカウントが見つかりません"))
    }

    /// アカウント一覧。管理者でなくても、誰に共有できるか選ぶために名前は見える。
    pub fn list_users(&self, _actor: &Actor) -> ApiResult<Vec<User>> {
        let mut users = self.store.users();
        users.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(users)
    }

    pub fn create_user(&mut self, actor: &Actor, now: &str, input: NewUser) -> ApiResult<User> {
        self.require(actor, Permission::UserManage, None)?;
        if self.store.user(&input.id).is_some() {
            return Err(ApiError::conflict("同じ id のアカウントがあります"));
        }
        let user = User {
            id: input.id,
            name: trimmed(&input.name, "名前")?,
            email: input.email,
            system_role: input.system_role,
            created_at: now.to_string(),
        };
        self.store.put_user(user.clone());
        Ok(user)
    }

    /// アカウントを更新する。管理者、または本人 (役割は変えられない)。
    pub fn update_user(&mut self, actor: &Actor, id: &UserId, patch: UserPatch) -> ApiResult<User> {
        let is_self = &actor.user_id == id;
        if !is_self {
            self.require(actor, Permission::UserManage, None)?;
        }
        if patch.system_role.is_some() && !actor.is_admin() {
            return Err(ApiError::forbidden("自分の役割は変更できません"));
        }

        let mut user = self
            .store
            .user(id)
            .ok_or_else(|| ApiError::not_found("アカウントが見つかりません"))?;
        if let Some(name) = patch.name {
            user.name = trimmed(&name, "名前")?;
        }
        if let Some(email) = patch.email {
            user.email = email;
        }
        if let Some(role) = patch.system_role {
            if user.system_role == SystemRole::Admin && role != SystemRole::Admin {
                self.ensure_another_admin_exists(id)?;
            }
            user.system_role = role;
        }
        self.store.put_user(user.clone());
        Ok(user)
    }

    pub fn delete_user(&mut self, actor: &Actor, id: &UserId) -> ApiResult<()> {
        self.require(actor, Permission::UserManage, None)?;
        let user = self
            .store
            .user(id)
            .ok_or_else(|| ApiError::not_found("アカウントが見つかりません"))?;
        if user.system_role == SystemRole::Admin {
            self.ensure_another_admin_exists(id)?;
        }
        // 所有者が居なくなるプロジェクトを作らない。
        for project in self.store.projects() {
            let owners: Vec<_> = project
                .access
                .iter()
                .filter(|entry| entry.role == ProjectRole::Owner)
                .collect();
            if owners.len() == 1 && owners[0].user_id == *id {
                return Err(ApiError::conflict(format!(
                    "プロジェクト「{}」の唯一の所有者です。先に所有者を移してください",
                    project.name
                )));
            }
        }
        self.store.remove_user(id);
        Ok(())
    }

    /* ===== プロジェクト ===== */

    /// 自分が見られるプロジェクトの一覧。更新が新しい順。
    pub fn list_projects(&self, actor: &Actor) -> ApiResult<Vec<ProjectSummary>> {
        let mut out: Vec<ProjectSummary> = self
            .store
            .projects()
            .into_iter()
            .filter_map(|project| {
                let role = project.role_of(&actor.user_id).or_else(|| {
                    // 管理者は共有されていなくても見える。役割は viewer 扱い。
                    actor.is_admin().then_some(ProjectRole::Viewer)
                })?;
                let owner_name = project
                    .owner()
                    .and_then(|id| self.store.user(id))
                    .map(|user| user.name)
                    .unwrap_or_default();
                Some(project.summary(role, owner_name))
            })
            .collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    pub fn create_project(
        &mut self,
        actor: &Actor,
        now: &str,
        id: ProjectId,
        name: &str,
        document: Document,
    ) -> ApiResult<Project> {
        self.require(actor, Permission::ProjectCreate, None)?;
        if self.store.project(&id).is_some() {
            return Err(ApiError::conflict("同じ id のプロジェクトがあります"));
        }
        let project = Project {
            id,
            name: trimmed(name, "プロジェクト名")?,
            created_at: now.to_string(),
            updated_at: now.to_string(),
            access: vec![ProjectAccess {
                user_id: actor.user_id.clone(),
                role: ProjectRole::Owner,
            }],
            document,
        };
        self.store.put_project(project.clone());
        Ok(project)
    }

    pub fn get_project(&self, actor: &Actor, id: &ProjectId) -> ApiResult<Project> {
        let project = self.lookup(id)?;
        self.require(
            actor,
            Permission::ProjectRead,
            project.role_of(&actor.user_id),
        )?;
        Ok(project)
    }

    pub fn save_document(
        &mut self,
        actor: &Actor,
        id: &ProjectId,
        now: &str,
        document: Document,
    ) -> ApiResult<ProjectSummary> {
        let mut project = self.lookup(id)?;
        self.require(
            actor,
            Permission::ProjectWrite,
            project.role_of(&actor.user_id),
        )?;
        project.document = document;
        project.updated_at = now.to_string();
        self.store.put_project(project.clone());
        Ok(self.summarize(&project, actor))
    }

    pub fn rename_project(
        &mut self,
        actor: &Actor,
        id: &ProjectId,
        now: &str,
        name: &str,
    ) -> ApiResult<ProjectSummary> {
        let mut project = self.lookup(id)?;
        self.require(
            actor,
            Permission::ProjectManage,
            project.role_of(&actor.user_id),
        )?;
        project.name = trimmed(name, "プロジェクト名")?;
        project.updated_at = now.to_string();
        self.store.put_project(project.clone());
        Ok(self.summarize(&project, actor))
    }

    pub fn delete_project(&mut self, actor: &Actor, id: &ProjectId) -> ApiResult<()> {
        let project = self.lookup(id)?;
        self.require(
            actor,
            Permission::ProjectManage,
            project.role_of(&actor.user_id),
        )?;
        self.store.remove_project(id);
        Ok(())
    }

    /// 複製する。複製した人が新しい所有者になる。
    pub fn duplicate_project(
        &mut self,
        actor: &Actor,
        id: &ProjectId,
        now: &str,
        new_id: ProjectId,
        name: &str,
    ) -> ApiResult<Project> {
        let source = self.get_project(actor, id)?;
        self.create_project(actor, now, new_id, name, source.document)
    }

    /* ===== 権限 ===== */

    pub fn list_access(&self, actor: &Actor, id: &ProjectId) -> ApiResult<Vec<ProjectAccess>> {
        let project = self.lookup(id)?;
        self.require(
            actor,
            Permission::ProjectRead,
            project.role_of(&actor.user_id),
        )?;
        Ok(project.access)
    }

    pub fn set_access(
        &mut self,
        actor: &Actor,
        id: &ProjectId,
        now: &str,
        user_id: &UserId,
        role: ProjectRole,
    ) -> ApiResult<Vec<ProjectAccess>> {
        let mut project = self.lookup(id)?;
        self.require(
            actor,
            Permission::ProjectManage,
            project.role_of(&actor.user_id),
        )?;
        if self.store.user(user_id).is_none() {
            return Err(ApiError::not_found("アカウントが見つかりません"));
        }
        // 所有者が 1 人も居なくなる変更は通さない。
        if role != ProjectRole::Owner {
            Self::ensure_owner_remains(&project, user_id)?;
        }

        match project
            .access
            .iter_mut()
            .find(|entry| &entry.user_id == user_id)
        {
            Some(entry) => entry.role = role,
            None => project.access.push(ProjectAccess {
                user_id: user_id.clone(),
                role,
            }),
        }
        project.updated_at = now.to_string();
        self.store.put_project(project.clone());
        Ok(project.access)
    }

    pub fn remove_access(
        &mut self,
        actor: &Actor,
        id: &ProjectId,
        now: &str,
        user_id: &UserId,
    ) -> ApiResult<Vec<ProjectAccess>> {
        let mut project = self.lookup(id)?;
        self.require(
            actor,
            Permission::ProjectManage,
            project.role_of(&actor.user_id),
        )?;
        Self::ensure_owner_remains(&project, user_id)?;
        project.access.retain(|entry| &entry.user_id != user_id);
        project.updated_at = now.to_string();
        self.store.put_project(project.clone());
        Ok(project.access)
    }

    /* ===== 内部 ===== */

    fn lookup(&self, id: &ProjectId) -> ApiResult<Project> {
        self.store
            .project(id)
            .ok_or_else(|| ApiError::not_found("プロジェクトが見つかりません"))
    }

    fn require(
        &self,
        actor: &Actor,
        permission: Permission,
        role: Option<ProjectRole>,
    ) -> ApiResult<()> {
        if actor.may(permission, role) {
            Ok(())
        } else {
            Err(ApiError::forbidden(format!(
                "この操作には権限が足りません ({permission:?})"
            )))
        }
    }

    fn summarize(&self, project: &Project, actor: &Actor) -> ProjectSummary {
        let role = project
            .role_of(&actor.user_id)
            .unwrap_or(ProjectRole::Viewer);
        let owner_name = project
            .owner()
            .and_then(|id| self.store.user(id))
            .map(|user| user.name)
            .unwrap_or_default();
        project.summary(role, owner_name)
    }

    /// `changing` の役割を落としても、まだ所有者が残るか。
    fn ensure_owner_remains(project: &Project, changing: &UserId) -> ApiResult<()> {
        let remaining = project
            .access
            .iter()
            .filter(|entry| entry.role == ProjectRole::Owner && &entry.user_id != changing)
            .count();
        if remaining == 0 {
            return Err(ApiError::conflict(
                "所有者がいなくなります。先に別の所有者を立ててください",
            ));
        }
        Ok(())
    }

    fn ensure_another_admin_exists(&self, excluding: &UserId) -> ApiResult<()> {
        let remaining = self
            .store
            .users()
            .into_iter()
            .filter(|user| user.system_role == SystemRole::Admin && &user.id != excluding)
            .count();
        if remaining == 0 {
            return Err(ApiError::conflict("管理者が 1 人もいなくなります"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;

    const NOW: &str = "2026-09-20T10:00:00Z";
    const LATER: &str = "2026-09-21T10:00:00Z";

    /// 管理者 1 人と一般 2 人が居るところから始める。
    fn setup() -> Service<MemoryStore> {
        let mut store = MemoryStore::new();
        for (id, name, role) in [
            ("root", "管理者", SystemRole::Admin),
            ("alice", "佐藤", SystemRole::Member),
            ("bob", "鈴木", SystemRole::Member),
            ("carol", "田中", SystemRole::Member),
        ] {
            store.put_user(User {
                id: UserId::new(id),
                name: name.into(),
                email: None,
                system_role: role,
                created_at: NOW.into(),
            });
        }
        Service::new(store)
    }

    fn actor(service: &Service<MemoryStore>, id: &str) -> Actor {
        service.actor(&UserId::new(id)).expect("居るはず")
    }

    fn make_project(service: &mut Service<MemoryStore>, owner: &str, id: &str) -> Project {
        let who = actor(service, owner);
        service
            .create_project(&who, NOW, ProjectId::new(id), id, Document::default())
            .expect("作れるはず")
    }

    #[test]
    fn an_unknown_caller_is_refused() {
        let service = setup();
        let error = service.actor(&UserId::new("居ない")).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Unauthorized);
    }

    #[test]
    fn the_creator_becomes_the_owner() {
        let mut service = setup();
        let project = make_project(&mut service, "alice", "p1");
        assert_eq!(project.owner(), Some(&UserId::new("alice")));
        assert_eq!(
            project.role_of(&UserId::new("alice")),
            Some(ProjectRole::Owner)
        );
        assert_eq!(project.role_of(&UserId::new("bob")), None);
    }

    #[test]
    fn a_project_is_invisible_until_it_is_shared() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");

        let bob = actor(&service, "bob");
        assert!(service.list_projects(&bob).unwrap().is_empty());
        let error = service
            .get_project(&bob, &ProjectId::new("p1"))
            .unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Forbidden);

        // 共有すると見えるようになる。
        let alice = actor(&service, "alice");
        service
            .set_access(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                &UserId::new("bob"),
                ProjectRole::Viewer,
            )
            .unwrap();
        assert_eq!(service.list_projects(&bob).unwrap().len(), 1);
        assert!(service.get_project(&bob, &ProjectId::new("p1")).is_ok());
    }

    #[test]
    fn a_viewer_cannot_write() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        service
            .set_access(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                &UserId::new("bob"),
                ProjectRole::Viewer,
            )
            .unwrap();

        let bob = actor(&service, "bob");
        let error = service
            .save_document(&bob, &ProjectId::new("p1"), LATER, Document::default())
            .unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Forbidden);
    }

    #[test]
    fn an_editor_can_write_but_not_manage() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        service
            .set_access(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                &UserId::new("bob"),
                ProjectRole::Editor,
            )
            .unwrap();

        let bob = actor(&service, "bob");
        assert!(service
            .save_document(&bob, &ProjectId::new("p1"), LATER, Document::default())
            .is_ok());
        assert_eq!(
            service
                .rename_project(&bob, &ProjectId::new("p1"), LATER, "別名")
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Forbidden
        );
        assert_eq!(
            service
                .delete_project(&bob, &ProjectId::new("p1"))
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Forbidden
        );
    }

    #[test]
    fn an_admin_reaches_projects_that_were_never_shared() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let root = actor(&service, "root");

        assert_eq!(service.list_projects(&root).unwrap().len(), 1);
        assert!(service.get_project(&root, &ProjectId::new("p1")).is_ok());
        assert!(service
            .rename_project(&root, &ProjectId::new("p1"), LATER, "管理者が改名")
            .is_ok());
    }

    #[test]
    fn a_project_never_loses_its_last_owner() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        let id = ProjectId::new("p1");

        // 自分を降格させようとしても止まる。
        assert_eq!(
            service
                .set_access(
                    &alice,
                    &id,
                    LATER,
                    &UserId::new("alice"),
                    ProjectRole::Editor
                )
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Conflict
        );
        assert_eq!(
            service
                .remove_access(&alice, &id, LATER, &UserId::new("alice"))
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Conflict
        );

        // 別の所有者を立ててからなら降りられる。
        service
            .set_access(&alice, &id, LATER, &UserId::new("bob"), ProjectRole::Owner)
            .unwrap();
        assert!(service
            .remove_access(&alice, &id, LATER, &UserId::new("alice"))
            .is_ok());
    }

    #[test]
    fn sharing_with_an_unknown_account_fails() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        let error = service
            .set_access(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                &UserId::new("居ない"),
                ProjectRole::Editor,
            )
            .unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::NotFound);
    }

    #[test]
    fn the_list_is_newest_first_and_carries_my_role() {
        let mut service = setup();
        make_project(&mut service, "alice", "old");
        let alice = actor(&service, "alice");
        service
            .create_project(
                &alice,
                LATER,
                ProjectId::new("new"),
                "new",
                Document::default(),
            )
            .unwrap();

        let list = service.list_projects(&alice).unwrap();
        assert_eq!(list[0].id, ProjectId::new("new"), "更新が新しい順");
        assert_eq!(list[0].role, ProjectRole::Owner);
        assert_eq!(list[0].owner_name, "佐藤");
    }

    #[test]
    fn saving_a_document_updates_the_timestamp_and_counts() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");

        let mut document = Document::default();
        document.tasks.push(crate::model::Task {
            id: "t1".into(),
            name: "設計".into(),
            parent_id: None,
            group: String::new(),
            priority: crate::model::Priority::Normal,
            enabled: true,
            min: "1".into(),
            likely: "2".into(),
            max: "3".into(),
            start_date: None,
            progress: 0.0,
            end_date: None,
            assignee_id: None,
        });

        let summary = service
            .save_document(&alice, &ProjectId::new("p1"), LATER, document)
            .unwrap();
        assert_eq!(summary.task_count, 1);
        assert_eq!(summary.updated_at, LATER);
        assert_eq!(summary.created_at, NOW, "作成日時は動かない");
    }

    #[test]
    fn duplicating_copies_the_content_and_resets_the_owner() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        service
            .set_access(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                &UserId::new("bob"),
                ProjectRole::Viewer,
            )
            .unwrap();

        // 閲覧者でも複製はできる。複製した本人が所有者になる。
        let bob = actor(&service, "bob");
        let copy = service
            .duplicate_project(
                &bob,
                &ProjectId::new("p1"),
                LATER,
                ProjectId::new("p2"),
                "複製",
            )
            .unwrap();
        assert_eq!(copy.owner(), Some(&UserId::new("bob")));
        assert_eq!(copy.access.len(), 1, "共有は引き継がない");
        assert_eq!(copy.document, Document::default());
    }

    #[test]
    fn names_cannot_be_blank() {
        let mut service = setup();
        let alice = actor(&service, "alice");
        assert_eq!(
            service
                .create_project(&alice, NOW, ProjectId::new("p"), "   ", Document::default())
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Invalid
        );
    }

    #[test]
    fn duplicate_ids_are_refused() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        assert_eq!(
            service
                .create_project(
                    &alice,
                    NOW,
                    ProjectId::new("p1"),
                    "別名",
                    Document::default()
                )
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Conflict
        );
    }

    #[test]
    fn only_an_admin_manages_accounts() {
        let mut service = setup();
        let alice = actor(&service, "alice");
        let root = actor(&service, "root");

        let new_user = || NewUser {
            id: UserId::new("dave"),
            name: "高橋".into(),
            email: None,
            system_role: SystemRole::Member,
        };
        assert_eq!(
            service
                .create_user(&alice, NOW, new_user())
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Forbidden
        );
        assert!(service.create_user(&root, NOW, new_user()).is_ok());
        assert_eq!(
            service
                .delete_user(&alice, &UserId::new("dave"))
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Forbidden
        );
        assert!(service.delete_user(&root, &UserId::new("dave")).is_ok());
    }

    #[test]
    fn anyone_can_rename_themselves_but_not_promote_themselves() {
        let mut service = setup();
        let alice = actor(&service, "alice");
        let updated = service
            .update_user(
                &alice,
                &UserId::new("alice"),
                UserPatch {
                    name: Some("佐藤 太郎".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.name, "佐藤 太郎");

        assert_eq!(
            service
                .update_user(
                    &alice,
                    &UserId::new("alice"),
                    UserPatch {
                        system_role: Some(SystemRole::Admin),
                        ..Default::default()
                    },
                )
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Forbidden
        );

        // 他人の名前は変えられない。
        assert_eq!(
            service
                .update_user(
                    &alice,
                    &UserId::new("bob"),
                    UserPatch {
                        name: Some("勝手に改名".into()),
                        ..Default::default()
                    },
                )
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Forbidden
        );
    }

    #[test]
    fn the_last_admin_cannot_be_removed_or_demoted() {
        let mut service = setup();
        let root = actor(&service, "root");
        assert_eq!(
            service
                .delete_user(&root, &UserId::new("root"))
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Conflict
        );
        assert_eq!(
            service
                .update_user(
                    &root,
                    &UserId::new("root"),
                    UserPatch {
                        system_role: Some(SystemRole::Member),
                        ..Default::default()
                    },
                )
                .unwrap_err()
                .code,
            crate::error::ErrorCode::Conflict
        );
    }

    #[test]
    fn deleting_a_sole_owner_is_refused_so_no_project_is_orphaned() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let root = actor(&service, "root");

        let error = service
            .delete_user(&root, &UserId::new("alice"))
            .unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Conflict);
        assert!(
            error.message.contains("p1"),
            "どのプロジェクトか分かる: {error}"
        );

        // 所有者を移せば消せる。
        let alice = actor(&service, "alice");
        service
            .set_access(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                &UserId::new("bob"),
                ProjectRole::Owner,
            )
            .unwrap();
        assert!(service.delete_user(&root, &UserId::new("alice")).is_ok());
        // 権限からも消える。
        let project = service.store().project(&ProjectId::new("p1")).unwrap();
        assert!(project.role_of(&UserId::new("alice")).is_none());
    }

    #[test]
    fn deleting_a_project_needs_ownership() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        assert!(service
            .delete_project(&alice, &ProjectId::new("p1"))
            .is_ok());
        assert_eq!(
            service
                .get_project(&alice, &ProjectId::new("p1"))
                .unwrap_err()
                .code,
            crate::error::ErrorCode::NotFound
        );
    }
}
