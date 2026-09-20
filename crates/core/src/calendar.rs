//! 人員ひとりぶんの稼働カレンダー。「何人日の作業がいつ終わるか」の土台。
//!
//! 工数 (人日) と暦日をつなぐのがこのモジュールの役割。各暦日に
//! **その人がその日に投入できる工数 (人日)** を割り当て、その累積を持っておくと、
//! 「累積が X 人日に達する最初の日」＝ X 人日の作業が終わる日、として引ける。
//!
//! 1 日の工数は次のように決まる:
//!
//! ```text
//! 稼働分数 = その曜日の稼働時間帯の長さ
//!            − 予定が稼働時間帯を覆う分数 (重なりは 1 回だけ数える)
//! 工数     = 稼働分数 ÷ 60 ÷ 1人日あたりの時間
//! 週末・祝日 → 0 (ただし特別稼働日に指定されていれば通常どおり)
//! ```
//!
//! 予定を分単位の時刻で持つのは、5 分刻みの会議を正しく引くため。
//! 稼働時間帯の外にある予定は 1 分も削らない。

use crate::date::weekday;
use crate::member::{union_length, MemberSchedule};

/// 非稼働曜日。
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
///
/// `repeat_weeks` が 1 以上なら、その週数ごとに同じ曜日・同じ時刻で繰り返す
/// (1 = 毎週、2 = 隔週)。`until_day` まで続き、`None` なら期間いっぱい。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalendarEvent {
    pub start_day: i64,
    pub end_day: i64,
    /// 開始時刻 (0 時からの分)。`None` なら終日。
    pub start_minute: Option<i32>,
    /// 終了時刻 (0 時からの分)。
    pub end_minute: Option<i32>,
    pub repeat_weeks: u32,
    pub until_day: Option<i64>,
}

impl CalendarEvent {
    /// 終日休みの予定。
    pub fn all_day(start_day: i64, end_day: i64) -> Self {
        Self {
            start_day,
            end_day,
            start_minute: None,
            end_minute: None,
            repeat_weeks: 0,
            until_day: None,
        }
    }

    /// その日にこの予定が発生するか。
    pub fn occurs_on(&self, day: i64) -> bool {
        if day < self.start_day {
            return false;
        }
        if self.repeat_weeks == 0 {
            return day <= self.end_day;
        }

        let period = 7 * self.repeat_weeks as i64;
        let span = self.end_day - self.start_day;
        // 期間より長い予定も扱えるよう、直近の 2 回ぶんを見る。
        let latest = (day - self.start_day) / period;
        for back in 0..=1 {
            let index = latest - back;
            if index < 0 {
                continue;
            }
            let from = self.start_day + period * index;
            if let Some(until) = self.until_day {
                if from > until {
                    continue;
                }
            }
            if day >= from && day <= from + span {
                return true;
            }
        }
        false
    }

    /// その日に失われる時間帯。終日なら稼働時間帯そのもの。
    fn busy_window(&self, work: (i32, i32)) -> (i32, i32) {
        match (self.start_minute, self.end_minute) {
            (Some(from), Some(to)) => (from.max(work.0), to.min(work.1)),
            // 片側しか無い、あるいは終日の指定はまるごと潰す。
            _ => work,
        }
    }
}

/// カレンダー全体で共通の設定。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalendarConfig {
    pub start_day: i64,
    pub horizon_days: usize,
    /// 1 人日を何時間とみなすか。
    pub hours_per_person_day: f64,
}

/// 人員ひとりぶんの、日ごとの稼働可能工数とその累積。
#[derive(Debug, Clone)]
pub struct Calendar {
    start_day: i64,
    capacity: Vec<f64>,
    cumulative: Vec<f64>,
    flags: Vec<u8>,
}

