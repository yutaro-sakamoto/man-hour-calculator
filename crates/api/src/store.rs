//! データの置き場所。
//!
//! [`Store`] は「どこに置くか」を切り離すための口。ローカルでは
//! [`MemoryStore`] を WASM のなかに持ち、その中身を JSON にして
//! ブラウザやファイルに保存する。サーバを建てるときは、同じ口の後ろを
//! データベースに差し替えればよい。

use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::model::{Project, ProjectId, User, UserId};

/// 永続化の口。
pub trait Store {
    fn users(&self) -> Vec<User>;
    fn user(&self, id: &UserId) -> Option<User>;
    fn put_user(&mut self, user: User);
    fn remove_user(&mut self, id: &UserId) -> bool;

    fn projects(&self) -> Vec<Project>;
    fn project(&self, id: &ProjectId) -> Option<Project>;
    fn put_project(&mut self, project: Project);
    fn remove_project(&mut self, id: &ProjectId) -> bool;
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
    pub projects: Vec<Project>,
}

/// 現在の保存形式のバージョン。
pub const STORE_VERSION: u32 = 1;

impl MemoryStore {
    pub fn new() -> Self {
        Self {
            version: STORE_VERSION,
            ..Self::default()
        }
    }

    /// JSON から読み込む。形が違えば失敗する。
    pub fn from_json(text: &str) -> ApiResult<Self> {
        let mut store: Self = serde_json::from_str(text)
            .map_err(|e| ApiError::invalid(format!("保存データを読めません: {e}")))?;
        if store.version > STORE_VERSION {
            return Err(ApiError::invalid(format!(
                "保存データのバージョンが新しすぎます (data={}, app={STORE_VERSION})",
                store.version
            )));
        }
        store.version = STORE_VERSION;
        Ok(store)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

impl Store for MemoryStore {
    fn users(&self) -> Vec<User> {
        self.users.clone()
    }

    fn user(&self, id: &UserId) -> Option<User> {
        self.users.iter().find(|user| &user.id == id).cloned()
    }

    fn put_user(&mut self, user: User) {
        match self.users.iter_mut().find(|slot| slot.id == user.id) {
            Some(slot) => *slot = user,
            None => self.users.push(user),
        }
    }

    fn remove_user(&mut self, id: &UserId) -> bool {
        let before = self.users.len();
        self.users.retain(|user| &user.id != id);
        // 消えたアカウントの権限も一緒に落とす。残すと宙に浮く。
        for project in &mut self.projects {
            project.access.retain(|entry| &entry.user_id != id);
        }
        self.users.len() != before
    }

    fn projects(&self) -> Vec<Project> {
        self.projects.clone()
    }

    fn project(&self, id: &ProjectId) -> Option<Project> {
        self.projects
            .iter()
            .find(|project| &project.id == id)
            .cloned()
    }

    fn put_project(&mut self, project: Project) {
        match self.projects.iter_mut().find(|slot| slot.id == project.id) {
            Some(slot) => *slot = project,
            None => self.projects.push(project),
        }
    }

    fn remove_project(&mut self, id: &ProjectId) -> bool {
        let before = self.projects.len();
        self.projects.retain(|project| &project.id != id);
        self.projects.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ProjectAccess, ProjectRole, SystemRole};

    fn user(id: &str) -> User {
        User {
            id: UserId::new(id),
            name: id.to_string(),
            email: None,
            system_role: SystemRole::Member,
            created_at: "2026-09-20T00:00:00Z".into(),
        }
    }

    fn project(id: &str, owner: &str) -> Project {
        Project {
            id: ProjectId::new(id),
            name: id.to_string(),
            created_at: "2026-09-20T00:00:00Z".into(),
            updated_at: "2026-09-20T00:00:00Z".into(),
            access: vec![ProjectAccess {
                user_id: UserId::new(owner),
                role: ProjectRole::Owner,
            }],
            document: Default::default(),
        }
    }

    #[test]
    fn putting_the_same_id_replaces_instead_of_duplicating() {
        let mut store = MemoryStore::new();
        store.put_user(user("a"));
        let mut renamed = user("a");
        renamed.name = "新しい名前".into();
        store.put_user(renamed);

        assert_eq!(store.users().len(), 1);
        assert_eq!(store.user(&UserId::new("a")).unwrap().name, "新しい名前");
    }

    #[test]
    fn removing_a_user_also_drops_their_access() {
        let mut store = MemoryStore::new();
        store.put_user(user("a"));
        store.put_project(project("p", "a"));

        assert!(store.remove_user(&UserId::new("a")));
        assert!(store
            .project(&ProjectId::new("p"))
            .unwrap()
            .access
            .is_empty());
        assert!(
            !store.remove_user(&UserId::new("a")),
            "2 回目は何も消えない"
        );
    }

    #[test]
    fn the_store_round_trips_as_json() {
        let mut store = MemoryStore::new();
        store.put_user(user("a"));
        store.put_project(project("p", "a"));

        let restored = MemoryStore::from_json(&store.to_json()).unwrap();
        assert_eq!(restored, store);
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
