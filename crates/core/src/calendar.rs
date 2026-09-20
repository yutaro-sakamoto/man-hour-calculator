//! 稼働カレンダー。「何人日の作業がいつ終わるか」を答えるための土台。
//!
//! 工数 (人日) と暦日をつなぐのがこのモジュールの役割。
//! 各暦日に **その日に投入できる工数 (人日)** を割り当て、その累積を持っておくと、
//! 「累積が X 人日に達する最初の日」＝ X 人日の作業が終わる日、として引ける。
//!
//! 1 日の工数は次のように決まる:
//!
//! ```text
//! 基準 = チーム人数 × 1日の作業可能時間 ÷ 1人日あたりの時間
//! 週末・祝日      → 0 (ただし特別稼働日に指定されていれば基準どおり)
//! 予定 (終日)     → 0
//! 予定 (時間指定) → 基準 − チーム人数 × 予定時間 ÷ 1人日あたりの時間
//! ```

use crate::date::{civil_from_days, japanese_holidays, weekday};

/// 非稼働曜日 (週末など)。
pub const FLAG_WEEKEND: u8 = 1;
/// 祝日。
pub const FLAG_HOLIDAY: u8 = 2;
/// 予定が入っている。
pub const FLAG_EVENT: u8 = 4;
/// 本来休みだが特別に稼働する日。
pub const FLAG_FORCED_WORKDAY: u8 = 8;

/// カレンダーを構築できる最大日数。壊れた入力でメモリを食い潰さないための上限。
pub const MAX_HORIZON_DAYS: usize = 20_000;

/// 稼働に影響する予定。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalendarEvent {
    pub start_day: i64,
    pub end_day: i64,
    /// 1 人あたりこの予定で失われる時間。負の値は「終日休み」を表す。
    pub hours: f64,
}

/// カレンダーの設定。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalendarConfig {
    pub start_day: i64,
    pub horizon_days: usize,
    /// ビット i (0 = 日曜) が立っていればその曜日は稼働日。
    pub weekday_mask: u8,
    pub hours_per_day: f64,
    pub hours_per_person_day: f64,
    pub team_size: f64,
    pub use_japanese_holidays: bool,
}

impl CalendarConfig {
    /// 1 稼働日あたりに投入できる工数 (人日)。
    pub fn base_capacity(&self) -> f64 {
        if self.hours_per_person_day <= 0.0 {
            return 0.0;
        }
        (self.team_size * self.hours_per_day / self.hours_per_person_day).max(0.0)
    }
}

/// 日ごとの稼働可能工数とその累積。
#[derive(Debug, Clone)]
pub struct Calendar {
    start_day: i64,
    capacity: Vec<f64>,
    cumulative: Vec<f64>,
    flags: Vec<u8>,
}

impl Calendar {
    /// 設定と予定からカレンダーを組み立てる。
    ///
    /// `forced_workdays` は週末・祝日であっても稼働する日 (休日出勤)。
    pub fn build(
        config: &CalendarConfig,
        events: &[CalendarEvent],
        forced_workdays: &[i64],
    ) -> Self {
        let horizon = config.horizon_days.min(MAX_HORIZON_DAYS);
        let base = config.base_capacity();

        // 対象期間にかかる年の祝日をまとめて求めておく。
        let holidays = if config.use_japanese_holidays && horizon > 0 {
            let first = civil_from_days(config.start_day).0;
            let last = civil_from_days(config.start_day + horizon as i64).0;
            let mut all: Vec<i64> = (first..=last).flat_map(japanese_holidays).collect();
            all.sort_unstable();
            all
        } else {
            Vec::new()
        };

        let mut capacity = Vec::with_capacity(horizon);
        let mut cumulative = Vec::with_capacity(horizon);
        let mut flags = Vec::with_capacity(horizon);
        let mut running = 0.0;

        for offset in 0..horizon {
            let day = config.start_day + offset as i64;
            let mut mark = 0u8;

            if (config.weekday_mask >> weekday(day)) & 1 == 0 {
                mark |= FLAG_WEEKEND;
            }
            if holidays.binary_search(&day).is_ok() {
                mark |= FLAG_HOLIDAY;
            }
            let forced = forced_workdays.contains(&day);
            if forced && mark & (FLAG_WEEKEND | FLAG_HOLIDAY) != 0 {
                mark |= FLAG_FORCED_WORKDAY;
            }

            let mut available = if mark & (FLAG_WEEKEND | FLAG_HOLIDAY) != 0 && !forced {
                0.0
            } else {
                base
            };

            for event in events {
                if day < event.start_day || day > event.end_day {
                    continue;
                }
                mark |= FLAG_EVENT;
                if event.hours < 0.0 {
                    available = 0.0;
                } else if config.hours_per_person_day > 0.0 {
                    available -= config.team_size * event.hours / config.hours_per_person_day;
                }
            }

            let available = if available.is_finite() {
                available.max(0.0)
            } else {
                0.0
            };
            running += available;
            capacity.push(available);
            cumulative.push(running);
            flags.push(mark);
        }

        Self {
            start_day: config.start_day,
            capacity,
            cumulative,
            flags,
        }
    }

