//! API の中身。権限を確かめてから [`Store`] を触る。
//!
//! 時刻と新しい ID は**呼び出し側から渡す**。WASM のなかに時計も乱数源も
//! 持ち込まずに済み、同じ入力なら必ず同じ結果になるのでテストしやすい。
//! サーバで動かすときは、サーバがそれらを用意する。
//!
//! 同時実行の直列化はここでは行わない。「読む → 判定 → 書く」で完結させ、
//! 直列化は呼び出し側 (サーバの書き込みロック) に任せている。

use crate::error::{ApiError, ApiResult};
use crate::health;
use crate::model::{
    AccessEntry, Document, Principal, Project, ProjectGroup, ProjectGroupId, ProjectId,
    ProjectMeta, ProjectRole, ProjectStatus, ProjectSummary, SystemRole, User, UserGroup,
    UserGroupId, UserId,
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

/// プロジェクトの見出しの変更内容。`None` の項目は据え置き。
#[derive(Debug, Clone, Default)]
pub struct ProjectPatch {
    pub name: Option<String>,
    /// `Some(None)` でどのグループにも属さない状態に戻す。
    pub group_id: Option<Option<ProjectGroupId>>,
    /// `Some(None)` で期限を外す。
    pub due_date: Option<Option<String>>,
}

pub struct Service<S: Store> {
    store: S,
}

/// 所有者として振る舞えるアカウントの集合。
///
/// 数人しか入らないので、並べ替えた `Vec` で足りる。`BTreeSet` を使うと
/// そのためだけに木の実装が WASM に載ってしまう。
#[derive(Debug, Default)]
struct Owners(Vec<UserId>);

impl Owners {
    fn insert(&mut self, id: UserId) {
        if let Err(at) = self.0.binary_search(&id) {
            self.0.insert(at, id);
        }
    }

    fn remove(&mut self, id: &UserId) {
        self.0.retain(|existing| existing != id);
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn contains(&self, id: &UserId) -> bool {
        self.0.binary_search(id).is_ok()
    }

    /// 全員がこのグループのメンバーか (= このグループを消すと誰も残らない)。
    fn all_within(&self, members: &[UserId]) -> bool {
        self.0.iter().all(|id| members.contains(id))
    }
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
    ///
    /// 所属グループもここで解決して詰める。以後の権限判定はこの `Actor` だけを見る。
    pub fn actor(&self, user_id: &UserId) -> ApiResult<Actor> {
        let user = self
            .store
            .user(user_id)?
            .ok_or_else(|| ApiError::unauthorized("アカウントが見つかりません"))?;
        let groups = self
            .store
            .user_groups()?
            .into_iter()
            .filter(|group| group.contains(user_id))
            .map(|group| group.id)
            .collect();
        Ok(Actor::new(user.id, user.system_role).with_groups(groups))
    }

    /* ===== アカウント ===== */

    pub fn me(&self, actor: &Actor) -> ApiResult<User> {
        self.store
            .user(&actor.user_id)?
            .ok_or_else(|| ApiError::unauthorized("アカウントが見つかりません"))
    }

    /// アカウント一覧。共有先を選ぶために、管理者でなくても名前は見える。
    pub fn list_users(&self, _actor: &Actor) -> ApiResult<Vec<User>> {
        let mut users = self.store.users()?;
        users.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(users)
    }

    pub fn create_user(&mut self, actor: &Actor, now: &str, input: NewUser) -> ApiResult<User> {
        self.require(actor, Permission::UserManage, None)?;
        if self.store.user(&input.id)?.is_some() {
            return Err(ApiError::conflict("同じ id のアカウントがあります"));
        }
        let user = User {
            id: input.id,
            name: trimmed(&input.name, "名前")?,
            email: input.email,
            system_role: input.system_role,
            created_at: now.to_string(),
        };
        self.store.put_user(user.clone())?;
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
            .user(id)?
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
        self.store.put_user(user.clone())?;
        Ok(user)
    }

    pub fn delete_user(&mut self, actor: &Actor, id: &UserId) -> ApiResult<()> {
        self.require(actor, Permission::UserManage, None)?;
        let user = self
            .store
            .user(id)?
            .ok_or_else(|| ApiError::not_found("アカウントが見つかりません"))?;
        if user.system_role == SystemRole::Admin {
            self.ensure_another_admin_exists(id)?;
        }

        // 所有者が居なくなるプロジェクトを作らない。グループ経由で所有者に
        // なっている人も数えるので、「チームに owner を付けてある」場合は消せる。
        let groups = self.store.project_groups()?;
        for meta in self.store.project_metas()? {
            let parent = Self::parent_of(&meta, &groups);
            let mut owners = self.owner_users(&meta, parent)?;
            owners.remove(id);
            if owners.is_empty() {
                return Err(ApiError::conflict(format!(
                    "プロジェクト「{}」の唯一の所有者です。先に所有者を移してください",
                    meta.name
                )));
            }
        }
        self.store.remove_user(id)?;
        Ok(())
    }

    /* ===== アカウントのグループ ===== */

    pub fn list_user_groups(&self, _actor: &Actor) -> ApiResult<Vec<UserGroup>> {
        let mut groups = self.store.user_groups()?;
        groups.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(groups)
    }

    pub fn create_user_group(
        &mut self,
        actor: &Actor,
        now: &str,
        id: UserGroupId,
        name: &str,
    ) -> ApiResult<UserGroup> {
        self.require(actor, Permission::UserManage, None)?;
        if self.store.user_group(&id)?.is_some() {
            return Err(ApiError::conflict("同じ id のグループがあります"));
        }
        let group = UserGroup {
            id,
            name: trimmed(name, "グループ名")?,
            members: Vec::new(),
            created_at: now.to_string(),
        };
        self.store.put_user_group(group.clone())?;
        Ok(group)
    }

    pub fn rename_user_group(
        &mut self,
        actor: &Actor,
        id: &UserGroupId,
        name: &str,
    ) -> ApiResult<UserGroup> {
        self.require(actor, Permission::UserManage, None)?;
        let mut group = self.lookup_user_group(id)?;
        group.name = trimmed(name, "グループ名")?;
        self.store.put_user_group(group.clone())?;
        Ok(group)
    }

    pub fn delete_user_group(&mut self, actor: &Actor, id: &UserGroupId) -> ApiResult<()> {
        self.require(actor, Permission::UserManage, None)?;
        let group = self.lookup_user_group(id)?;

        // このグループを消すと所有者が居なくなるプロジェクトがないか確かめる。
        let groups = self.store.project_groups()?;
        for meta in self.store.project_metas()? {
            let parent = Self::parent_of(&meta, &groups);
            let owners = self.owner_users(&meta, parent)?;
            if owners.is_empty() {
                continue;
            }
            let via_group = Self::grants_owner(&meta.access, id)
                || parent.is_some_and(|folder| Self::grants_owner(&folder.access, id));
            if via_group && owners.all_within(&group.members) {
                return Err(ApiError::conflict(format!(
                    "プロジェクト「{}」の所有者がこのグループ経由だけになっています。\
                     先に別の所有者を立ててください",
                    meta.name
                )));
            }
        }

        self.store.remove_user_group(id)?;
        Ok(())
    }

    pub fn set_group_member(
        &mut self,
        actor: &Actor,
        id: &UserGroupId,
        user_id: &UserId,
        member: bool,
    ) -> ApiResult<UserGroup> {
        self.require(actor, Permission::UserManage, None)?;
        if self.store.user(user_id)?.is_none() {
            return Err(ApiError::not_found("アカウントが見つかりません"));
        }
        let mut group = self.lookup_user_group(id)?;
        if member {
            if !group.contains(user_id) {
                group.members.push(user_id.clone());
            }
        } else {
            group.members.retain(|existing| existing != user_id);
        }
        self.store.put_user_group(group.clone())?;
        Ok(group)
    }

    /* ===== プロジェクトのグループ ===== */

    pub fn list_project_groups(&self, _actor: &Actor) -> ApiResult<Vec<ProjectGroup>> {
        let mut groups = self.store.project_groups()?;
        groups.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(groups)
    }

    pub fn create_project_group(
        &mut self,
        actor: &Actor,
        now: &str,
        id: ProjectGroupId,
        name: &str,
    ) -> ApiResult<ProjectGroup> {
        self.require(actor, Permission::ProjectCreate, None)?;
        if self.store.project_group(&id)?.is_some() {
            return Err(ApiError::conflict("同じ id のグループがあります"));
        }
        // 作った人が所有者。これが無いと誰も権限を配れない入れ物ができてしまう。
        let group = ProjectGroup {
            id,
            name: trimmed(name, "グループ名")?,
            access: vec![AccessEntry::new(
                Principal::User(actor.user_id.clone()),
                ProjectRole::Owner,
            )],
            created_at: now.to_string(),
        };
        self.store.put_project_group(group.clone())?;
        Ok(group)
    }

    pub fn rename_project_group(
        &mut self,
        actor: &Actor,
        id: &ProjectGroupId,
        name: &str,
    ) -> ApiResult<ProjectGroup> {
        let group = self.lookup_project_group(id)?;
        self.require_group_manage(actor, &group)?;
        let renamed = ProjectGroup {
            name: trimmed(name, "グループ名")?,
            ..group
        };
        self.store.put_project_group(renamed.clone())?;
        Ok(renamed)
    }

    pub fn delete_project_group(&mut self, actor: &Actor, id: &ProjectGroupId) -> ApiResult<()> {
        let group = self.lookup_project_group(id)?;
        self.require_group_manage(actor, &group)?;

        // 配下のプロジェクトが、このグループ経由でしか所有者を持たないなら止める。
        for meta in self.store.project_metas()? {
            if meta.group_id.as_ref() != Some(id) {
                continue;
            }
            if self.owner_users(&meta, None)?.is_empty() {
                return Err(ApiError::conflict(format!(
                    "プロジェクト「{}」の所有者がこのグループ経由だけになっています。\
                     先に別の所有者を立ててください",
                    meta.name
                )));
            }
        }

        self.store.remove_project_group(id)?;
        Ok(())
    }

    pub fn set_group_access(
        &mut self,
        actor: &Actor,
        id: &ProjectGroupId,
        principal: &Principal,
        role: Option<ProjectRole>,
    ) -> ApiResult<ProjectGroup> {
        let mut group = self.lookup_project_group(id)?;
        self.require_group_manage(actor, &group)?;
        self.ensure_principal_exists(principal)?;

        group.access.retain(|entry| &entry.principal != principal);
        if let Some(role) = role {
            group.access.push(AccessEntry::new(principal.clone(), role));
        }
        if !group.access.iter().any(|e| e.role == ProjectRole::Owner) {
            return Err(ApiError::conflict(
                "グループの所有者がいなくなります。先に別の所有者を立ててください",
            ));
        }
        self.store.put_project_group(group.clone())?;
        Ok(group)
    }

    /* ===== プロジェクト ===== */

    /// 自分が見られるプロジェクトの一覧。既定では、気にすべきものが先に来る。
    pub fn list_projects(&self, actor: &Actor, now: &str) -> ApiResult<Vec<ProjectSummary>> {
        let groups = self.store.project_groups()?;
        let users = self.store.users()?;
        let today = health::today_of(now);

        let mut out = Vec::new();
        for meta in self.store.project_metas()? {
            let parent = Self::parent_of(&meta, &groups);
            let Some(role) = actor.effective_role(&meta, parent) else {
                continue;
            };
            let owners = self.owner_users(&meta, parent)?;
            let owner_names = users
                .iter()
                .filter(|user| owners.contains(&user.id))
                .map(|user| user.name.clone())
                .collect();
            out.push(ProjectSummary {
                id: meta.id.clone(),
                name: meta.name.clone(),
                created_at: meta.created_at.clone(),
                updated_at: meta.updated_at.clone(),
                role,
                group_id: meta.group_id.clone(),
                group_name: parent.map(|group| group.name.clone()),
                due_date: meta.due_date.clone(),
                health: health::health(&meta, today),
                status: meta.status.clone(),
                owner_names,
                task_count: meta.task_count,
                member_count: meta.member_count,
            });
        }

        // 遅れているものが埋もれないよう、重いものから並べる。
        out.sort_by(|a, b| {
            a.health
                .severity()
                .cmp(&b.health.severity())
                .then(b.updated_at.cmp(&a.updated_at))
                .then(a.name.cmp(&b.name))
        });
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
        if self.store.project(&id)?.is_some() {
            return Err(ApiError::conflict("同じ id のプロジェクトがあります"));
        }
        let mut project = Project {
            meta: ProjectMeta {
                id,
                name: trimmed(name, "プロジェクト名")?,
                created_at: now.to_string(),
                updated_at: now.to_string(),
                group_id: None,
                due_date: None,
                access: vec![AccessEntry::new(
                    Principal::User(actor.user_id.clone()),
                    ProjectRole::Owner,
                )],
                status: None,
                task_count: 0,
                member_count: 0,
            },
            document,
        };
        project.refresh_counts();
        self.store.put_project(project.clone())?;
        Ok(project)
    }

    pub fn get_project(&self, actor: &Actor, id: &ProjectId) -> ApiResult<Project> {
        let project = self.lookup(id)?;
        let role = self.resolve(actor, &project.meta)?;
        self.require(actor, Permission::ProjectRead, role)?;
        Ok(project)
    }

    pub fn save_document(
        &mut self,
        actor: &Actor,
        id: &ProjectId,
        now: &str,
        document: Document,
        status: Option<ProjectStatus>,
    ) -> ApiResult<ProjectSummary> {
        let mut project = self.lookup(id)?;
        let role = self.resolve(actor, &project.meta)?;
        self.require(actor, Permission::ProjectWrite, role)?;

        project.document = document;
        project.meta.updated_at = now.to_string();
        // 控えは、いま保存する内容から計算されたもの。だから「何に基づくか」は
        // クライアントに書かせず、ここで保存時刻を刻む。
        // (サーバ経由のときクライアントはサーバの時計を知らないので、
        //  クライアントに書かせると必ず食い違う。)
        project.meta.status = status.map(|mut snapshot| {
            snapshot.based_on = now.to_string();
            snapshot
        });
        project.refresh_counts();
        self.store.put_project(project.clone())?;
        self.summarize(&project.meta, actor, now)
    }

    pub fn update_project(
        &mut self,
        actor: &Actor,
        id: &ProjectId,
        now: &str,
        patch: ProjectPatch,
    ) -> ApiResult<ProjectSummary> {
        let mut project = self.lookup(id)?;
        let role = self.resolve(actor, &project.meta)?;
        self.require(actor, Permission::ProjectManage, role)?;

        if let Some(name) = patch.name {
            project.meta.name = trimmed(&name, "プロジェクト名")?;
        }
        if let Some(group_id) = patch.group_id {
            if let Some(target) = &group_id {
                if self.store.project_group(target)?.is_none() {
                    return Err(ApiError::not_found("グループが見つかりません"));
                }
            }
            project.meta.group_id = group_id;
        }
        if let Some(due_date) = patch.due_date {
            if let Some(text) = &due_date {
                if health::day_of(text).is_none() {
                    return Err(ApiError::invalid("期限は YYYY-MM-DD で指定してください"));
                }
            }
            project.meta.due_date = due_date;
        }
        // `updated_at` は**中身**が変わった時刻。見出しの付け替えでは動かさない。
        // ここで動かすと、計算し直す必要が無いのに控えが「古い」ことになってしまう。
        self.store.put_project(project.clone())?;
        self.summarize(&project.meta, actor, now)
    }

    pub fn delete_project(&mut self, actor: &Actor, id: &ProjectId) -> ApiResult<()> {
        let project = self.lookup(id)?;
        let role = self.resolve(actor, &project.meta)?;
        self.require(actor, Permission::ProjectManage, role)?;
        self.store.remove_project(id)?;
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

    pub fn list_access(&self, actor: &Actor, id: &ProjectId) -> ApiResult<Vec<AccessEntry>> {
        let project = self.lookup(id)?;
        let role = self.resolve(actor, &project.meta)?;
        self.require(actor, Permission::ProjectRead, role)?;
        Ok(project.meta.access)
    }

    /// 権限を与える・変更する。`role` が `None` なら取り消す。
    pub fn set_access(
        &mut self,
        actor: &Actor,
        id: &ProjectId,
        principal: &Principal,
        role: Option<ProjectRole>,
    ) -> ApiResult<Vec<AccessEntry>> {
        let mut project = self.lookup(id)?;
        let current = self.resolve(actor, &project.meta)?;
        self.require(actor, Permission::ProjectManage, current)?;
        self.ensure_principal_exists(principal)?;

        project
            .meta
            .access
            .retain(|entry| &entry.principal != principal);
        if let Some(role) = role {
            project
                .meta
                .access
                .push(AccessEntry::new(principal.clone(), role));
        }

        // 所有者が「実際に 1 人以上いる」ことを確かめる。メンバーの居ない
        // グループに owner を付けて、実質的に誰も触れなくなるのを防ぐ。
        let groups = self.store.project_groups()?;
        let parent = Self::parent_of(&project.meta, &groups);
        if self.owner_users(&project.meta, parent)?.is_empty() {
            return Err(ApiError::conflict(
                "所有者がいなくなります。先に別の所有者を立ててください",
            ));
        }

        self.store.put_project(project.clone())?;
        Ok(project.meta.access)
    }

    /* ===== 内部 ===== */

    fn lookup(&self, id: &ProjectId) -> ApiResult<Project> {
        self.store
            .project(id)?
            .ok_or_else(|| ApiError::not_found("プロジェクトが見つかりません"))
    }

    fn lookup_user_group(&self, id: &UserGroupId) -> ApiResult<UserGroup> {
        self.store
            .user_group(id)?
            .ok_or_else(|| ApiError::not_found("グループが見つかりません"))
    }

    fn lookup_project_group(&self, id: &ProjectGroupId) -> ApiResult<ProjectGroup> {
        self.store
            .project_group(id)?
            .ok_or_else(|| ApiError::not_found("グループが見つかりません"))
    }

    /// そのプロジェクトが属する入れ物を、読み込み済みの一覧から引く。
    fn parent_of<'a>(meta: &ProjectMeta, groups: &'a [ProjectGroup]) -> Option<&'a ProjectGroup> {
        let id = meta.group_id.as_ref()?;
        groups.iter().find(|group| &group.id == id)
    }

    /// そのプロジェクトに対する呼び出し元の実効的な役割。
    fn resolve(&self, actor: &Actor, meta: &ProjectMeta) -> ApiResult<Option<ProjectRole>> {
        let parent = match &meta.group_id {
            Some(id) => self.store.project_group(id)?,
            None => None,
        };
        Ok(actor.effective_role(meta, parent.as_ref()))
    }

    /// 実際に所有者として振る舞えるアカウントの集合。
    ///
    /// 付与の相手がグループなら、そのメンバーに展開する。存在しない
    /// アカウントは数えない。
    fn owner_users(&self, meta: &ProjectMeta, parent: Option<&ProjectGroup>) -> ApiResult<Owners> {
        let mut out = Owners::default();
        let entries = meta
            .access
            .iter()
            .chain(parent.into_iter().flat_map(|group| group.access.iter()));
        for entry in entries {
            if entry.role != ProjectRole::Owner {
                continue;
            }
            match &entry.principal {
                Principal::User(id) => {
                    if self.store.user(id)?.is_some() {
                        out.insert(id.clone());
                    }
                }
                Principal::Group(id) => {
                    if let Some(group) = self.store.user_group(id)? {
                        for member in group.members {
                            if self.store.user(&member)?.is_some() {
                                out.insert(member);
                            }
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    /// その付与一覧が、指定のグループに所有者を与えているか。
    fn grants_owner(access: &[AccessEntry], group: &UserGroupId) -> bool {
        access.iter().any(|entry| {
            entry.role == ProjectRole::Owner
                && matches!(&entry.principal, Principal::Group(id) if id == group)
        })
    }

    fn ensure_principal_exists(&self, principal: &Principal) -> ApiResult<()> {
        let exists = match principal {
            Principal::User(id) => self.store.user(id)?.is_some(),
            Principal::Group(id) => self.store.user_group(id)?.is_some(),
        };
        if exists {
            Ok(())
        } else {
            Err(ApiError::not_found("指定した相手が見つかりません"))
        }
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

    /// プロジェクトグループを管理できるか。所有者、または管理者。
    fn require_group_manage(&self, actor: &Actor, group: &ProjectGroup) -> ApiResult<()> {
        let role = actor.strongest(&group.access);
        self.require(actor, Permission::ProjectManage, role)
    }

    fn summarize(&self, meta: &ProjectMeta, actor: &Actor, now: &str) -> ApiResult<ProjectSummary> {
        let groups = self.store.project_groups()?;
        let parent = Self::parent_of(meta, &groups);
        let owners = self.owner_users(meta, parent)?;
        let owner_names = self
            .store
            .users()?
            .into_iter()
            .filter(|user| owners.contains(&user.id))
            .map(|user| user.name)
            .collect();
        Ok(ProjectSummary {
            id: meta.id.clone(),
            name: meta.name.clone(),
            created_at: meta.created_at.clone(),
            updated_at: meta.updated_at.clone(),
            role: actor
                .effective_role(meta, parent)
                .unwrap_or(ProjectRole::Viewer),
            group_id: meta.group_id.clone(),
            group_name: parent.map(|group| group.name.clone()),
            due_date: meta.due_date.clone(),
            health: health::health(meta, health::today_of(now)),
            status: meta.status.clone(),
            owner_names,
            task_count: meta.task_count,
            member_count: meta.member_count,
        })
    }

    fn ensure_another_admin_exists(&self, excluding: &UserId) -> ApiResult<()> {
        let remaining = self
            .store
            .users()?
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
    use crate::error::ErrorCode;
    use crate::health::ProjectHealth;
    use crate::model::{Priority, Task};
    use crate::store::MemoryStore;

    const NOW: &str = "2026-09-20T10:00:00Z";
    const LATER: &str = "2026-09-21T10:00:00Z";

    /// 管理者 1 人と一般 3 人が居るところから始める。
    fn setup() -> Service<MemoryStore> {
        let mut store = MemoryStore::new();
        for (id, name, role) in [
            ("root", "管理者", SystemRole::Admin),
            ("alice", "佐藤", SystemRole::Member),
            ("bob", "鈴木", SystemRole::Member),
            ("carol", "田中", SystemRole::Member),
        ] {
            store
                .put_user(User {
                    id: UserId::new(id),
                    name: name.into(),
                    email: None,
                    system_role: role,
                    created_at: NOW.into(),
                })
                .unwrap();
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

    /// 誰かに権限を配る。
    fn share(
        service: &mut Service<MemoryStore>,
        by: &str,
        id: &str,
        to: Principal,
        role: ProjectRole,
    ) {
        let who = actor(service, by);
        service
            .set_access(&who, &ProjectId::new(id), &to, Some(role))
            .expect("配れるはず");
    }

    fn task(id: &str) -> Task {
        Task {
            id: id.into(),
            name: id.into(),
            parent_id: None,
            group: String::new(),
            priority: Priority::Normal,
            enabled: true,
            min: "1".into(),
            likely: "2".into(),
            max: "3".into(),
            start_date: None,
            progress: 0.0,
            end_date: None,
            assignee_id: None,
        }
    }

    /* ===== 基本 ===== */

    #[test]
    fn an_unknown_caller_is_refused() {
        let service = setup();
        let error = service.actor(&UserId::new("居ない")).unwrap_err();
        assert_eq!(error.code, ErrorCode::Unauthorized);
    }

    #[test]
    fn the_creator_becomes_the_owner() {
        let mut service = setup();
        let project = make_project(&mut service, "alice", "p1");
        assert_eq!(
            project.meta.role_for(&Principal::user("alice")),
            Some(ProjectRole::Owner)
        );
        assert_eq!(project.meta.role_for(&Principal::user("bob")), None);
    }

    #[test]
    fn a_project_is_invisible_until_it_is_shared() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");

        let bob = actor(&service, "bob");
        assert!(service.list_projects(&bob, NOW).unwrap().is_empty());
        let error = service
            .get_project(&bob, &ProjectId::new("p1"))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Forbidden);

        share(
            &mut service,
            "alice",
            "p1",
            Principal::user("bob"),
            ProjectRole::Viewer,
        );
        assert_eq!(service.list_projects(&bob, NOW).unwrap().len(), 1);
        assert!(service.get_project(&bob, &ProjectId::new("p1")).is_ok());
    }

    #[test]
    fn a_viewer_cannot_write() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        share(
            &mut service,
            "alice",
            "p1",
            Principal::user("bob"),
            ProjectRole::Viewer,
        );

        let bob = actor(&service, "bob");
        let error = service
            .save_document(
                &bob,
                &ProjectId::new("p1"),
                LATER,
                Document::default(),
                None,
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Forbidden);
    }

    #[test]
    fn an_editor_can_write_but_not_manage() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        share(
            &mut service,
            "alice",
            "p1",
            Principal::user("bob"),
            ProjectRole::Editor,
        );

        let bob = actor(&service, "bob");
        assert!(service
            .save_document(
                &bob,
                &ProjectId::new("p1"),
                LATER,
                Document::default(),
                None
            )
            .is_ok());

        let error = service
            .update_project(
                &bob,
                &ProjectId::new("p1"),
                LATER,
                ProjectPatch {
                    name: Some("改名".into()),
                    ..ProjectPatch::default()
                },
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Forbidden);
    }

    #[test]
    fn an_admin_reaches_projects_that_were_never_shared() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");

        let root = actor(&service, "root");
        assert!(service.get_project(&root, &ProjectId::new("p1")).is_ok());
        assert_eq!(
            service.list_projects(&root, NOW).unwrap().len(),
            1,
            "管理者の一覧には出る"
        );
    }

    #[test]
    fn sharing_with_an_unknown_account_fails() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        for principal in [Principal::user("居ない"), Principal::group("無い")] {
            let error = service
                .set_access(
                    &alice,
                    &ProjectId::new("p1"),
                    &principal,
                    Some(ProjectRole::Viewer),
                )
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::NotFound, "{principal:?}");
        }
    }

    #[test]
    fn saving_a_document_updates_the_timestamp_and_counts() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");

        let document = Document {
            tasks: vec![task("t1")],
            ..Document::default()
        };
        let summary = service
            .save_document(&alice, &ProjectId::new("p1"), LATER, document, None)
            .unwrap();
        assert_eq!(summary.task_count, 1);
        assert_eq!(summary.updated_at, LATER);
        assert_eq!(summary.created_at, NOW, "作成日時は動かない");
    }

    #[test]
    fn duplicating_copies_the_content_and_resets_the_owner() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        share(
            &mut service,
            "alice",
            "p1",
            Principal::user("bob"),
            ProjectRole::Viewer,
        );

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
        assert_eq!(
            copy.meta.role_for(&Principal::user("bob")),
            Some(ProjectRole::Owner)
        );
        assert_eq!(copy.meta.access.len(), 1, "共有は引き継がない");
        assert_eq!(copy.document, Document::default());
    }

    #[test]
    fn names_cannot_be_blank() {
        let mut service = setup();
        let alice = actor(&service, "alice");
        assert_eq!(
            service
                .create_project(&alice, NOW, ProjectId::new("p1"), "  ", Document::default())
                .unwrap_err()
                .code,
            ErrorCode::Invalid
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
            ErrorCode::Conflict
        );
    }

    #[test]
    fn deleting_a_project_needs_ownership() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        share(
            &mut service,
            "alice",
            "p1",
            Principal::user("bob"),
            ProjectRole::Editor,
        );

        let bob = actor(&service, "bob");
        assert_eq!(
            service
                .delete_project(&bob, &ProjectId::new("p1"))
                .unwrap_err()
                .code,
            ErrorCode::Forbidden
        );

        let alice = actor(&service, "alice");
        assert!(service
            .delete_project(&alice, &ProjectId::new("p1"))
            .is_ok());
    }

    /* ===== アカウント ===== */

    #[test]
    fn only_an_admin_manages_accounts() {
        let mut service = setup();
        let alice = actor(&service, "alice");
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
            ErrorCode::Forbidden
        );

        let root = actor(&service, "root");
        assert!(service.create_user(&root, NOW, new_user()).is_ok());
        assert_eq!(
            service
                .create_user(&root, NOW, new_user())
                .unwrap_err()
                .code,
            ErrorCode::Conflict,
            "同じ id は作れない"
        );
    }

    #[test]
    fn anyone_can_rename_themselves_but_not_promote_themselves() {
        let mut service = setup();
        let alice = actor(&service, "alice");

        let renamed = service
            .update_user(
                &alice,
                &UserId::new("alice"),
                UserPatch {
                    name: Some("佐藤 (改)".into()),
                    ..UserPatch::default()
                },
            )
            .unwrap();
        assert_eq!(renamed.name, "佐藤 (改)");

        assert_eq!(
            service
                .update_user(
                    &alice,
                    &UserId::new("alice"),
                    UserPatch {
                        system_role: Some(SystemRole::Admin),
                        ..UserPatch::default()
                    },
                )
                .unwrap_err()
                .code,
            ErrorCode::Forbidden
        );

        assert_eq!(
            service
                .update_user(
                    &alice,
                    &UserId::new("bob"),
                    UserPatch {
                        name: Some("勝手に改名".into()),
                        ..UserPatch::default()
                    },
                )
                .unwrap_err()
                .code,
            ErrorCode::Forbidden,
            "他人は触れない"
        );
    }

    #[test]
    fn the_last_admin_cannot_be_removed_or_demoted() {
        let mut service = setup();
        let root = actor(&service, "root");

        assert_eq!(
            service
                .update_user(
                    &root,
                    &UserId::new("root"),
                    UserPatch {
                        system_role: Some(SystemRole::Member),
                        ..UserPatch::default()
                    },
                )
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            service
                .delete_user(&root, &UserId::new("root"))
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn deleting_a_sole_owner_is_refused_so_no_project_is_orphaned() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let root = actor(&service, "root");

        assert_eq!(
            service
                .delete_user(&root, &UserId::new("alice"))
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );

        // 別の所有者を立てれば消せる。
        share(
            &mut service,
            "alice",
            "p1",
            Principal::user("bob"),
            ProjectRole::Owner,
        );
        let root = actor(&service, "root");
        assert!(service.delete_user(&root, &UserId::new("alice")).is_ok());
    }

    /* ===== 不変条件: 所有者 ===== */

    #[test]
    fn a_project_never_loses_its_last_owner() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");

        assert_eq!(
            service
                .set_access(
                    &alice,
                    &ProjectId::new("p1"),
                    &Principal::user("alice"),
                    None,
                )
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            service
                .set_access(
                    &alice,
                    &ProjectId::new("p1"),
                    &Principal::user("alice"),
                    Some(ProjectRole::Viewer),
                )
                .unwrap_err()
                .code,
            ErrorCode::Conflict,
            "降格も同じこと"
        );
    }

    #[test]
    fn an_empty_group_cannot_stand_in_for_the_owner() {
        // メンバーの居ないグループに owner を付けて自分を外せば、
        // 誰も触れないプロジェクトが残ってしまう。そこを塞ぐ。
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let root = actor(&service, "root");
        service
            .create_user_group(&root, NOW, UserGroupId::new("empty"), "空のチーム")
            .unwrap();

        share(
            &mut service,
            "alice",
            "p1",
            Principal::group("empty"),
            ProjectRole::Owner,
        );

        let alice = actor(&service, "alice");
        assert_eq!(
            service
                .set_access(
                    &alice,
                    &ProjectId::new("p1"),
                    &Principal::user("alice"),
                    None,
                )
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );

        // メンバーを入れれば、そのグループが所有者として通る。
        let root = actor(&service, "root");
        service
            .set_group_member(&root, &UserGroupId::new("empty"), &UserId::new("bob"), true)
            .unwrap();
        let alice = actor(&service, "alice");
        assert!(service
            .set_access(
                &alice,
                &ProjectId::new("p1"),
                &Principal::user("alice"),
                None,
            )
            .is_ok());
    }

    #[test]
    fn a_group_that_is_the_only_owner_cannot_be_deleted() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let root = actor(&service, "root");
        service
            .create_user_group(&root, NOW, UserGroupId::new("team"), "チーム")
            .unwrap();
        let root = actor(&service, "root");
        service
            .set_group_member(&root, &UserGroupId::new("team"), &UserId::new("bob"), true)
            .unwrap();

        share(
            &mut service,
            "alice",
            "p1",
            Principal::group("team"),
            ProjectRole::Owner,
        );
        let alice = actor(&service, "alice");
        service
            .set_access(
                &alice,
                &ProjectId::new("p1"),
                &Principal::user("alice"),
                None,
            )
            .unwrap();

        let root = actor(&service, "root");
        assert_eq!(
            service
                .delete_user_group(&root, &UserGroupId::new("team"))
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    /* ===== グループ ===== */

    #[test]
    fn a_user_group_hands_its_access_to_every_member() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let root = actor(&service, "root");
        service
            .create_user_group(&root, NOW, UserGroupId::new("team"), "チーム")
            .unwrap();
        let root = actor(&service, "root");
        service
            .set_group_member(&root, &UserGroupId::new("team"), &UserId::new("bob"), true)
            .unwrap();

        share(
            &mut service,
            "alice",
            "p1",
            Principal::group("team"),
            ProjectRole::Editor,
        );

        let bob = actor(&service, "bob");
        assert_eq!(
            service.list_projects(&bob, NOW).unwrap()[0].role,
            ProjectRole::Editor
        );
        let carol = actor(&service, "carol");
        assert!(
            service.list_projects(&carol, NOW).unwrap().is_empty(),
            "メンバーでない人には配られない"
        );
    }

    #[test]
    fn the_strongest_grant_wins() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let root = actor(&service, "root");
        service
            .create_user_group(&root, NOW, UserGroupId::new("team"), "チーム")
            .unwrap();
        let root = actor(&service, "root");
        service
            .set_group_member(&root, &UserGroupId::new("team"), &UserId::new("bob"), true)
            .unwrap();

        // 本人には閲覧、グループには編集。強いほうが効く。
        share(
            &mut service,
            "alice",
            "p1",
            Principal::user("bob"),
            ProjectRole::Viewer,
        );
        share(
            &mut service,
            "alice",
            "p1",
            Principal::group("team"),
            ProjectRole::Editor,
        );

        let bob = actor(&service, "bob");
        assert_eq!(
            service.list_projects(&bob, NOW).unwrap()[0].role,
            ProjectRole::Editor
        );
    }

    #[test]
    fn a_project_group_hands_its_access_down() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        service
            .create_project_group(&alice, NOW, ProjectGroupId::new("dept"), "第一部")
            .unwrap();
        let alice = actor(&service, "alice");
        service
            .set_group_access(
                &alice,
                &ProjectGroupId::new("dept"),
                &Principal::user("bob"),
                Some(ProjectRole::Viewer),
            )
            .unwrap();

        let bob = actor(&service, "bob");
        assert!(
            service.list_projects(&bob, NOW).unwrap().is_empty(),
            "まだ入れていない"
        );

        let alice = actor(&service, "alice");
        service
            .update_project(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                ProjectPatch {
                    group_id: Some(Some(ProjectGroupId::new("dept"))),
                    ..ProjectPatch::default()
                },
            )
            .unwrap();

        let bob = actor(&service, "bob");
        let listed = service.list_projects(&bob, NOW).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].role, ProjectRole::Viewer);
        assert_eq!(listed[0].group_name.as_deref(), Some("第一部"));
    }

    #[test]
    fn a_project_group_keeps_at_least_one_owner() {
        let mut service = setup();
        let alice = actor(&service, "alice");
        service
            .create_project_group(&alice, NOW, ProjectGroupId::new("dept"), "第一部")
            .unwrap();

        let alice = actor(&service, "alice");
        assert_eq!(
            service
                .set_group_access(
                    &alice,
                    &ProjectGroupId::new("dept"),
                    &Principal::user("alice"),
                    None,
                )
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn only_someone_who_owns_a_project_group_may_change_it() {
        let mut service = setup();
        let alice = actor(&service, "alice");
        service
            .create_project_group(&alice, NOW, ProjectGroupId::new("dept"), "第一部")
            .unwrap();

        let bob = actor(&service, "bob");
        assert_eq!(
            service
                .rename_project_group(&bob, &ProjectGroupId::new("dept"), "乗っ取り")
                .unwrap_err()
                .code,
            ErrorCode::Forbidden
        );

        let root = actor(&service, "root");
        assert!(service
            .rename_project_group(&root, &ProjectGroupId::new("dept"), "第二部")
            .is_ok());
    }

    #[test]
    fn deleting_a_project_group_detaches_its_projects() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        service
            .create_project_group(&alice, NOW, ProjectGroupId::new("dept"), "第一部")
            .unwrap();
        let alice = actor(&service, "alice");
        service
            .update_project(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                ProjectPatch {
                    group_id: Some(Some(ProjectGroupId::new("dept"))),
                    ..ProjectPatch::default()
                },
            )
            .unwrap();

        let alice = actor(&service, "alice");
        service
            .delete_project_group(&alice, &ProjectGroupId::new("dept"))
            .unwrap();

        let alice = actor(&service, "alice");
        let project = service.get_project(&alice, &ProjectId::new("p1")).unwrap();
        assert_eq!(project.meta.group_id, None, "所属だけ外れて残る");
    }

    #[test]
    fn an_unknown_project_group_is_refused() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");
        assert_eq!(
            service
                .update_project(
                    &alice,
                    &ProjectId::new("p1"),
                    LATER,
                    ProjectPatch {
                        group_id: Some(Some(ProjectGroupId::new("無い"))),
                        ..ProjectPatch::default()
                    },
                )
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }

    /* ===== 一覧と状態 ===== */

    #[test]
    fn a_snapshot_is_stamped_with_the_time_it_was_saved() {
        // サーバ経由だとクライアントはサーバの時計を知らない。だから
        // 「何に基づく控えか」はクライアントに書かせず、保存時に刻む。
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let alice = actor(&service, "alice");

        let sent = ProjectStatus {
            based_on: "クライアントが勝手に入れた値".into(),
            computed_at: LATER.into(),
            task_count: 1,
            ..ProjectStatus::default()
        };
        let summary = service
            .save_document(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                Document {
                    tasks: vec![task("t1")],
                    ..Document::default()
                },
                Some(sent),
            )
            .unwrap();

        let status = summary.status.expect("控えが残る");
        assert_eq!(status.based_on, LATER, "保存時刻が刻まれる");
        assert_eq!(status.computed_at, LATER, "計算した時刻はそのまま");
        assert_ne!(summary.health, ProjectHealth::Unknown);
    }

    #[test]
    fn a_snapshot_goes_stale_only_when_the_content_changes() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let document = Document {
            tasks: vec![task("t1")],
            ..Document::default()
        };

        let alice = actor(&service, "alice");
        service
            .save_document(
                &alice,
                &ProjectId::new("p1"),
                LATER,
                document.clone(),
                Some(ProjectStatus {
                    task_count: 1,
                    ..ProjectStatus::default()
                }),
            )
            .unwrap();

        // 改名や期限の付け替えでは、計算し直す必要は無い。
        let alice = actor(&service, "alice");
        let summary = service
            .update_project(
                &alice,
                &ProjectId::new("p1"),
                "2026-09-22T09:00:00Z",
                ProjectPatch {
                    name: Some("改名".into()),
                    ..ProjectPatch::default()
                },
            )
            .unwrap();
        assert_ne!(
            summary.health,
            ProjectHealth::Unknown,
            "見出しを変えただけで控えが古くなってはいけない"
        );
        assert_eq!(summary.updated_at, LATER, "中身は触っていない");

        // 中身を控え無しで保存すると、そこで初めて古くなる。
        let alice = actor(&service, "alice");
        let summary = service
            .save_document(
                &alice,
                &ProjectId::new("p1"),
                "2026-09-23T09:00:00Z",
                document,
                None,
            )
            .unwrap();
        assert_eq!(summary.health, ProjectHealth::Unknown);
        assert!(summary.status.is_none());
    }

    #[test]
    fn the_list_puts_the_ones_that_need_attention_first() {
        let mut service = setup();
        for id in ["late", "fine", "empty"] {
            make_project(&mut service, "alice", id);
        }

        let document = Document {
            tasks: vec![task("t1")],
            ..Document::default()
        };
        // 期限が P50 より手前 → 遅延。期限が P80 より後ろ → 順調。
        for (id, due, p50_offset) in [("late", "2026-10-01", 10_i64), ("fine", "2026-12-31", -10)] {
            let due_day = health::day_of(due).expect("読める日付");
            let alice = actor(&service, "alice");
            let status = ProjectStatus {
                computed_at: LATER.into(),
                based_on: LATER.into(),
                finish_p50: Some(due_day + p50_offset),
                finish_p80: Some(due_day + p50_offset + 5),
                task_count: 1,
                ..ProjectStatus::default()
            };
            service
                .save_document(
                    &alice,
                    &ProjectId::new(id),
                    LATER,
                    document.clone(),
                    Some(status),
                )
                .unwrap();
            let alice = actor(&service, "alice");
            service
                .update_project(
                    &alice,
                    &ProjectId::new(id),
                    LATER,
                    ProjectPatch {
                        due_date: Some(Some(due.into())),
                        ..ProjectPatch::default()
                    },
                )
                .unwrap();
        }

        let alice = actor(&service, "alice");
        let listed = service.list_projects(&alice, LATER).unwrap();
        assert_eq!(listed[0].name, "late");
        assert_eq!(listed[0].health, ProjectHealth::Late);
        assert!(listed[0].health.needs_attention());
        assert_eq!(
            listed.last().unwrap().health,
            ProjectHealth::NoTasks,
            "空のものは最後"
        );
    }

    #[test]
    fn the_list_carries_the_owner_names_including_the_ones_behind_a_group() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let root = actor(&service, "root");
        service
            .create_user_group(&root, NOW, UserGroupId::new("team"), "チーム")
            .unwrap();
        let root = actor(&service, "root");
        service
            .set_group_member(&root, &UserGroupId::new("team"), &UserId::new("bob"), true)
            .unwrap();
        share(
            &mut service,
            "alice",
            "p1",
            Principal::group("team"),
            ProjectRole::Owner,
        );

        let alice = actor(&service, "alice");
        let listed = service.list_projects(&alice, NOW).unwrap();
        assert_eq!(
            listed[0].owner_names,
            vec!["佐藤".to_string(), "鈴木".into()]
        );
    }

    #[test]
    fn a_project_with_no_grant_is_still_listed_for_an_admin_as_a_viewer() {
        let mut service = setup();
        make_project(&mut service, "alice", "p1");
        let root = actor(&service, "root");
        let listed = service.list_projects(&root, NOW).unwrap();
        assert_eq!(listed[0].role, ProjectRole::Viewer);
    }
}
