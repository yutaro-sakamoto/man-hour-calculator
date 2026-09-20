//! プロジェクトが遅れているかどうかの判定。
//!
//! 「遅れている」には 2 つの意味があり、どちらも拾いたい。
//!
//! - **期限に対して遅れている** … 見通し (P80 完了日) が期限を過ぎている
//! - **ペースが遅れている** … 期限は決まっていないが、使った工数の割合が
//!   進捗率を上回っている (工数は減っていないのに時間だけ過ぎている)
//!
//! 判定をここ 1 か所に置いているのは、サーバの一覧と画面の表示で
//! 食い違わせないため。

use serde::{Deserialize, Serialize};

use crate::model::ProjectMeta;

/// 「消化率が進捗率をどれだけ上回ったらペース遅れとみなすか」の幅。
///
/// 見積もりにも進捗の申告にも誤差があるので、少しの差で赤くしない。
pub const PACE_TOLERANCE: f64 = 0.10;

/// プロジェクトの状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectHealth {
    /// タスクがまだ 1 件も無い。
    NoTasks,
    /// 見通しが計算されていない、または内容より古い。
    Unknown,
    /// すべてのタスクが完了している。
    Done,
    /// 期限に間に合う見込み (P80 完了日が期限以内)。
    OnTrack,
    /// 期限ぎりぎり (P50 は間に合うが P80 は間に合わない)。
    AtRisk,
    /// 期限に間に合わない見込み。
    Late,
    /// 期限は無いが、消化した工数の割合が進捗率を上回っている。
    BehindPace,
    /// 期限が無く、ペースにも問題が無い。
    InProgress,
}

impl ProjectHealth {
    /// 目立たせるべきか。一覧で強調し、既定の並び順で先頭に来る。
    pub fn needs_attention(self) -> bool {
        matches!(self, Self::Late | Self::BehindPace)
    }

    /// 並び替えに使う重み。小さいほど先に出す。
    pub fn severity(self) -> u8 {
        match self {
            Self::Late => 0,
            Self::BehindPace => 1,
            Self::AtRisk => 2,
            Self::Unknown => 3,
            Self::InProgress => 4,
            Self::OnTrack => 5,
            Self::NoTasks => 6,
            Self::Done => 7,
        }
    }
}

/// 状態を判定する。`today` は 1970-01-01 からの日数。
pub fn health(meta: &ProjectMeta, today: i64) -> ProjectHealth {
    if meta.task_count == 0 {
        return ProjectHealth::NoTasks;
    }

    // 控えが無い、あるいは内容より古ければ、分かったふりをしない。
    let Some(status) = &meta.status else {
        return ProjectHealth::Unknown;
    };
    if status.based_on != meta.updated_at {
        return ProjectHealth::Unknown;
    }

    if status.task_count > 0 && status.done_count >= status.task_count {
        return ProjectHealth::Done;
    }

    if let Some(due) = meta.due_date.as_deref().and_then(crate::health::day_of) {
        // 期間内に終わる見込みが立たないものは、期限に関わらず遅延。
        let Some(p80) = status.finish_p80 else {
            return ProjectHealth::Late;
        };
        if p80 <= due {
            return ProjectHealth::OnTrack;
        }
        return match status.finish_p50 {
            Some(p50) if p50 <= due => ProjectHealth::AtRisk,
            _ => ProjectHealth::Late,
        };
    }

    // 期限が無い場合はペースで見る。まだ何も進んでいないものは対象外。
    let _ = today;
    if status.progress > 0.0 && status.effort_p50 > 0.0 {
        let burned = status.spent / status.effort_p50;
        if burned > status.progress + PACE_TOLERANCE {
            return ProjectHealth::BehindPace;
        }
    }
    ProjectHealth::InProgress
}

/// `YYYY-MM-DD` を 1970-01-01 からの日数にする。
///
/// 暦の計算は [`crate`] に持ち込みたくないので、ここだけで完結させている
/// (Howard Hinnant の `days_from_civil` と同じ式)。
/// `2026-09-20T10:00:00Z` のような時刻から、その日の日数を取り出す。
///
/// 読めない形なら 0 (1970-01-01)。呼び出し側の時刻はサーバかブラウザが
/// 埋めるので、ここで失敗を報せても手当てのしようがない。
pub fn today_of(now: &str) -> i64 {
    now.get(..10).and_then(day_of).unwrap_or(0)
}

