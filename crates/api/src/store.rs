//! データの置き場所。
//!
//! [`Store`] は「どこに置くか」を切り離すための口。ローカルでは
//! [`MemoryStore`] を WASM のなかに持ち、その中身を JSON にして
//! ブラウザやファイルに保存する。サーバでは同じ口の後ろが SQLite や
//! PostgreSQL になり、将来 DynamoDB にもなる。
//!
//! # 設計上の約束
//!
//! - **複数の対象にまたがるトランザクションを前提にしない。** 不変条件の検査は
//!   「読む → 判定 → 書く」で完結させ、同時実行の直列化は呼び出し側に任せる
//!   (サーバは書き込みロック、将来の DynamoDB なら条件付き書き込み)。
//! - **一覧は中身を読まない。** [`Store::project_metas`] は `Document` を含まない。
//!   プロジェクトが増えても一覧が重くならないようにするため。

use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::model::{
    Project, ProjectGroup, ProjectGroupId, ProjectId, ProjectMeta, User, UserGroup, UserGroupId,
    UserId,
};

/// 永続化の口。
pub trait Store {
    fn users(&self) -> ApiResult<Vec<User>>;
    fn user(&self, id: &UserId) -> ApiResult<Option<User>>;
    fn put_user(&mut self, user: User) -> ApiResult<()>;
    fn remove_user(&mut self, id: &UserId) -> ApiResult<bool>;

    fn user_groups(&self) -> ApiResult<Vec<UserGroup>>;
    fn user_group(&self, id: &UserGroupId) -> ApiResult<Option<UserGroup>>;
    fn put_user_group(&mut self, group: UserGroup) -> ApiResult<()>;
    fn remove_user_group(&mut self, id: &UserGroupId) -> ApiResult<bool>;

    fn project_groups(&self) -> ApiResult<Vec<ProjectGroup>>;
    fn project_group(&self, id: &ProjectGroupId) -> ApiResult<Option<ProjectGroup>>;
    fn put_project_group(&mut self, group: ProjectGroup) -> ApiResult<()>;
    fn remove_project_group(&mut self, id: &ProjectGroupId) -> ApiResult<bool>;

    /// 中身 (`Document`) を含まない一覧。
    fn project_metas(&self) -> ApiResult<Vec<ProjectMeta>>;
    fn project(&self, id: &ProjectId) -> ApiResult<Option<Project>>;
    fn put_project(&mut self, project: Project) -> ApiResult<()>;
    fn remove_project(&mut self, id: &ProjectId) -> ApiResult<bool>;
}

/// すべてをメモリに持つ実装。
///
/// そのまま JSON にできるので、ローカルではこれを丸ごと保存・復元して使う。
/// サーバのデータベースをダンプしたものと同じ位置づけ。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryStore {
    /// 保存形式のバージョン。読み込み時の互換性判断に使う。
    pub version: u32,
    pub users: Vec<User>,
    pub user_groups: Vec<UserGroup>,
    pub project_groups: Vec<ProjectGroup>,
    pub projects: Vec<Project>,
}

/// 現在の保存形式のバージョン。
pub const STORE_VERSION: u32 = 2;

impl MemoryStore {
    pub fn new() -> Self {
        Self {
            version: STORE_VERSION,
            ..Self::default()
        }
    }

    /// JSON から読み込む。古い形式は読める形に直してから受け取る。
    pub fn from_json(text: &str) -> ApiResult<Self> {
        let mut value: serde_json::Value = serde_json::from_str(text)
            .map_err(|e| ApiError::invalid(format!("保存データを読めません: {e}")))?;

        let version = value
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1) as u32;
        if version > STORE_VERSION {
            return Err(ApiError::invalid(format!(
                "保存データのバージョンが新しすぎます (data={version}, app={STORE_VERSION})"
            )));
        }
        if version < 2 {
            migrate_v1_to_v2(&mut value);
        }

