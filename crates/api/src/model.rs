//! API が扱うデータの形。
//!
//! # 用語について
//!
//! このアプリには「人」が 2 種類出てくる。混ぜると設計が壊れるので、
//! 名前で区別している。
//!
//! - [`User`] — **アカウント**。ログインして操作する主体で、権限を持つ。
//! - [`Member`] — **人員**。工数を消化する稼働資源で、曜日ごとの稼働時間帯を持つ。
//!   アカウントとは 1 対 1 とは限らない (外注や「未割当」のような、
//!   ログインしない人員もいる)。
//!
//! 「グループ」も 2 種類ある。
//!
//! - [`UserGroup`] — アカウントのまとまり。チームや部署。権限を配る単位。
//! - [`ProjectGroup`] — プロジェクトのまとまり。まとめて権限を配れる入れ物。

use serde::{Deserialize, Serialize};

/// アカウントの識別子。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UserId(pub String);

/// プロジェクトの識別子。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectId(pub String);

/// アカウントのまとまりの識別子。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UserGroupId(pub String);

/// プロジェクトのまとまりの識別子。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProjectGroupId(pub String);

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

impl UserGroupId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl ProjectGroupId {
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

/// 権限を与える相手。
///
/// アカウント 1 人でも、アカウントのまとまりでもよい。グループに与えておけば、
/// 人の出入りのたびにプロジェクトを触らなくて済む。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "camelCase")]
pub enum Principal {
    User(UserId),
    Group(UserGroupId),
}

impl Principal {
    pub fn user(id: impl Into<String>) -> Self {
        Self::User(UserId::new(id))
    }

    pub fn group(id: impl Into<String>) -> Self {
        Self::Group(UserGroupId::new(id))
    }

    /// 種別を表す短い語。HTTP のパスに現れる。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::User(_) => "user",
            Self::Group(_) => "group",
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::User(id) => id.as_str(),
            Self::Group(id) => id.as_str(),
        }
    }

    /// 種別と id から組み立てる。未知の種別は `None`。
    pub fn parse(kind: &str, id: &str) -> Option<Self> {
        match kind {
            "user" => Some(Self::user(id)),
            "group" => Some(Self::group(id)),
            _ => None,
        }
    }
}

/// 「誰がどれをどの役割で扱えるか」の 1 件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessEntry {
    pub principal: Principal,
    pub role: ProjectRole,
}

impl AccessEntry {
    pub fn new(principal: Principal, role: ProjectRole) -> Self {
        Self { principal, role }
    }
}

/// アカウントのまとまり。チームや部署。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserGroup {
    pub id: UserGroupId,
    pub name: String,
    pub members: Vec<UserId>,
    pub created_at: String,
}

impl UserGroup {
    pub fn contains(&self, user: &UserId) -> bool {
        self.members.contains(user)
    }
}

/// プロジェクトのまとまり。ここに権限を与えると、配下すべてに効く。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub id: ProjectGroupId,
    pub name: String,
    pub access: Vec<AccessEntry>,
    pub created_at: String,
}

/// 一度計算した見通しの控え。
///
/// 一覧のたびに全プロジェクトの中身を読んで計算し直すのは、サーバでも
/// DynamoDB でも重い。計算はクライアントが保存時に 1 回だけ行い、その結果を
/// ここに添えて送る。`based_on` が `updated_at` と違えば「古い」と分かるので、
/// 画面は黙って古い数字を見せずに「再計算が必要」と出せる。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub computed_at: String,
    /// 計算の元にした内容の `updated_at`。
    pub based_on: String,
    pub effort_p50: f64,
    pub effort_p80: f64,
    /// 完了日 (1970-01-01 からの日数)。期間内に終わらなければ `None`。
    pub finish_p50: Option<i64>,
    pub finish_p80: Option<i64>,
    /// 消化済み工数 (人日)。
    pub spent: f64,
    /// 進捗率 `0.0..=1.0`。
    pub progress: f64,
    pub task_count: usize,
    pub done_count: usize,
}

/// 一覧に出すためのプロジェクトの見出し。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: ProjectId,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    /// 一覧を求めた本人の実効的な役割。
    pub role: ProjectRole,
    pub group_id: Option<ProjectGroupId>,
    pub group_name: Option<String>,
    pub due_date: Option<String>,
    pub status: Option<ProjectStatus>,
    /// 期限と進捗から見た状態。
    pub health: crate::health::ProjectHealth,
    /// 所有者の表示名 (グループ経由の所有者も含む)。
    pub owner_names: Vec<String>,
    pub task_count: usize,
    pub member_count: usize,
}

/// プロジェクトの、中身を除いた情報。
///
/// 一覧では中身 (`Document`) を読まずに済ませたい。分けておくと、
/// サーバは本文の列を触らずに一覧を返せる。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: ProjectId,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub group_id: Option<ProjectGroupId>,
    #[serde(default)]
    pub due_date: Option<String>,
    pub access: Vec<AccessEntry>,
    #[serde(default)]
    pub status: Option<ProjectStatus>,
    /// 中身の規模。一覧に出すために控えておく。
    #[serde(default)]
    pub task_count: usize,
    #[serde(default)]
    pub member_count: usize,
}

impl ProjectMeta {
    /// 指定した相手に直接与えられている役割。
    pub fn role_for(&self, principal: &Principal) -> Option<ProjectRole> {
        self.access
            .iter()
            .find(|entry| &entry.principal == principal)
            .map(|entry| entry.role)
    }
}

/// プロジェクト 1 件のすべて。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(flatten)]
    pub meta: ProjectMeta,
    pub document: Document,
}

impl Project {
    /// 中身から、一覧に出す規模を数え直す。
    pub fn refresh_counts(&mut self) {
        self.meta.task_count = self.document.tasks.len();
        self.meta.member_count = self.document.calendar.members.len();
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