    #[inline]
    pub fn start_day(&self) -> i64 {
        self.start_day
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.capacity.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.capacity.is_empty()
    }

    #[inline]
    pub fn capacity(&self) -> &[f64] {
        &self.capacity
    }

    /// `cumulative()[i]` は開始日から i 日目までに投入できる工数の合計。
    #[inline]
    pub fn cumulative(&self) -> &[f64] {
        &self.cumulative
    }

    #[inline]
    pub fn flags(&self) -> &[u8] {
        &self.flags
    }

    /// カレンダー全体で投入できる工数。
    pub fn total_capacity(&self) -> f64 {
        self.cumulative.last().copied().unwrap_or(0.0)
    }

    /// `effort` 人日の作業を終えられる最初の日の添字。期間内に終わらなければ `None`。
    pub fn day_index_for_effort(&self, effort: f64) -> Option<usize> {
        if self.cumulative.is_empty() {
            return None;
        }
        let index = self.cumulative.partition_point(|&c| c < effort);
        if index < self.cumulative.len() {
            Some(index)
        } else {
            None
        }
    }

    /// `from` から `to` まで (両端を含む) に投入できる工数。
    /// カレンダーの範囲外は 0 として扱う。
    pub fn capacity_between(&self, from: i64, to: i64) -> f64 {
        if self.cumulative.is_empty() || to < from {
            return 0.0;
        }
        let last = self.start_day + self.len() as i64 - 1;
        if to < self.start_day || from > last {
            return 0.0;
        }
        let lo = (from.max(self.start_day) - self.start_day) as usize;
        let hi = (to.min(last) - self.start_day) as usize;
        let before = if lo == 0 {
            0.0
        } else {
            self.cumulative[lo - 1]
        };
        (self.cumulative[hi] - before).max(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::date::days_from_civil;

    /// 月〜金稼働、1 人、8 時間/日、1 人日 = 8 時間。
    fn weekday_config(start: (i32, u32, u32), horizon: usize) -> CalendarConfig {
        CalendarConfig {
            start_day: days_from_civil(start.0, start.1, start.2),
            horizon_days: horizon,
            weekday_mask: 0b0011_1110, // 月〜金 (bit0=日 … bit6=土)
            hours_per_day: 8.0,
            hours_per_person_day: 8.0,
            team_size: 1.0,
            use_japanese_holidays: false,
        }
    }

    #[test]
    fn weekends_have_no_capacity() {
        // 2026-09-21 は月曜。
        let cal = Calendar::build(&weekday_config((2026, 9, 21), 14), &[], &[]);
        let cap = cal.capacity();
        assert_eq!(&cap[0..5], &[1.0; 5], "月〜金は 1 人日");
        assert_eq!(&cap[5..7], &[0.0; 2], "土日は 0");
        assert_eq!(cal.flags()[5] & FLAG_WEEKEND, FLAG_WEEKEND);
        assert_eq!(cal.total_capacity(), 10.0, "2 週で 10 人日");
    }

    #[test]
    fn team_size_and_hours_scale_the_capacity() {
        let mut config = weekday_config((2026, 9, 21), 5);
        config.team_size = 3.0;
        config.hours_per_day = 6.0;
        assert_eq!(config.base_capacity(), 3.0 * 6.0 / 8.0);
        let cal = Calendar::build(&config, &[], &[]);
        assert!((cal.total_capacity() - 5.0 * 2.25).abs() < 1e-12);
    }

    #[test]
    fn japanese_holidays_remove_capacity() {
        let mut config = weekday_config((2026, 9, 21), 7);
        config.use_japanese_holidays = true;
        let cal = Calendar::build(&config, &[], &[]);
        // 2026-09-21 敬老の日、9/22 国民の休日、9/23 秋分の日。
        assert_eq!(&cal.capacity()[0..3], &[0.0; 3], "3 連休のはず");
        assert_eq!(cal.flags()[0] & FLAG_HOLIDAY, FLAG_HOLIDAY);
        assert_eq!(&cal.capacity()[3..5], &[1.0; 2], "木金は稼働");
    }

    #[test]
    fn a_forced_workday_overrides_a_holiday() {
        let mut config = weekday_config((2026, 9, 21), 7);
        config.use_japanese_holidays = true;
        let holiday = days_from_civil(2026, 9, 22);
        let cal = Calendar::build(&config, &[], &[holiday]);
        assert_eq!(cal.capacity()[1], 1.0, "休日出勤した日は稼働する");
        assert_eq!(cal.flags()[1] & FLAG_FORCED_WORKDAY, FLAG_FORCED_WORKDAY);
        assert_eq!(
            cal.flags()[1] & FLAG_HOLIDAY,
            FLAG_HOLIDAY,
            "祝日である事実は残す"
        );
    }

    #[test]
    fn an_all_day_event_zeroes_the_day() {
        let config = weekday_config((2026, 9, 21), 5);
        let day = days_from_civil(2026, 9, 23);
        let cal = Calendar::build(
            &config,
            &[CalendarEvent {
                start_day: day,
                end_day: day,
                hours: -1.0,
            }],
            &[],
        );
        assert_eq!(cal.capacity()[2], 0.0);
        assert_eq!(cal.flags()[2] & FLAG_EVENT, FLAG_EVENT);
        assert_eq!(cal.total_capacity(), 4.0);
    }

    #[test]
    fn an_hourly_event_reduces_the_day_proportionally() {
        let mut config = weekday_config((2026, 9, 21), 5);
        config.team_size = 2.0; // 基準は 2 人日/日
        let day = days_from_civil(2026, 9, 22);
        let cal = Calendar::build(
            &config,
            &[CalendarEvent {
                start_day: day,
                end_day: day,
                hours: 2.0, // 全員が 2 時間とられる → 2 人 × 2h ÷ 8h = 0.5 人日
            }],
            &[],
        );
        assert!((cal.capacity()[1] - 1.5).abs() < 1e-12);
    }

    #[test]
    fn events_spanning_several_days_apply_to_each_day() {
        let config = weekday_config((2026, 9, 21), 7);
        let cal = Calendar::build(
            &config,
            &[CalendarEvent {
                start_day: days_from_civil(2026, 9, 22),
                end_day: days_from_civil(2026, 9, 24),
                hours: -1.0,
            }],
            &[],
        );
        assert_eq!(&cal.capacity()[1..4], &[0.0; 3]);
        assert_eq!(cal.total_capacity(), 2.0, "月曜と金曜だけ残る");
    }

    #[test]
    fn overlapping_events_never_push_capacity_below_zero() {
        let config = weekday_config((2026, 9, 21), 3);
        let day = days_from_civil(2026, 9, 21);
        let events = vec![
            CalendarEvent {
                start_day: day,
                end_day: day,
                hours: 6.0,
            },
            CalendarEvent {
                start_day: day,
                end_day: day,
                hours: 6.0,
            },
        ];
        let cal = Calendar::build(&config, &events, &[]);
        assert_eq!(cal.capacity()[0], 0.0, "負の工数は出さない");
    }

    #[test]
    fn effort_maps_to_the_day_it_finishes_on() {
        let cal = Calendar::build(&weekday_config((2026, 9, 21), 14), &[], &[]);
        // 1 人日/日なので、3 人日は 3 日目 (添字 2) に終わる。
        assert_eq!(cal.day_index_for_effort(3.0), Some(2));
        assert_eq!(cal.day_index_for_effort(0.5), Some(0));
        // 5 人日を超えると週末を挟んで翌週になる。
        assert_eq!(cal.day_index_for_effort(5.5), Some(7));
        // 期間内に終わらない工数。
        assert_eq!(cal.day_index_for_effort(100.0), None);
    }

    #[test]
    fn capacity_between_clamps_to_the_calendar_range() {
        let cal = Calendar::build(&weekday_config((2026, 9, 21), 14), &[], &[]);
        let monday = days_from_civil(2026, 9, 21);
        assert_eq!(cal.capacity_between(monday, monday + 4), 5.0);
        assert_eq!(cal.capacity_between(monday + 5, monday + 6), 0.0, "土日");
        // 範囲外は 0 として扱う。
        assert_eq!(cal.capacity_between(monday - 100, monday - 50), 0.0);
        assert_eq!(cal.capacity_between(monday + 500, monday + 600), 0.0);
        // 片側だけはみ出す場合は重なった分だけ数える。
        assert_eq!(cal.capacity_between(monday - 10, monday + 4), 5.0);
        // 逆転した期間は 0。
        assert_eq!(cal.capacity_between(monday + 4, monday), 0.0);
    }

    #[test]
    fn cumulative_capacity_is_monotone() {
        let mut config = weekday_config((2026, 1, 1), 400);
        config.use_japanese_holidays = true;
        let cal = Calendar::build(&config, &[], &[]);
        assert!(cal.cumulative().windows(2).all(|w| w[1] >= w[0]));
        assert!(cal.capacity().iter().all(|&c| c >= 0.0));
        assert_eq!(cal.len(), 400);
    }

    #[test]
    fn a_horizon_beyond_the_limit_is_clamped() {
        let config = weekday_config((2026, 1, 1), MAX_HORIZON_DAYS + 5_000);
        let cal = Calendar::build(&config, &[], &[]);
        assert_eq!(cal.len(), MAX_HORIZON_DAYS);
    }

    #[test]
    fn a_calendar_with_no_working_days_finishes_nothing() {
        let mut config = weekday_config((2026, 9, 21), 30);
        config.weekday_mask = 0;
        let cal = Calendar::build(&config, &[], &[]);
        assert_eq!(cal.total_capacity(), 0.0);
        assert_eq!(cal.day_index_for_effort(1.0), None);
    }
}