        let mut store: Self = serde_json::from_value(value)
            .map_err(|e| ApiError::invalid(format!("保存データを読めません: {e}")))?;
        store.version = STORE_VERSION;
        // 中身から数え直しておく。古いデータには件数が入っていない。
        for project in &mut store.projects {
            project.refresh_counts();
        }
        Ok(store)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

/// v1 から v2 への移行。
///
/// v1 の権限は `{"userId": "...", "role": "..."}` というアカウント限定の形だった。
/// v2 では相手をアカウントにもグループにも取れるようにしたので、
/// 古い項目をアカウント指定に読み替える。保存済みのデータが
/// 開けなくなるのは避けたい。
fn migrate_v1_to_v2(value: &mut serde_json::Value) {
    use serde_json::{json, Value};

    if let Some(projects) = value.get_mut("projects").and_then(Value::as_array_mut) {
        for project in projects {
            let Some(access) = project.get_mut("access").and_then(Value::as_array_mut) else {
                continue;
            };
            for entry in access {
                let Some(user_id) = entry.get("userId").cloned() else {
                    continue;
                };
                let role = entry.get("role").cloned().unwrap_or(json!("viewer"));
                *entry = json!({
                    "principal": { "kind": "user", "id": user_id },
                    "role": role,
                });
            }
        }
    }
    value["version"] = json!(STORE_VERSION);
}

impl Store for MemoryStore {
    fn users(&self) -> ApiResult<Vec<User>> {
        Ok(self.users.clone())
    }

    fn user(&self, id: &UserId) -> ApiResult<Option<User>> {
        Ok(self.users.iter().find(|user| &user.id == id).cloned())
    }

    fn put_user(&mut self, user: User) -> ApiResult<()> {
        match self.users.iter_mut().find(|slot| slot.id == user.id) {
            Some(slot) => *slot = user,
            None => self.users.push(user),
        }
        Ok(())
    }

    fn remove_user(&mut self, id: &UserId) -> ApiResult<bool> {
        let before = self.users.len();
        self.users.retain(|user| &user.id != id);
        // 消えたアカウントの権限も一緒に落とす。残すと宙に浮く。
        let principal = crate::model::Principal::User(id.clone());
        for project in &mut self.projects {
            project
                .meta
                .access
                .retain(|entry| entry.principal != principal);
        }
        for group in &mut self.project_groups {
            group.access.retain(|entry| entry.principal != principal);
        }
        for group in &mut self.user_groups {
            group.members.retain(|member| member != id);
        }
        Ok(self.users.len() != before)
    }

    fn user_groups(&self) -> ApiResult<Vec<UserGroup>> {
        Ok(self.user_groups.clone())
    }

    fn user_group(&self, id: &UserGroupId) -> ApiResult<Option<UserGroup>> {
        Ok(self.user_groups.iter().find(|g| &g.id == id).cloned())
    }

    fn put_user_group(&mut self, group: UserGroup) -> ApiResult<()> {
        match self.user_groups.iter_mut().find(|slot| slot.id == group.id) {
            Some(slot) => *slot = group,
            None => self.user_groups.push(group),
        }
        Ok(())
    }

    fn remove_user_group(&mut self, id: &UserGroupId) -> ApiResult<bool> {
        let before = self.user_groups.len();
        self.user_groups.retain(|group| &group.id != id);
        // グループに与えていた権限も一緒に落とす。
        let principal = crate::model::Principal::Group(id.clone());
        for project in &mut self.projects {
            project
                .meta
                .access
                .retain(|entry| entry.principal != principal);
        }
        for group in &mut self.project_groups {
            group.access.retain(|entry| entry.principal != principal);
        }
        Ok(self.user_groups.len() != before)
    }

    fn project_groups(&self) -> ApiResult<Vec<ProjectGroup>> {
        Ok(self.project_groups.clone())
    }

    fn project_group(&self, id: &ProjectGroupId) -> ApiResult<Option<ProjectGroup>> {
        Ok(self.project_groups.iter().find(|g| &g.id == id).cloned())
    }

