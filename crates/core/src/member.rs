//! 人員ごとの稼働予定。
//!
//! 「1 日 8 時間」ではなく **曜日ごとの時間帯** (何時から何時まで) で持つ。
//! 予定を 5 分単位の時刻で入れられるようにするには、予定と稼働時間の
//! **重なり**を測る必要があり、そのためには稼働側も時間帯でなければならない。
//! 9:00〜18:00 の人にとって 8:00〜9:00 の予定は稼働を 1 分も削らない。

/// 1 日の分数。
pub const MINUTES_PER_DAY: i32 = 24 * 60;

/// 1 人の稼働予定。
///
/// 稼働時間帯は 1 日 1 本にし、昼休みは「毎日そのぶん差し引く分数」として持つ。
/// 午前・午後の 2 本に分けるほうが厳密だが、入力する欄が一気に倍になる割に
/// 得られる精度は休憩の長さぶんでしかない。9:00〜18:00 から 60 分引けば
/// ちょうど 8 時間 = 1 人日になり、既定値が素直に収まる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemberSchedule {
    /// 曜日ごとの稼働開始 (0 時からの分)。添字 0 が日曜。
    start: [i32; 7],
    /// 曜日ごとの稼働終了。`start` と同じなら非稼働日。
    end: [i32; 7],
    /// 稼働日 1 日あたりの休憩分数。
    break_minutes: i32,
}

impl Default for MemberSchedule {
    /// 月〜金の 9:00〜18:00、休憩 60 分 (= 1 日 8 時間)。
    fn default() -> Self {
        let mut start = [0; 7];
        let mut end = [0; 7];
        for weekday in 1..=5 {
            start[weekday] = 9 * 60;
            end[weekday] = 18 * 60;
        }
        Self {
            start,
            end,
            break_minutes: 60,
        }
    }
}

impl MemberSchedule {
    /// 時刻を `0..=MINUTES_PER_DAY` に丸め、終了が開始を下回らないようにして作る。
    pub fn new(start: [i32; 7], end: [i32; 7]) -> Self {
        Self::with_break(start, end, 0)
    }

    /// 休憩時間つきで作る。
    pub fn with_break(start: [i32; 7], end: [i32; 7], break_minutes: i32) -> Self {
        let mut normalized_start = [0; 7];
        let mut normalized_end = [0; 7];
        for weekday in 0..7 {
            let from = start[weekday].clamp(0, MINUTES_PER_DAY);
            let to = end[weekday].clamp(0, MINUTES_PER_DAY);
            normalized_start[weekday] = from;
            normalized_end[weekday] = to.max(from);
        }
        Self {
            start: normalized_start,
            end: normalized_end,
            break_minutes: break_minutes.clamp(0, MINUTES_PER_DAY),
        }
    }

    /// その曜日の稼働時間帯。非稼働なら `None`。
    pub fn window(&self, weekday: u32) -> Option<(i32, i32)> {
        let index = (weekday as usize).min(6);
        let (from, to) = (self.start[index], self.end[index]);
        if to > from {
            Some((from, to))
        } else {
            None
        }
    }

    /// 稼働日 1 日あたりの休憩分数。
    pub fn break_minutes(&self) -> i32 {
        self.break_minutes
    }

    /// その曜日に実際に働ける分数 (休憩を引いたもの)。
    pub fn working_minutes(&self, weekday: u32) -> i32 {
        match self.window(weekday) {
            Some((from, to)) => (to - from - self.break_minutes).max(0),
            None => 0,
        }
    }

    /// 1 週間ぶんの稼働分数 (休憩を引いたもの)。
    pub fn weekly_minutes(&self) -> i32 {
        (0..7).map(|weekday| self.working_minutes(weekday)).sum()
    }

    pub fn starts(&self) -> [i32; 7] {
        self.start
    }

    pub fn ends(&self) -> [i32; 7] {
        self.end
    }
}

/// 区間の集合が覆う長さ。重なった予定を二重に数えないために使う。
///
/// 入力は `(開始, 終了)` の並び。順序は問わない。
pub fn union_length(intervals: &mut [(i32, i32)]) -> i32 {
    if intervals.is_empty() {
        return 0;
    }
    intervals.sort_unstable();

    let mut total = 0;
    let mut current = intervals[0];
    for &(from, to) in &intervals[1..] {
        if from > current.1 {
            total += current.1 - current.0;
            current = (from, to);
        } else if to > current.1 {
            current.1 = to;
        }
    }
    total + (current.1 - current.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_schedule_is_a_weekday_nine_to_six_with_a_lunch_break() {
        let schedule = MemberSchedule::default();
        assert_eq!(schedule.window(0), None, "日曜は休み");
        assert_eq!(schedule.window(6), None, "土曜は休み");
        assert_eq!(schedule.window(1), Some((540, 1080)));
        assert_eq!(schedule.break_minutes(), 60);
        assert_eq!(
            schedule.working_minutes(1),
            8 * 60,
            "休憩を引くとちょうど 8 時間"
        );
        assert_eq!(schedule.working_minutes(0), 0);
        assert_eq!(schedule.weekly_minutes(), 5 * 8 * 60);
    }

    #[test]
    fn a_break_longer_than_the_day_does_not_go_negative() {
        let schedule =
            MemberSchedule::with_break([0, 540, 0, 0, 0, 0, 0], [0, 600, 0, 0, 0, 0, 0], 300);
        assert_eq!(schedule.working_minutes(1), 0);
        assert_eq!(schedule.weekly_minutes(), 0);
    }

    #[test]
    fn times_are_clamped_and_ordered() {
        let schedule = MemberSchedule::new([-100; 7], [5_000; 7]);
        assert_eq!(schedule.window(3), Some((0, MINUTES_PER_DAY)));

        // 終了が開始より前なら、幅ゼロ (非稼働) に潰す。
        let reversed = MemberSchedule::new([600; 7], [300; 7]);
        assert_eq!(reversed.window(3), None);
    }

    #[test]
    fn five_minute_granularity_survives() {
        let schedule = MemberSchedule::new([0, 545, 0, 0, 0, 0, 0], [0, 1075, 0, 0, 0, 0, 0]);
        assert_eq!(schedule.window(1), Some((545, 1075)), "9:05〜17:55");
        assert_eq!(
            schedule.weekly_minutes(),
            530,
            "休憩 0 分なら窓の長さそのもの"
        );
    }

    #[test]
    fn union_length_merges_overlaps() {
        assert_eq!(union_length(&mut []), 0);
        assert_eq!(union_length(&mut [(0, 60)]), 60);
        // 隣り合うだけなら足し算。
        assert_eq!(union_length(&mut [(0, 60), (60, 120)]), 120);
        // 重なった分は 1 回だけ数える。
        assert_eq!(union_length(&mut [(0, 60), (30, 90)]), 90);
        // 完全に含まれる区間は無視される。
        assert_eq!(union_length(&mut [(0, 120), (30, 60)]), 120);
        // 順不同でも同じ。
        assert_eq!(union_length(&mut [(100, 150), (0, 60), (30, 90)]), 140);
        // 幅ゼロは影響しない。
        assert_eq!(union_length(&mut [(0, 60), (200, 200)]), 60);
    }

    #[test]
    fn two_overlapping_meetings_do_not_cost_double() {
        // 10:00〜11:00 と 10:30〜11:30 に呼ばれても、失うのは 90 分。
        let mut intervals = [(600, 660), (630, 690)];
        assert_eq!(union_length(&mut intervals), 90);
    }
}