impl Calendar {
    /// 設定・稼働予定・予定からカレンダーを組み立てる。
    ///
    /// `holidays` は昇順に並んだ祝日 (全員に共通)。
    /// `forced_workdays` は週末・祝日でも稼働する日。
    pub fn build(
        config: &CalendarConfig,
        schedule: &MemberSchedule,
        events: &[CalendarEvent],
        forced_workdays: &[i64],
        holidays: &[i64],
    ) -> Self {
        let horizon = config.horizon_days.min(MAX_HORIZON_DAYS);
        let minutes_per_person_day = (config.hours_per_person_day * 60.0).max(1.0);

        let mut capacity = Vec::with_capacity(horizon);
        let mut cumulative = Vec::with_capacity(horizon);
        let mut flags = Vec::with_capacity(horizon);
        let mut running = 0.0;
        let mut busy: Vec<(i32, i32)> = Vec::new();

        for offset in 0..horizon {
            let day = config.start_day + offset as i64;
            let mut mark = 0u8;

            let window = schedule.window(weekday(day));
            if window.is_none() {
                mark |= FLAG_WEEKEND;
            }
            if holidays.binary_search(&day).is_ok() {
                mark |= FLAG_HOLIDAY;
            }
            let forced = forced_workdays.contains(&day);
            if forced && mark & (FLAG_WEEKEND | FLAG_HOLIDAY) != 0 {
                mark |= FLAG_FORCED_WORKDAY;
            }

            // 予定は稼働日でなくても「入っている」ことは示す (画面で見えるように)。
            busy.clear();
            for event in events {
                if !event.occurs_on(day) {
                    continue;
                }
                mark |= FLAG_EVENT;
                if let Some(work) = window {
                    let (from, to) = event.busy_window(work);
                    if to > from {
                        busy.push((from, to));
                    }
                }
            }

            let available = match window {
                // 祝日は稼働しない。特別稼働日に指定されていればそのまま働く。
                Some(_) if mark & FLAG_HOLIDAY != 0 && !forced => 0.0,
                Some((from, to)) => {
                    let minutes =
                        (to - from - schedule.break_minutes() - union_length(&mut busy)).max(0);
                    minutes as f64 / minutes_per_person_day
                }
                // 非稼働曜日でも、特別稼働日なら平日の標準的な稼働時間で働くとみなす。
                None if forced => {
                    let weekday_minutes = (0..7)
                        .map(|w| schedule.working_minutes(w))
                        .max()
                        .unwrap_or(0);
                    weekday_minutes as f64 / minutes_per_person_day
                }
                None => 0.0,
            };

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

/// 期間にかかる年の日本の祝日を、昇順に並べて返す。
pub fn japanese_holidays_for(start_day: i64, horizon_days: usize) -> Vec<i64> {
    use crate::date::{civil_from_days, japanese_holidays};
    if horizon_days == 0 {
        return Vec::new();
    }
    let first = civil_from_days(start_day).0;
    let last = civil_from_days(start_day + horizon_days as i64).0;
    let mut all: Vec<i64> = (first..=last).flat_map(japanese_holidays).collect();
    all.sort_unstable();
    all
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::date::days_from_civil;

    /// 2026-09-21 は月曜。
    const MONDAY: (i32, u32, u32) = (2026, 9, 21);

    fn day(offset: i64) -> i64 {
        days_from_civil(MONDAY.0, MONDAY.1, MONDAY.2) + offset
    }

    fn config(horizon: usize) -> CalendarConfig {
        CalendarConfig {
            start_day: day(0),
            horizon_days: horizon,
            hours_per_person_day: 8.0,
        }
    }

    /// 月〜金 9:00〜17:00 (= 8 時間 = 1 人日)。
    fn eight_hour_weekdays() -> MemberSchedule {
        let mut start = [0; 7];
        let mut end = [0; 7];
        for weekday in 1..=5 {
            start[weekday] = 9 * 60;
            end[weekday] = 17 * 60;
        }
        MemberSchedule::new(start, end)
    }

    fn build(horizon: usize, events: &[CalendarEvent]) -> Calendar {
        Calendar::build(&config(horizon), &eight_hour_weekdays(), events, &[], &[])
    }

    #[test]
    fn weekends_have_no_capacity() {
        let cal = build(14, &[]);
        assert_eq!(&cal.capacity()[0..5], &[1.0; 5], "月〜金は 1 人日");
        assert_eq!(&cal.capacity()[5..7], &[0.0; 2], "土日は 0");
        assert_eq!(cal.flags()[5] & FLAG_WEEKEND, FLAG_WEEKEND);
        assert_eq!(cal.total_capacity(), 10.0, "2 週で 10 人日");
    }

    #[test]
    fn the_working_window_decides_the_capacity() {
        // 10:00〜14:00 だけ働く人は 0.5 人日/日。
        let mut start = [0; 7];
        let mut end = [0; 7];
        for weekday in 1..=5 {
            start[weekday] = 10 * 60;
            end[weekday] = 14 * 60;
        }
        let cal = Calendar::build(&config(5), &MemberSchedule::new(start, end), &[], &[], &[]);
        assert_eq!(cal.total_capacity(), 2.5);
    }

    #[test]
    fn a_meeting_costs_exactly_its_overlap_with_the_working_hours() {
        // 9:00〜17:00 の人にとって、10:00〜10:45 の会議は 45 分。
        let cal = build(
            2,
            &[CalendarEvent {
                start_day: day(0),
                end_day: day(0),
                start_minute: Some(10 * 60),
                end_minute: Some(10 * 60 + 45),
                repeat_weeks: 0,
                until_day: None,
            }],
        );
        assert!((cal.capacity()[0] - (480.0 - 45.0) / 480.0).abs() < 1e-12);
        assert_eq!(cal.flags()[0] & FLAG_EVENT, FLAG_EVENT);
    }

    #[test]
    fn a_meeting_outside_the_working_hours_costs_nothing() {
        // 8:00〜9:00 は稼働時間の外。
        let cal = build(
            2,
            &[CalendarEvent {
                start_day: day(0),
                end_day: day(0),
                start_minute: Some(8 * 60),
                end_minute: Some(9 * 60),
                repeat_weeks: 0,
                until_day: None,
            }],
        );
        assert_eq!(cal.capacity()[0], 1.0, "稼働時間を 1 分も削らない");
        assert_eq!(cal.flags()[0] & FLAG_EVENT, FLAG_EVENT, "予定自体はある");
    }

    #[test]
    fn a_meeting_is_clipped_to_the_working_hours() {
        // 16:00〜19:00 のうち、稼働中なのは 16:00〜17:00 の 1 時間だけ。
        let cal = build(
            2,
            &[CalendarEvent {
                start_day: day(0),
                end_day: day(0),
                start_minute: Some(16 * 60),
                end_minute: Some(19 * 60),
                repeat_weeks: 0,
                until_day: None,
            }],
        );
        assert!((cal.capacity()[0] - 420.0 / 480.0).abs() < 1e-12);
    }

    #[test]
    fn overlapping_meetings_are_counted_once() {
        let overlapping = [
            CalendarEvent {
                start_day: day(0),
                end_day: day(0),
                start_minute: Some(10 * 60),
                end_minute: Some(11 * 60),
                repeat_weeks: 0,
                until_day: None,
            },
            CalendarEvent {
                start_day: day(0),
                end_day: day(0),
                start_minute: Some(10 * 60 + 30),
                end_minute: Some(11 * 60 + 30),
                repeat_weeks: 0,
                until_day: None,
            },
        ];
        let cal = build(2, &overlapping);
        // 10:00〜11:30 の 90 分。
        assert!((cal.capacity()[0] - (480.0 - 90.0) / 480.0).abs() < 1e-12);
    }

    #[test]
    fn an_all_day_event_zeroes_the_day() {
        let cal = build(3, &[CalendarEvent::all_day(day(1), day(1))]);
        assert_eq!(cal.capacity()[1], 0.0);
        assert_eq!(cal.total_capacity(), 2.0);
    }

    #[test]
    fn a_weekly_meeting_repeats_on_the_same_weekday() {
        let weekly = CalendarEvent {
            start_day: day(0),
            end_day: day(0),
            start_minute: Some(10 * 60),
            end_minute: Some(11 * 60),
            repeat_weeks: 1,
            until_day: None,
        };
        let cal = build(21, &[weekly]);
        for week in 0..3 {
            let index = (week * 7) as usize;
            assert!(
                (cal.capacity()[index] - 420.0 / 480.0).abs() < 1e-12,
                "{week} 週目の月曜"
            );
            assert_eq!(
                cal.capacity()[index + 1],
                1.0,
                "{week} 週目の火曜は影響なし"
            );
        }
    }

    #[test]
    fn a_biweekly_meeting_skips_every_other_week() {
        let biweekly = CalendarEvent {
            start_day: day(0),
            end_day: day(0),
            start_minute: Some(13 * 60),
            end_minute: Some(14 * 60),
            repeat_weeks: 2,
            until_day: None,
        };
        let cal = build(28, &[biweekly]);
        for week in 0..4 {
            let index = (week * 7) as usize;
            let affected = week % 2 == 0;
            let expected = if affected { 420.0 / 480.0 } else { 1.0 };
            assert!(
                (cal.capacity()[index] - expected).abs() < 1e-12,
                "{week} 週目 (影響あり: {affected})"
            );
        }
    }

    #[test]
    fn a_repeat_stops_at_its_end_date() {
        let weekly = CalendarEvent {
            start_day: day(0),
            end_day: day(0),
            start_minute: Some(10 * 60),
            end_minute: Some(11 * 60),
            repeat_weeks: 1,
            until_day: Some(day(8)),
        };
        let cal = build(28, &[weekly]);
        assert!(cal.capacity()[0] < 1.0, "1 回目");
        assert!(cal.capacity()[7] < 1.0, "2 回目 (until 以内)");
        assert_eq!(cal.capacity()[14], 1.0, "3 回目は until を越えるので無い");
    }

    #[test]
    fn a_multi_day_event_repeats_as_a_block() {
        // 月〜水の合宿が隔週である、という形。
        let block = CalendarEvent {
            start_day: day(0),
            end_day: day(2),
            start_minute: None,
            end_minute: None,
            repeat_weeks: 2,
            until_day: None,
        };
        let cal = build(28, &[block]);
        assert_eq!(&cal.capacity()[0..3], &[0.0; 3], "1 回目");
        assert_eq!(&cal.capacity()[3..5], &[1.0; 2], "木金は通常どおり");
        assert_eq!(&cal.capacity()[7..10], &[1.0; 3], "翌週は無い");
        assert_eq!(&cal.capacity()[14..17], &[0.0; 3], "2 回目");
    }

    #[test]
    fn japanese_holidays_remove_capacity() {
        let holidays = japanese_holidays_for(day(0), 7);
        let cal = Calendar::build(&config(7), &eight_hour_weekdays(), &[], &[], &holidays);
        // 2026-09-21 敬老の日、9/22 国民の休日、9/23 秋分の日。
        assert_eq!(&cal.capacity()[0..3], &[0.0; 3], "3 連休のはず");
        assert_eq!(cal.flags()[0] & FLAG_HOLIDAY, FLAG_HOLIDAY);
        assert_eq!(&cal.capacity()[3..5], &[1.0; 2], "木金は稼働");
    }

    #[test]
    fn a_forced_workday_overrides_a_holiday_and_a_weekend() {
        let holidays = japanese_holidays_for(day(0), 7);
        let forced = [day(1), day(5)]; // 祝日の火曜と、土曜
        let cal = Calendar::build(&config(7), &eight_hour_weekdays(), &[], &forced, &holidays);
        assert_eq!(cal.capacity()[1], 1.0, "祝日に出勤");
        assert_eq!(cal.flags()[1] & FLAG_FORCED_WORKDAY, FLAG_FORCED_WORKDAY);
        assert_eq!(cal.capacity()[5], 1.0, "土曜に出勤");
    }

    #[test]
    fn effort_maps_to_the_day_it_finishes_on() {
        let cal = build(14, &[]);
        assert_eq!(cal.day_index_for_effort(3.0), Some(2));
        assert_eq!(cal.day_index_for_effort(0.5), Some(0));
        assert_eq!(cal.day_index_for_effort(5.5), Some(7), "週末をまたぐ");
        assert_eq!(cal.day_index_for_effort(100.0), None);
    }

    #[test]
    fn capacity_between_clamps_to_the_calendar_range() {
        let cal = build(14, &[]);
        assert_eq!(cal.capacity_between(day(0), day(4)), 5.0);
        assert_eq!(cal.capacity_between(day(5), day(6)), 0.0, "土日");
        assert_eq!(cal.capacity_between(day(-100), day(-50)), 0.0);
        assert_eq!(cal.capacity_between(day(500), day(600)), 0.0);
        assert_eq!(cal.capacity_between(day(-10), day(4)), 5.0);
        assert_eq!(cal.capacity_between(day(4), day(0)), 0.0, "逆転した期間");
    }

    #[test]
    fn cumulative_capacity_is_monotone() {
        let holidays = japanese_holidays_for(day(0), 400);
        let cal = Calendar::build(
            &config(400),
            &MemberSchedule::default(),
            &[],
            &[],
            &holidays,
        );
        assert!(cal.cumulative().windows(2).all(|w| w[1] >= w[0]));
        assert!(cal.capacity().iter().all(|&c| c >= 0.0));
        assert_eq!(cal.len(), 400);
    }

    #[test]
    fn a_horizon_beyond_the_limit_is_clamped() {
        let mut settings = config(MAX_HORIZON_DAYS + 5_000);
        settings.horizon_days = MAX_HORIZON_DAYS + 5_000;
        let cal = Calendar::build(&settings, &eight_hour_weekdays(), &[], &[], &[]);
        assert_eq!(cal.len(), MAX_HORIZON_DAYS);
    }

    #[test]
    fn a_schedule_with_no_working_days_finishes_nothing() {
        let cal = Calendar::build(
            &config(30),
            &MemberSchedule::new([0; 7], [0; 7]),
            &[],
            &[],
            &[],
        );
        assert_eq!(cal.total_capacity(), 0.0);
        assert_eq!(cal.day_index_for_effort(1.0), None);
    }
}
