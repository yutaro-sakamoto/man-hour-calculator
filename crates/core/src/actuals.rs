//! 実績 (着手日・進捗率・完了日) を見積もりに織り込む。
//!
//! 見積もりは着手した瞬間から古くなっていく。このモジュールは、カレンダーから
//! 求めた**消化済み工数**と**進捗率**を使って、当初の 3 点見積もりを現在の
//! 見通しに更新する。
//!
//! # 更新のしかた
//!
//! 進捗率 `p` のタスクについて、消化済み工数を `spent` とすると、
//! 実績だけから見た総工数は `spent / p` になる (EVM の EAC と同じ考え方)。
//! これを当初の最可能値 `m` と、進捗率そのものを重みにして混ぜる:
//!
//! ```text
//! m' = (1 - p) * m + p * (spent / p) = (1 - p) * m + spent
//! a' = m' - (m - a) * (1 - p)
//! b' = m' + (b - m) * (1 - p)
//! ```
//!
//! そのうえで、すでに使った工数は消えないので `a'` を `spent` で下から抑える。
//!
//! この式は境界で素直に振る舞う:
//!
//! - `p = 0` なら当初の見積もりそのまま (ただし消化済み工数は下回らない)
//! - `p = 1` なら `spent` の 1 点に潰れる (幅ゼロ)
//! - 予定どおりのペース (`spent = p * m`) なら `m' = m` で見積もりは動かない
//! - 遅れているほど `m'` は大きくなり、進むほど幅 `b' - a'` は狭くなる
//!
//! 「実績どおりのペースが続く」と決め打ちする EVM より保守的で、
//! 進捗が浅いうちに当初見積もりを大きく振り回さない。

use crate::calendar::Calendar;
use crate::estimate::TaskEstimate;

/// タスクの進行状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    NotStarted,
    InProgress,
    Done,
}

impl TaskState {
    /// ABI 上の数値表現。
    pub fn code(self) -> f64 {
        match self {
            Self::NotStarted => 0.0,
            Self::InProgress => 1.0,
            Self::Done => 2.0,
        }
    }
}

/// ユーザーが入力した実績。
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Actual {
    pub start_day: Option<i64>,
    /// 進捗率 `0.0..=1.0`。
    pub progress: f64,
    pub end_day: Option<i64>,
}

/// 実績を織り込んだ見通し。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Forecast {
    /// 以後の計算に使う見積もり。
    pub estimate: TaskEstimate,
    /// 消化済み工数 (人日)。
    pub spent: f64,
    pub state: TaskState,
}

/// 幅ゼロの見積もりを作る。値が不正なら元の見積もりに戻す。
fn point_mass(value: f64, fallback: TaskEstimate) -> TaskEstimate {
    let v = if value.is_finite() && value >= 0.0 {
        value
    } else {
        return fallback;
    };
    TaskEstimate::new(v, v, v).unwrap_or(fallback)
}

