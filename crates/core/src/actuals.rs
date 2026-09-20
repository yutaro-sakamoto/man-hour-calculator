//! 実績 (着手日・進捗率・完了日) を見積もりに織り込む。
//!
//! 見積もりは着手した瞬間から古くなっていく。このモジュールは、カレンダーから
//! 求めた**消化済み工数**と**進捗率**を使って、当初の 3 点見積もりを現在の
//! 見通しに更新する。
//!
//! # 更新のしかた
//!
//! 進捗率 `p` のタスクについて、**残りの工数は当初見積もりの `1 - p` 倍**と見る。
//! 総工数は、それにすでに使ったぶんを足したもの:
//!
//! ```text
//! 残り = (1 - p) * (a, m, b)
//! 総   = spent + 残り
//! ```
//!
//! 実績だけから見た総工数は `spent / p` になる (EVM の EAC と同じ考え方) が、
//! この式はそれを当初の最可能値 `m` と進捗率で混ぜたものと一致する:
//! `(1 - p) * m + p * (spent / p) = (1 - p) * m + spent`。
//! 「実績どおりのペースが続く」と決め打ちする EVM より保守的で、進捗が
//! 浅いうちに当初見積もりを大きく振り回さない。
//!
//! 境界での振る舞い:
//!
//! - `p = 0` なら残りは当初の見積もりそのまま
//! - `p = 1` なら残りは 0、総工数は `spent` の 1 点に潰れる
//! - 予定どおりのペース (`spent = p * m`) なら総工数は `m` のまま動かない
//! - 遅れているほど総工数は大きくなり、進むほど残りの幅は狭くなる
//!
//! # 日程に効かせる
//!
//! **日程が消化するのは「残り」のほう**。総工数のまま日程に流すと、
//! すでに終えた work をもう一度これからの稼働で賄うことになり、8 割
//! 終わっているタスクでも完了日が動かない。
//!
//! # 消化工数が測れないとき
//!
//! `spent` は担当者のカレンダー上で、着手日から基準日までに投入できた
//! 工数として測る。着手日が無い、あるいは着手日が計算期間の外にあると
//! 測れない。そのときは**見積もりどおりに進んだ**とみなし、
//! `spent = p * (見積もりの期待値)` を置く。
//!
//! 期待値を使うのは、**総工数の期待値を動かさない**ため:
//!
//! ```text
//! E[総] = p * E[当初] + (1 - p) * E[当初] = E[当初]
//! ```
//!
//! 消化量について何も分かっていないのだから、期待値が動く理由も無い。
//! 一方で分布の幅は `1 - p` 倍に狭まるので、P80 のような裾の値は下がる。
//! 「終わったぶんについては、もう外れようがない」ということ。
//!
//! ここで最可能値 `m` を使うと (`spent = p * m`)、右に裾を引いた見積もり
//! では期待値が `m` に向かって下がってしまう。進捗を入れただけで総工数が
//! 減ったように見えるのは正しくない。

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
    /// 総工数 (すでに使ったぶんを含む) の見通し。分布に出すのはこちら。
    pub estimate: TaskEstimate,
    /// これから要る工数。**日程が消化するのはこちら**。
    pub remaining: TaskEstimate,
    /// 消化済み工数 (人日)。測れないときは予定どおり進んだとみなした値。
    pub spent: f64,
    pub state: TaskState,
}

/// 見積もりを一律に `factor` 倍する。
fn scaled(estimate: TaskEstimate, factor: f64) -> TaskEstimate {
    let f = factor.clamp(0.0, 1.0);
    TaskEstimate::new(
        estimate.min() * f,
        estimate.likely() * f,
        estimate.max() * f,
    )
    .unwrap_or(estimate)
}

/// 残りを `remaining` として、すでに使ったぶんを足した総工数。
fn total_of(remaining: TaskEstimate, spent: f64) -> TaskEstimate {
    let shift = if spent.is_finite() && spent > 0.0 {
        spent
    } else {
        0.0
    };
    TaskEstimate::new(
        remaining.min() + shift,
        remaining.likely() + shift,
        remaining.max() + shift,
    )
    .unwrap_or(remaining)
}

