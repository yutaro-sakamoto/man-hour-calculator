//! API が扱うデータの形。
//!
//! # 用語について
//!
//! このアプリには「人」が 2 種類出てくる。混ぜると設計が壊れるので、
//! 名前で区別している。
//!
//! - [`User`] — **アカウント**。ログインして操作する主体で、権限を持つ。
//! - `Member` (`document::Member`) — **人員**。工数を消化する稼働資源で、
//!   曜日ごとの稼働時間帯を持つ。アカウントとは 1 対 1 とは限らない
//!   (外注や「未割当」のような、ログインしない人員もいる)。

use serde::{Deserialize, Serialize};

/// アカウントの識別子。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UserId(pub String);

/// プロジェクトの識別子。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectId(pub String);

impl UserId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl ProjectId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// システム全体での役割。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemRole {
    /// 全プロジェクトとアカウントを管理できる。
    Admin,
    /// 自分に共有されたプロジェクトだけを扱える。
    Member,
}

/// プロジェクトごとの役割。強い順に並んでいる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectRole {
    /// 見るだけ。
    Viewer,
    /// 内容を書き換えられる。
    Editor,
    /// 権限の付け替えと削除までできる。
    Owner,
}

impl ProjectRole {
    /// より強い役割か。
    pub fn at_least(self, needed: ProjectRole) -> bool {
        self >= needed
    }
}

/// アカウント。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: UserId,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub email: Option<String>,
    pub system_role: SystemRole,
    pub created_at: String,
}

/// 「誰がどのプロジェクトをどの役割で扱えるか」の 1 件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAccess {
    pub user_id: UserId,
    pub role: ProjectRole,
}

/// 一覧に出すためのプロジェクトの見出し。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: ProjectId,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    /// 一覧を求めた本人の役割。
    pub role: ProjectRole,
    /// 所有者の表示名 (見つからなければ空)。
    pub owner_name: String,
    pub task_count: usize,
    pub member_count: usize,
}

/// プロジェクト 1 件のすべて。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub access: Vec<ProjectAccess>,
    pub document: Document,
}

impl Project {
    /// その人の役割。共有されていなければ `None`。
    pub fn role_of(&self, user: &UserId) -> Option<ProjectRole> {
        self.access
            .iter()
            .find(|entry| &entry.user_id == user)
            .map(|entry| entry.role)
    }

    pub fn owner(&self) -> Option<&UserId> {
        self.access
            .iter()
            .find(|entry| entry.role == ProjectRole::Owner)
            .map(|entry| &entry.user_id)
    }

    pub fn summary(&self, viewer_role: ProjectRole, owner_name: String) -> ProjectSummary {
        ProjectSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            role: viewer_role,
            owner_name,
            task_count: self.document.tasks.len(),
            member_count: self.document.calendar.members.len(),
        }
    }
}

/* ===== プロジェクトの中身 ======================================
ここから下は画面が編集する内容そのもの。フィールド名は
TypeScript 側の型と 1 対 1 に対応させてある (camelCase)。     */

/// 見積もりの中身。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Document {
    pub tasks: Vec<Task>,
    pub calendar: CalendarSettings,
    pub settings: ComputeSettings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub group: String,
    pub priority: Priority,
    pub enabled: bool,
    pub min: String,
    pub likely: String,
    pub max: String,
    pub start_date: Option<String>,
    pub progress: f64,
    pub end_date: Option<String>,
    pub assignee_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    High,
    #[default]
    Normal,
    Low,
}

/// 人員 (稼働資源)。アカウントとは別物。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub name: String,
    /// 日曜から土曜までの 7 件。
    pub workdays: Vec<WorkWindow>,
    pub break_minutes: f64,
    /// この人員に対応するアカウント。紐づいていなければ `None`。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub user_id: Option<UserId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkWindow {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub repeat_weeks: u32,
    pub until: Option<String>,
    pub member_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarSettings {
    pub start_date: String,
    pub hours_per_person_day: f64,
    pub use_japanese_holidays: bool,
    pub horizon_days: u32,
    pub members: Vec<Member>,
    pub events: Vec<CalendarEvent>,
    pub forced_workdays: Vec<String>,
    pub today: String,
}

impl Default for CalendarSettings {
    fn default() -> Self {
        Self {
            start_date: String::new(),
            hours_per_person_day: 8.0,
            use_japanese_holidays: true,
            horizon_days: 365,
            members: Vec::new(),
            events: Vec::new(),
            forced_workdays: Vec::new(),
            today: String::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ComputeSettings {
    pub engine: u8,
    pub dist: u8,
    pub lambda: f64,
    pub iterations: u32,
    pub seed: u32,
    pub bins: u32,
    pub grid_points: u32,
}

impl Default for ComputeSettings {
    fn default() -> Self {
        Self {
            engine: 0,
            dist: 0,
            lambda: 4.0,
            iterations: 100_000,
            seed: 20_250_920,
            bins: 48,
            grid_points: 2_048,
        }
    }
}