/// 当初の見積もりと実績から、現在の見通しを求める。
///
/// `today` は進捗の基準日 (日数)。着手済みで未完了のタスクは、着手日から
/// この日までにカレンダー上で投入できた工数を「消化済み」とみなす。
pub fn forecast(
    original: TaskEstimate,
    actual: &Actual,
    calendar: &Calendar,
    today: i64,
) -> Forecast {
    let progress = if actual.progress.is_finite() {
        actual.progress.clamp(0.0, 1.0)
    } else {
        0.0
    };

    // --- 完了済み: 実際にかかった工数で置き換える
    if let Some(end) = actual.end_day {
        let spent = match actual.start_day {
            Some(start) => calendar.capacity_between(start, end),
            // 着手日が無いと消化量を測れないので、当初の最可能値で代用する。
            None => original.likely(),
        };
        let value = if spent > 0.0 {
            spent
        } else {
            original.likely()
        };
        return Forecast {
            estimate: point_mass(value, original),
            spent: value,
            state: TaskState::Done,
        };
    }

    // --- 未着手: 当初の見積もりのまま
    let Some(start) = actual.start_day else {
        return Forecast {
            estimate: original,
            spent: 0.0,
            state: TaskState::NotStarted,
        };
    };

    let spent = calendar.capacity_between(start, today);

    // 着手日が未来など、まだ 1 秒も進んでいない場合。
    if spent <= 0.0 && progress <= 0.0 {
        return Forecast {
            estimate: original,
            spent: 0.0,
            state: TaskState::NotStarted,
        };
    }

    // --- 進捗 100%: 完了日が未入力でも完了として扱う
    if progress >= 1.0 {
        let value = if spent > 0.0 {
            spent
        } else {
            original.likely()
        };
        return Forecast {
            estimate: point_mass(value, original),
            spent: value,
            state: TaskState::Done,
        };
    }

    // --- 進行中
    let (a, m, b) = (original.min(), original.likely(), original.max());
    let rest = 1.0 - progress;
    let center = rest * m + spent; // = (1-p)*m + p*(spent/p)
    let lower = (center - (m - a) * rest).max(spent).max(0.0);
    let middle = center.max(lower);
    let upper = (center + (b - m) * rest).max(middle);

    let estimate = TaskEstimate::new(lower, middle, upper).unwrap_or(original);
    Forecast {
        estimate,
        spent,
        state: TaskState::InProgress,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::{Calendar, CalendarConfig};
    use crate::date::days_from_civil;

    const MONDAY: (i32, u32, u32) = (2026, 9, 21);

    /// 月〜金・1 人日/日のまっさらなカレンダー。
    fn calendar() -> Calendar {
        Calendar::build(
            &CalendarConfig {
                start_day: days_from_civil(MONDAY.0, MONDAY.1, MONDAY.2),
                horizon_days: 120,
                weekday_mask: 0b0011_1110,
                hours_per_day: 8.0,
                hours_per_person_day: 8.0,
                team_size: 1.0,
                use_japanese_holidays: false,
            },
            &[],
            &[],
        )
    }

    fn day(offset: i64) -> i64 {
        days_from_civil(MONDAY.0, MONDAY.1, MONDAY.2) + offset
    }

    fn est(a: f64, m: f64, b: f64) -> TaskEstimate {
        TaskEstimate::new(a, m, b).unwrap()
    }

    #[test]
    fn a_task_with_no_actuals_keeps_its_estimate() {
        let original = est(5.0, 8.0, 20.0);
        let f = forecast(original, &Actual::default(), &calendar(), day(0));
        assert_eq!(f.estimate, original);
        assert_eq!(f.spent, 0.0);
        assert_eq!(f.state, TaskState::NotStarted);
    }

    #[test]
    fn a_future_start_date_does_not_count_as_started() {
        let original = est(5.0, 8.0, 20.0);
        let actual = Actual {
            start_day: Some(day(30)),
            ..Default::default()
        };
        let f = forecast(original, &actual, &calendar(), day(0));
        assert_eq!(f.estimate, original);
        assert_eq!(f.state, TaskState::NotStarted);
    }

    #[test]
    fn a_completed_task_collapses_to_the_effort_actually_spent() {
        // 月曜に着手して金曜に完了 → 稼働 5 日ぶん。
        let actual = Actual {
            start_day: Some(day(0)),
            progress: 1.0,
            end_day: Some(day(4)),
        };
        let f = forecast(est(5.0, 8.0, 20.0), &actual, &calendar(), day(10));
        assert_eq!(f.state, TaskState::Done);
        assert_eq!(f.spent, 5.0);
        assert!(f.estimate.is_degenerate(), "完了したタスクに幅は残らない");
        assert_eq!(f.estimate.likely(), 5.0);
    }

    #[test]
    fn a_completed_task_skips_the_weekend() {
        // 金曜着手・翌週火曜完了 → 金・月・火 の 3 日ぶん。
        let actual = Actual {
            start_day: Some(day(4)),
            progress: 1.0,
            end_day: Some(day(8)),
        };
        let f = forecast(est(1.0, 2.0, 9.0), &actual, &calendar(), day(20));
        assert_eq!(f.spent, 3.0);
    }

    #[test]
    fn progress_of_100_percent_completes_without_an_end_date() {
        let actual = Actual {
            start_day: Some(day(0)),
            progress: 1.0,
            end_day: None,
        };
        let f = forecast(est(5.0, 8.0, 20.0), &actual, &calendar(), day(2));
        assert_eq!(f.state, TaskState::Done);
        assert_eq!(f.spent, 3.0);
        assert!(f.estimate.is_degenerate());
    }

    #[test]
    fn on_schedule_progress_leaves_the_most_likely_value_alone() {
        // 最可能 8 人日のタスクで 4 人日を消化して 50% → 見通しは動かない。
        let original = est(5.0, 8.0, 20.0);
        let actual = Actual {
            start_day: Some(day(0)),
            progress: 0.5,
            end_day: None,
        };
        let f = forecast(original, &actual, &calendar(), day(3)); // 月〜木 = 4 人日
        assert_eq!(f.spent, 4.0);
        assert!((f.estimate.likely() - 8.0).abs() < 1e-12, "{f:?}");
        // 幅は半分に縮む。
        assert!((f.estimate.min() - (8.0 - 3.0 * 0.5)).abs() < 1e-12);
        assert!((f.estimate.max() - (8.0 + 12.0 * 0.5)).abs() < 1e-12);
    }

    #[test]
    fn falling_behind_pushes_the_forecast_up() {
        let original = est(5.0, 8.0, 20.0);
        // 8 人日を消化したのに 50% しか進んでいない。
        let actual = Actual {
            start_day: Some(day(0)),
            progress: 0.5,
            end_day: None,
        };
        let f = forecast(original, &actual, &calendar(), day(9)); // 8 稼働日
        assert_eq!(f.spent, 8.0);
        // (1-0.5)*8 + 8 = 12
        assert!((f.estimate.likely() - 12.0).abs() < 1e-12);
        assert!(f.estimate.likely() > original.likely());
    }

    #[test]
    fn the_forecast_never_drops_below_what_was_already_spent() {
        let original = est(1.0, 2.0, 3.0);
        let actual = Actual {
            start_day: Some(day(0)),
            progress: 0.1,
            end_day: None,
        };
        let f = forecast(original, &actual, &calendar(), day(11)); // 10 稼働日
        assert_eq!(f.spent, 10.0);
        assert!(
            f.estimate.min() >= f.spent,
            "最小 {} が消化済み {} を下回っている",
            f.estimate.min(),
            f.spent
        );
    }

    #[test]
    fn uncertainty_shrinks_as_progress_grows() {
        let original = est(5.0, 8.0, 20.0);
        let mut previous = f64::INFINITY;
        for step in 0..=10 {
            let actual = Actual {
                start_day: Some(day(0)),
                progress: step as f64 / 10.0,
                end_day: None,
            };
            let f = forecast(original, &actual, &calendar(), day(3));
            let width = f.estimate.max() - f.estimate.min();
            assert!(width <= previous + 1e-9, "進捗 {step}0% で幅が広がった");
            previous = width;
        }
        assert_eq!(previous, 0.0, "100% では幅ゼロ");
    }

    #[test]
    fn the_result_is_always_a_valid_estimate() {
        let original = est(0.0, 3.0, 40.0);
        let cal = calendar();
        for offset in [-5, 0, 3, 20, 60, 400] {
            for progress in [0.0, 0.01, 0.37, 0.5, 0.99, 1.0, 1.5, -1.0, f64::NAN] {
                for end in [None, Some(day(offset.max(0) + 2))] {
                    let actual = Actual {
                        start_day: Some(day(offset)),
                        progress,
                        end_day: end,
                    };
                    let f = forecast(original, &actual, &cal, day(10));
                    let e = f.estimate;
                    assert!(e.min() >= 0.0 && e.min() <= e.likely() && e.likely() <= e.max());
                    assert!(e.min().is_finite() && e.max().is_finite());
                    assert!(f.spent >= 0.0 && f.spent.is_finite());
                }
            }
        }
    }

    #[test]
    fn an_end_date_without_a_start_date_falls_back_to_the_estimate() {
        let actual = Actual {
            start_day: None,
            progress: 1.0,
            end_day: Some(day(5)),
        };
        let f = forecast(est(5.0, 8.0, 20.0), &actual, &calendar(), day(10));
        assert_eq!(f.state, TaskState::Done);
        assert_eq!(f.spent, 8.0, "最可能値で代用する");
    }
}