/// 幅ゼロの見積もり。完了したタスクの「残り」に使う。
fn nothing_left(fallback: TaskEstimate) -> TaskEstimate {
    TaskEstimate::new(0.0, 0.0, 0.0).unwrap_or(fallback)
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
/// `planned` は当初見積もりの期待値 (分布の平均)。消化工数が測れないときに、
/// 進んだぶんがどれだけの工数を使ったとみなすかに使う。
pub fn forecast(
    original: TaskEstimate,
    planned: f64,
    actual: &Actual,
    calendar: &Calendar,
    today: i64,
) -> Forecast {
    let progress = if actual.progress.is_finite() {
        actual.progress.clamp(0.0, 1.0)
    } else {
        0.0
    };

    /// 完了したタスク。総工数は実際にかかったぶん、残りは 0。
    fn done(spent: f64, original: TaskEstimate) -> Forecast {
        let value = if spent > 0.0 {
            spent
        } else {
            original.likely()
        };
        Forecast {
            estimate: point_mass(value, original),
            remaining: nothing_left(original),
            spent: value,
            state: TaskState::Done,
        }
    }

    // --- 完了済み: 実際にかかった工数で置き換える
    if let Some(end) = actual.end_day {
        let spent = match actual.start_day {
            Some(start) => calendar.capacity_between(start, end),
            // 着手日が無いと消化量を測れないので、当初の最可能値で代用する。
            None => original.likely(),
        };
        return done(spent, original);
    }

    // --- 進捗 100%: 完了日が未入力でも完了として扱う
    if progress >= 1.0 {
        let spent = match actual.start_day {
            Some(start) => calendar.capacity_between(start, today),
            None => 0.0,
        };
        return done(spent, original);
    }

    // --- 未着手: 着手日も進捗も無ければ、当初の見積もりのまま
    if actual.start_day.is_none() && progress <= 0.0 {
        return Forecast {
            estimate: original,
            remaining: original,
            spent: 0.0,
            state: TaskState::NotStarted,
        };
    }

    // 消化工数はカレンダーで測る。着手日が無い、あるいは着手日が計算期間の
    // 外にあって測れないときは、予定どおりに進んだものとみなす。
    // そうしないと「タダで 25% 進んだ」= 総工数が減った、と読めてしまう。
    let measured = match actual.start_day {
        Some(start) => calendar.capacity_between(start, today),
        None => 0.0,
    };
    let baseline = if planned.is_finite() && planned > 0.0 {
        planned
    } else {
        original.likely()
    };
    let spent = if measured > 0.0 {
        measured
    } else {
        progress * baseline
    };

    // 残りは当初見積もりの (1 - p) 倍。総工数はそれに消化ぶんを足したもの。
    let remaining = scaled(original, 1.0 - progress);
    let state = if spent > 0.0 || progress > 0.0 {
        TaskState::InProgress
    } else {
        TaskState::NotStarted
    };
    Forecast {
        estimate: total_of(remaining, spent),
        remaining,
        spent,
        state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::{Calendar, CalendarConfig};
    use crate::date::days_from_civil;
    use crate::member::MemberSchedule;

    /// 当初見積もりの期待値 (PERT, λ=4) を添えて呼ぶ。
    ///
    /// 消化工数が測れないときの目安。本番では `Sampler::mean()` が渡る。
    fn plan(original: TaskEstimate, actual: &Actual, calendar: &Calendar, today: i64) -> Forecast {
        let mean = (original.min() + 4.0 * original.likely() + original.max()) / 6.0;
        forecast(original, mean, actual, calendar, today)
    }

    const MONDAY: (i32, u32, u32) = (2026, 9, 21);

    /// 月〜金 9:00〜17:00 (= 1 人日/日) のまっさらなカレンダー。
    fn calendar() -> Calendar {
        let mut start = [0; 7];
        let mut end = [0; 7];
        for weekday in 1..=5 {
            start[weekday] = 9 * 60;
            end[weekday] = 17 * 60;
        }
        Calendar::build(
            &CalendarConfig {
                start_day: days_from_civil(MONDAY.0, MONDAY.1, MONDAY.2),
                horizon_days: 120,
                hours_per_person_day: 8.0,
            },
            &MemberSchedule::new(start, end),
            &[],
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
        let f = plan(original, &Actual::default(), &calendar(), day(0));
        assert_eq!(f.estimate, original);
        assert_eq!(f.spent, 0.0);
        assert_eq!(f.state, TaskState::NotStarted);
    }

    #[test]
    fn progress_alone_moves_the_remaining_work_but_not_the_total() {
        // 着手日が基準日より後なら、消化工数はカレンダーからは測れない。
        // それでも進捗率が入っているなら、残りはそのぶん減っていなければ
        // ならない。一方で総工数は動かない — 何も根拠なく縮めてはいけない。
        let original = est(5.0, 8.0, 20.0);
        let actual = Actual {
            start_day: Some(day(10)),
            progress: 0.25,
            end_day: None,
        };
        let f = plan(original, &actual, &calendar(), day(0));

        assert_eq!(f.remaining, est(3.75, 6.0, 15.0), "残りは 3/4 になる");
        assert_eq!(f.spent, 2.375, "見積もりどおり進んだとみなす (0.25 * 9.5)");
        assert_eq!(f.state, TaskState::InProgress);

        // 消化量について何も分かっていないのだから、**期待値は動かない**。
        let mean = |e: TaskEstimate| (e.min() + 4.0 * e.likely() + e.max()) / 6.0;
        assert!(
            (f.spent + mean(f.remaining) - mean(original)).abs() < 1e-9,
            "総工数の期待値が動いている"
        );
        // 一方で幅は狭くなる。終わったぶんについては、もう外れようがない。
        assert!(f.estimate.max() - f.estimate.min() < original.max() - original.min());
    }

    #[test]
    fn progress_without_a_start_date_still_counts() {
        // 着手日を入れずに進捗率だけを入れる、という使い方も通す。
        let original = est(4.0, 8.0, 12.0);
        let actual = Actual {
            start_day: None,
            progress: 0.5,
            end_day: None,
        };
        let f = plan(original, &actual, &calendar(), day(0));
        assert_eq!(f.remaining, est(2.0, 4.0, 6.0));
        assert_eq!(f.estimate.likely(), 8.0);
        assert_eq!(f.state, TaskState::InProgress);
    }

    #[test]
    fn nothing_entered_at_all_leaves_the_estimate_alone() {
        let original = est(4.0, 8.0, 12.0);
        let f = plan(original, &Actual::default(), &calendar(), day(0));
        assert_eq!(f.estimate, original);
        assert_eq!(f.remaining, original, "全部これから");
        assert_eq!(f.spent, 0.0);
        assert_eq!(f.state, TaskState::NotStarted);
    }

    #[test]
    fn a_finished_task_has_nothing_left() {
        let original = est(4.0, 8.0, 12.0);
        let actual = Actual {
            start_day: Some(day(0)),
            progress: 1.0,
            end_day: None,
        };
        let f = plan(original, &actual, &calendar(), day(3));
        assert_eq!(f.remaining.max(), 0.0, "日程が消化するものは残っていない");
        assert_eq!(f.state, TaskState::Done);
        assert_eq!(f.estimate.likely(), f.spent, "総工数は実際にかかったぶん");
    }

    #[test]
    fn a_future_start_date_does_not_count_as_started() {
        let original = est(5.0, 8.0, 20.0);
        let actual = Actual {
            start_day: Some(day(30)),
            ..Default::default()
        };
        let f = plan(original, &actual, &calendar(), day(0));
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
        let f = plan(est(5.0, 8.0, 20.0), &actual, &calendar(), day(10));
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
        let f = plan(est(1.0, 2.0, 9.0), &actual, &calendar(), day(20));
        assert_eq!(f.spent, 3.0);
    }

    #[test]
    fn progress_of_100_percent_completes_without_an_end_date() {
        let actual = Actual {
            start_day: Some(day(0)),
            progress: 1.0,
            end_day: None,
        };
        let f = plan(est(5.0, 8.0, 20.0), &actual, &calendar(), day(2));
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
        let f = plan(original, &actual, &calendar(), day(3)); // 月〜木 = 4 人日
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
        let f = plan(original, &actual, &calendar(), day(9)); // 8 稼働日
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
        let f = plan(original, &actual, &calendar(), day(11)); // 10 稼働日
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
            let f = plan(original, &actual, &calendar(), day(3));
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
                    let f = plan(original, &actual, &cal, day(10));
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
        let f = plan(est(5.0, 8.0, 20.0), &actual, &calendar(), day(10));
        assert_eq!(f.state, TaskState::Done);
        assert_eq!(f.spent, 8.0, "最可能値で代用する");
    }
}