    fn put_project_group(&mut self, group: ProjectGroup) -> ApiResult<()> {
        match self
            .project_groups
            .iter_mut()
            .find(|slot| slot.id == group.id)
        {
            Some(slot) => *slot = group,
            None => self.project_groups.push(group),
        }
        Ok(())
    }

    fn remove_project_group(&mut self, id: &ProjectGroupId) -> ApiResult<bool> {
        let before = self.project_groups.len();
        self.project_groups.retain(|group| &group.id != id);
        // 配下だったプロジェクトは、どこにも属さない状態に戻す。
        for project in &mut self.projects {
            if project.meta.group_id.as_ref() == Some(id) {
                project.meta.group_id = None;
            }
        }
        Ok(self.project_groups.len() != before)
    }

    fn project_metas(&self) -> ApiResult<Vec<ProjectMeta>> {
        Ok(self
            .projects
            .iter()
            .map(|project| project.meta.clone())
            .collect())
    }

    fn project(&self, id: &ProjectId) -> ApiResult<Option<Project>> {
        Ok(self
            .projects
            .iter()
            .find(|project| &project.meta.id == id)
            .cloned())
    }

    fn put_project(&mut self, mut project: Project) -> ApiResult<()> {
        project.refresh_counts();
        match self
            .projects
            .iter_mut()
            .find(|slot| slot.meta.id == project.meta.id)
        {
            Some(slot) => *slot = project,
            None => self.projects.push(project),
        }
        Ok(())
    }

    fn remove_project(&mut self, id: &ProjectId) -> ApiResult<bool> {
        let before = self.projects.len();
        self.projects.retain(|project| &project.meta.id != id);
        Ok(self.projects.len() != before)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AccessEntry, Principal, ProjectRole, SystemRole};

    const NOW: &str = "2026-09-20T00:00:00Z";

    fn user(id: &str) -> User {
        User {
            id: UserId::new(id),
            name: id.to_string(),
            email: None,
            system_role: SystemRole::Member,
            created_at: NOW.into(),
        }
    }

    fn project(id: &str, owner: &str) -> Project {
        Project {
            meta: ProjectMeta {
                id: ProjectId::new(id),
                name: id.to_string(),
                created_at: NOW.into(),
                updated_at: NOW.into(),
                group_id: None,
                due_date: None,
                access: vec![AccessEntry::new(Principal::user(owner), ProjectRole::Owner)],
                status: None,
                task_count: 0,
                member_count: 0,
            },
            document: Default::default(),
        }
    }

    fn group(id: &str, members: &[&str]) -> UserGroup {
        UserGroup {
            id: UserGroupId::new(id),
            name: id.to_string(),
            members: members.iter().map(|m| UserId::new(*m)).collect(),
            created_at: NOW.into(),
        }
    }

    #[test]
    fn putting_the_same_id_replaces_instead_of_duplicating() {
        let mut store = MemoryStore::new();
        store.put_user(user("a")).unwrap();
        let mut renamed = user("a");
        renamed.name = "新しい名前".into();
        store.put_user(renamed).unwrap();

        assert_eq!(store.users().unwrap().len(), 1);
        assert_eq!(
            store.user(&UserId::new("a")).unwrap().unwrap().name,
            "新しい名前"
        );
    }

    #[test]
    fn removing_a_user_drops_their_access_and_group_membership() {
        let mut store = MemoryStore::new();
        store.put_user(user("a")).unwrap();
        store.put_user_group(group("team", &["a", "b"])).unwrap();
        store.put_project(project("p", "a")).unwrap();

        assert!(store.remove_user(&UserId::new("a")).unwrap());
        assert!(store
            .project(&ProjectId::new("p"))
            .unwrap()
            .unwrap()
            .meta
            .access
            .is_empty());
        assert_eq!(
            store
                .user_group(&UserGroupId::new("team"))
                .unwrap()
                .unwrap()
                .members,
            vec![UserId::new("b")]
        );
        assert!(
            !store.remove_user(&UserId::new("a")).unwrap(),
            "2 回目は何も消えない"
        );
    }