pub fn day_of(iso: &str) -> Option<i64> {
    let bytes = iso.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> { iso.get(from..to)?.parse().ok() };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let shifted = if month <= 2 { year - 1 } else { year };
    let era = if shifted >= 0 { shifted } else { shifted - 399 } / 400;
    let year_of_era = shifted - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ProjectId, ProjectStatus};

    const UPDATED: &str = "2026-09-20T10:00:00Z";

    fn meta() -> ProjectMeta {
        ProjectMeta {
            id: ProjectId::new("p"),
            name: "p".into(),
            created_at: UPDATED.into(),
            updated_at: UPDATED.into(),
            group_id: None,
            due_date: None,
            access: Vec::new(),
            status: None,
            task_count: 5,
            member_count: 1,
        }
    }

    fn status() -> ProjectStatus {
        ProjectStatus {
            computed_at: UPDATED.into(),
            based_on: UPDATED.into(),
            effort_p50: 40.0,
            effort_p80: 50.0,
            finish_p50: Some(day_of("2026-12-10").unwrap()),
            finish_p80: Some(day_of("2026-12-20").unwrap()),
            spent: 0.0,
            progress: 0.0,
            task_count: 5,
            done_count: 0,
        }
    }

    fn today() -> i64 {
        day_of("2026-09-20").unwrap()
    }

    #[test]
    fn dates_convert_the_same_way_as_the_core() {
        assert_eq!(day_of("1970-01-01"), Some(0));
        assert_eq!(day_of("2026-09-20"), Some(20_716));
        assert_eq!(day_of("2000-02-29"), Some(11_016));
        for bad in [
            "",
            "2026-9-20",
            "2026/09/20",
            "2026-13-01",
            "2026-01-32",
            "abcd-ef-gh",
        ] {
            assert_eq!(day_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_project_without_tasks_is_not_judged() {
        let mut meta = meta();
        meta.task_count = 0;
        assert_eq!(health(&meta, today()), ProjectHealth::NoTasks);
    }

    #[test]
    fn a_stale_or_missing_snapshot_is_reported_as_unknown() {
        let mut meta = meta();
        assert_eq!(health(&meta, today()), ProjectHealth::Unknown, "控えが無い");

        // 内容が更新されたのに控えが古いまま。
        let mut stale = status();
        stale.based_on = "2026-09-19T00:00:00Z".into();
        meta.status = Some(stale);
        assert_eq!(health(&meta, today()), ProjectHealth::Unknown);
    }

    #[test]
    fn everything_done_reads_as_done() {
        let mut meta = meta();
        let mut done = status();
        done.done_count = done.task_count;
        meta.status = Some(done);
        // 期限を過ぎていても、終わっているなら遅延ではない。
        meta.due_date = Some("2026-01-01".into());
        assert_eq!(health(&meta, today()), ProjectHealth::Done);
    }

    #[test]
    fn a_deadline_splits_on_track_at_risk_and_late() {
        let mut meta = meta();
        meta.status = Some(status());

        // P80 (12/20) が期限以内。
        meta.due_date = Some("2026-12-25".into());
        assert_eq!(health(&meta, today()), ProjectHealth::OnTrack);

        // P50 (12/10) は間に合うが P80 は間に合わない。
        meta.due_date = Some("2026-12-15".into());
        assert_eq!(health(&meta, today()), ProjectHealth::AtRisk);

        // P50 も間に合わない。
        meta.due_date = Some("2026-12-01".into());
        assert_eq!(health(&meta, today()), ProjectHealth::Late);
    }

    #[test]
    fn a_forecast_that_never_finishes_is_late() {
        let mut meta = meta();
        let mut endless = status();
        endless.finish_p80 = None;
        meta.status = Some(endless);
        meta.due_date = Some("2099-12-31".into());
        assert_eq!(health(&meta, today()), ProjectHealth::Late);
    }

    #[test]
    fn without_a_deadline_the_pace_is_used() {
        let mut meta = meta();

        // 40 人日の見込みに対し 28 人日 (70%) 使って、進捗は 40%。
        let mut behind = status();
        behind.spent = 28.0;
        behind.progress = 0.4;
        meta.status = Some(behind);
        assert_eq!(health(&meta, today()), ProjectHealth::BehindPace);

        // 40% 進んで 40% 使っているなら問題なし。
        let mut steady = status();
        steady.spent = 16.0;
        steady.progress = 0.4;
        meta.status = Some(steady);
        assert_eq!(health(&meta, today()), ProjectHealth::InProgress);
    }

    #[test]
    fn a_small_gap_does_not_raise_an_alarm() {
        let mut meta = meta();
        let mut slightly = status();
        // 進捗 40% に対し消化 45%。許容幅 (10pt) の内側。
        slightly.spent = 18.0;
        slightly.progress = 0.4;
        meta.status = Some(slightly);
        assert_eq!(health(&meta, today()), ProjectHealth::InProgress);
    }

    #[test]
    fn a_project_that_has_not_started_is_not_behind() {
        let mut meta = meta();
        let mut fresh = status();
        fresh.spent = 0.0;
        fresh.progress = 0.0;
        meta.status = Some(fresh);
        assert_eq!(health(&meta, today()), ProjectHealth::InProgress);
    }

    #[test]
    fn only_late_and_behind_pace_are_highlighted() {
        use ProjectHealth::*;
        for state in [Late, BehindPace] {
            assert!(state.needs_attention(), "{state:?}");
        }
        for state in [NoTasks, Unknown, Done, OnTrack, AtRisk, InProgress] {
            assert!(!state.needs_attention(), "{state:?}");
        }
        // 重い順に並ぶ。
        assert!(Late.severity() < BehindPace.severity());
        assert!(BehindPace.severity() < AtRisk.severity());
        assert!(AtRisk.severity() < OnTrack.severity());
        assert!(OnTrack.severity() < Done.severity());
    }
}