    #[test]
    fn removing_a_user_group_drops_the_grants_made_to_it() {
        let mut store = MemoryStore::new();
        store.put_user_group(group("team", &[])).unwrap();
        let mut p = project("p", "a");
        p.meta.access.push(AccessEntry::new(
            Principal::group("team"),
            ProjectRole::Editor,
        ));
        store.put_project(p).unwrap();

        assert!(store.remove_user_group(&UserGroupId::new("team")).unwrap());
        let access = store
            .project(&ProjectId::new("p"))
            .unwrap()
            .unwrap()
            .meta
            .access;
        assert_eq!(access.len(), 1, "アカウントへの付与だけが残る");
    }

    #[test]
    fn removing_a_project_group_detaches_its_projects() {
        let mut store = MemoryStore::new();
        store
            .put_project_group(ProjectGroup {
                id: ProjectGroupId::new("folder"),
                name: "folder".into(),
                access: Vec::new(),
                created_at: NOW.into(),
            })
            .unwrap();
        let mut p = project("p", "a");
        p.meta.group_id = Some(ProjectGroupId::new("folder"));
        store.put_project(p).unwrap();

        assert!(store
            .remove_project_group(&ProjectGroupId::new("folder"))
            .unwrap());
        assert_eq!(
            store
                .project(&ProjectId::new("p"))
                .unwrap()
                .unwrap()
                .meta
                .group_id,
            None
        );
    }

    #[test]
    fn the_light_listing_leaves_out_the_document() {
        let mut store = MemoryStore::new();
        let mut p = project("p", "a");
        p.document.tasks.push(crate::model::Task {
            id: "t".into(),
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
        store.put_project(p).unwrap();

        let metas = store.project_metas().unwrap();
        assert_eq!(metas.len(), 1);
        // 件数は控えられているが、中身そのものは返らない。
        assert_eq!(metas[0].task_count, 1);
    }

    #[test]
    fn the_store_round_trips_as_json() {
        let mut store = MemoryStore::new();
        store.put_user(user("a")).unwrap();
        store.put_user_group(group("team", &["a"])).unwrap();
        store.put_project(project("p", "a")).unwrap();

        let restored = MemoryStore::from_json(&store.to_json()).unwrap();
        assert_eq!(restored, store);
    }

    #[test]
    fn data_saved_by_the_previous_version_still_opens() {
        // v1 は権限をアカウント限定の形で持っていた。
        let v1 = r#"{
            "version": 1,
            "users": [
                {"id":"a","name":"佐藤","systemRole":"admin","createdAt":"2026-09-20T00:00:00Z"}
            ],
            "projects": [
                {
                    "id":"p","name":"案件","createdAt":"2026-09-20T00:00:00Z",
                    "updatedAt":"2026-09-20T00:00:00Z",
                    "access":[{"userId":"a","role":"owner"}],
                    "document":{"tasks":[],"calendar":{},"settings":{}}
                }
            ]
        }"#;
        let store = MemoryStore::from_json(v1).unwrap();
        assert_eq!(store.version, STORE_VERSION);
        let access = &store.projects[0].meta.access;
        assert_eq!(access.len(), 1);
        assert_eq!(access[0].principal, Principal::user("a"));
        assert_eq!(access[0].role, ProjectRole::Owner);
        // 新しい項目は既定値で埋まる。
        assert_eq!(store.projects[0].meta.due_date, None);
        assert!(store.user_groups.is_empty());
    }

    #[test]
    fn a_newer_save_format_is_refused_instead_of_misread() {
        let text = r#"{"version":999,"users":[],"projects":[]}"#;
        let error = MemoryStore::from_json(text).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::Invalid);
    }

    #[test]
    fn garbage_is_refused() {
        assert!(MemoryStore::from_json("これは JSON ではない").is_err());
    }
}
