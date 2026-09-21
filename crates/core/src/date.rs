//! 暦の計算。グレゴリオ暦の日付と「1970-01-01 からの日数」の相互変換と、日本の祝日。
//!
//! 外部クレートを使わずに済ませているのは、WASM のサイズを抑えるためと、
//! タイムゾーンの概念を持ち込まないため。このアプリが扱うのは「何月何日」という
//! 暦日だけで、時刻も UTC オフセットも登場しない。日付はすべて
//! **1970-01-01 を 0 とする日数** (`day number`) で表す。

/// 日数から曜日を求める。`0` = 日曜、`6` = 土曜。
///
/// 1970-01-01 は木曜日なので、そこを基準にしている。
///
/// **先に 7 で割ってから 4 を足す。** 素直に `day + 4` と書くと
/// `i64` の上端で桁あふれする (Kani が見つけた)。実際の日数は暦の範囲に
/// 収まるが、公開の関数が入力次第で panic しうる状態にはしておかない。
pub fn weekday(day: i64) -> u32 {
    (day.rem_euclid(7) + 4).rem_euclid(7) as u32
}

/// 年月日から日数へ。
///
/// Howard Hinnant の `days_from_civil`。3 月を年の始まりとみなすことで
/// うるう年の分岐を 4 年・100 年・400 年周期の割り算だけで表せる。
pub fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = ((month + 9) % 12) as i64; // 3 月が 0
    let doy = (153 * mp + 2) / 5 + day as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 日数から年月日へ ([`days_from_civil`] の逆)。
pub fn civil_from_days(day: i64) -> (i32, u32, u32) {
    let z = day + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

/// その月の n 番目の指定曜日 (n は 1 始まり) の日数。
fn nth_weekday(year: i32, month: u32, target: u32, n: u32) -> i64 {
    let first = days_from_civil(year, month, 1);
    let shift = (target + 7 - weekday(first)) % 7;
    first + shift as i64 + (n as i64 - 1) * 7
}

/// 春分日・秋分日の近似式 (1980〜2099 年で実用上十分な精度)。
///
/// 正確な春分・秋分は国立天文台が前年 2 月に官報で公表するもので、
/// 理論上は近似式と食い違いうる。1980〜2099 年の範囲ではこの式が
/// 公表値と一致することが知られている。
fn equinox_day(year: i32, spring: bool) -> u32 {
    let base = if spring { 20.8431 } else { 23.2488 };
    let y = year - 1980;
    (base + 0.242_194 * y as f64 - (y / 4) as f64).floor() as u32
}

/// その年の日本の祝日 (振替休日・国民の休日を含む) を日数の昇順で返す。
///
/// 2020 年以降の祝日法にもとづく。東京五輪の年 (2020・2021) にあった
/// 特例移動には対応していない。
pub fn japanese_holidays(year: i32) -> Vec<i64> {
    let d = |m: u32, day: u32| days_from_civil(year, m, day);
    const MONDAY: u32 = 1;

    // 法律で定められた祝日そのもの。
    let mut base = vec![
        d(1, 1),                          // 元日
        nth_weekday(year, 1, MONDAY, 2),  // 成人の日
        d(2, 11),                         // 建国記念の日
        d(2, 23),                         // 天皇誕生日
        d(3, equinox_day(year, true)),    // 春分の日
        d(4, 29),                         // 昭和の日
        d(5, 3),                          // 憲法記念日
        d(5, 4),                          // みどりの日
        d(5, 5),                          // こどもの日
        nth_weekday(year, 7, MONDAY, 3),  // 海の日
        d(8, 11),                         // 山の日
        nth_weekday(year, 9, MONDAY, 3),  // 敬老の日
        d(9, equinox_day(year, false)),   // 秋分の日
        nth_weekday(year, 10, MONDAY, 2), // スポーツの日
        d(11, 3),                         // 文化の日
        d(11, 23),                        // 勤労感謝の日
    ];
    base.sort_unstable();

    let is_base = |x: i64| base.binary_search(&x).is_ok();
    let mut extra = Vec::new();

    // 国民の休日: 祝日に挟まれた、祝日でない平日。
    // 実際に現れるのは 9 月のシルバーウィーク (敬老の日と秋分の日が離れた年)。
    for &h in &base {
        let middle = h + 1;
        if !is_base(middle) && is_base(middle + 1) && weekday(middle) != 0 {
            extra.push(middle);
        }
    }

    // 振替休日: 日曜と重なった祝日は、その後の最初の「祝日でない日」に移る。
    for &h in &base {
        if weekday(h) == 0 {
            let mut next = h + 1;
            while is_base(next) || extra.contains(&next) {
                next += 1;
            }
            extra.push(next);
        }
    }

    base.extend(extra);
    base.sort_unstable();
    base.dedup();
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_and_round_trip() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(weekday(0), 4, "1970-01-01 は木曜日");

        // うるう年の境目を含めて往復する。
        for day in -40_000..40_000 {
            let (y, m, d) = civil_from_days(day);
            assert_eq!(days_from_civil(y, m, d), day, "day = {day}");
            assert!((1..=12).contains(&m));
            assert!((1..=31).contains(&d));
        }
    }

    #[test]
    fn known_dates() {
        assert_eq!(days_from_civil(2000, 2, 29), 11_016, "うるう日");
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(days_from_civil(2026, 9, 20), 20_716);
        assert_eq!(civil_from_days(20_716), (2026, 9, 20));
        assert_eq!(
            weekday(days_from_civil(2026, 9, 20)),
            0,
            "2026-09-20 は日曜日"
        );
        assert_eq!(
            weekday(days_from_civil(2026, 1, 1)),
            4,
            "2026-01-01 は木曜日"
        );
    }

    #[test]
    fn century_leap_year_rules() {
        // 2000 年はうるう年、1900 年と 2100 年はそうではない。
        assert_eq!(
            days_from_civil(2000, 3, 1) - days_from_civil(2000, 2, 28),
            2
        );
        assert_eq!(
            days_from_civil(2100, 3, 1) - days_from_civil(2100, 2, 28),
            1
        );
    }

    #[test]
    fn nth_weekday_finds_the_right_day() {
        // 2026 年 1 月の第 2 月曜は 1/12。
        let d = nth_weekday(2026, 1, 1, 2);
        assert_eq!(civil_from_days(d), (2026, 1, 12));
        assert_eq!(weekday(d), 1);
    }

    #[test]
    fn equinox_matches_published_dates() {
        // 国立天文台の公表値と突き合わせる。
        for (year, spring, autumn) in [
            (2024, 20, 22),
            (2025, 20, 23),
            (2026, 20, 23),
            (2027, 21, 23),
            (2030, 20, 23),
        ] {
            assert_eq!(equinox_day(year, true), spring, "{year} 年の春分");
            assert_eq!(equinox_day(year, false), autumn, "{year} 年の秋分");
        }
    }

    fn holiday_dates(year: i32) -> Vec<(u32, u32)> {
        japanese_holidays(year)
            .into_iter()
            .map(|d| {
                let (_, m, day) = civil_from_days(d);
                (m, day)
            })
            .collect()
    }

    #[test]
    fn holidays_2026() {
        let days = holiday_dates(2026);
        // 固定日の祝日。
        for expected in [
            (1, 1),
            (2, 11),
            (2, 23),
            (3, 20),
            (4, 29),
            (5, 3),
            (5, 4),
            (5, 5),
            (8, 11),
            (9, 23),
            (11, 3),
            (11, 23),
        ] {
            assert!(
                days.contains(&expected),
                "{expected:?} が祝日に入っていない"
            );
        }
        // 2026-05-03 は日曜なので 5/6 が振替休日になる。
        assert!(days.contains(&(5, 6)), "振替休日 5/6 がない");
        // 2026 年の敬老の日は 9/21、秋分は 9/23 なので 9/22 が国民の休日。
        assert!(days.contains(&(9, 21)), "敬老の日");
        assert!(days.contains(&(9, 22)), "国民の休日 9/22 がない");
    }

    #[test]
    fn holidays_are_sorted_and_unique() {
        for year in 2020..2040 {
            let days = japanese_holidays(year);
            assert!(
                days.windows(2).all(|w| w[0] < w[1]),
                "{year} 年が昇順でない"
            );
            // 祝日は毎年 16 個 + 振替・国民の休日。
            assert!(
                (16..=21).contains(&days.len()),
                "{year} 年の祝日数 {} が想定外",
                days.len()
            );
            // すべてその年に収まっている。
            for d in days {
                assert_eq!(civil_from_days(d).0, year);
            }
        }
    }

    #[test]
    fn substitute_holiday_skips_over_consecutive_holidays() {
        // 憲法記念日 (5/3) が日曜の年は、5/4・5/5 を飛ばして 5/6 が振替になる。
        let days = holiday_dates(2026);
        assert!(days.contains(&(5, 6)));
        assert_eq!(
            days.iter().filter(|(m, _)| *m == 5).count(),
            4,
            "5 月の祝日は 3・4・5・6 の 4 日"
        );
    }
}

/// 暦の変換を**有界モデル検査**で確かめる。
///
/// テストが確かめられるのは「試した入力について正しい」ことだけで、
/// 日付の変換のように穴のあき方が分かりにくいものでは、標本の外に
/// 落とし穴が残る。ここでは日数を**記号のまま**扱い、区間のすべての値に
/// ついて成り立つことを Kani (CBMC) に証明させる。
///
/// `cargo kani` のときだけ組み立てられるので、通常のビルドには影響しない。
/// 依存クレートも増えない (`kani` は検査器が注入する)。
#[cfg(kani)]
mod verification {
    use super::*;

    /// 1970-01-01 から ±200 年ぶん。うるう年・100 年・400 年の分岐を
    /// すべてまたぐ幅を取ってある。
    const LO: i64 = -73_000;
    const HI: i64 = 73_000;

    /// 日数 → 年月日 → 日数 が恒等であること。
    ///
    /// この 2 つは別々の式で書かれていて、片方だけ間違っていても
    /// 個別の値では一致してしまうことがある。
    #[kani::proof]
    fn civil_round_trip_is_identity() {
        let day: i64 = kani::any();
        kani::assume((LO..=HI).contains(&day));

        let (y, m, d) = civil_from_days(day);
        assert!((1..=12).contains(&m), "月が 1..=12 の外");
        assert!((1..=31).contains(&d), "日が 1..=31 の外");
        assert_eq!(days_from_civil(y, m, d), day, "往復して戻らない");
    }

    /// 隣り合う日は、年月日として見ても必ず 1 日進むこと。
    ///
    /// 月末・年末・うるう日をまたぐところで境界がずれていないかを、
    /// 区間のすべての点について確かめる。
    #[kani::proof]
    fn the_next_day_is_always_one_day_later() {
        let day: i64 = kani::any();
        kani::assume((LO..HI).contains(&day));

        let (y0, m0, d0) = civil_from_days(day);
        let (y1, m1, d1) = civil_from_days(day + 1);
        let same_month = y1 == y0 && m1 == m0 && d1 == d0 + 1;
        let next_month = y1 == y0 && m1 == m0 + 1 && d1 == 1;
        let next_year = y1 == y0 + 1 && m0 == 12 && m1 == 1 && d1 == 1;
        assert!(
            same_month || next_month || next_year,
            "日付が 1 日進んでいない"
        );
    }

    /// 曜日は必ず 0..=6。**負の日数でも**。
    ///
    /// Rust の `%` は負の左辺に対して負を返すので、素朴に書くと
    /// 1970 年より前で範囲外になる。そこを補正してあることの証明。
    #[kani::proof]
    fn the_weekday_is_always_in_range() {
        // **どんな `i64` でも**。範囲の仮定を置かない。
        let day: i64 = kani::any();
        let w = weekday(day);
        assert!(w < 7, "曜日が 0..=6 の外");
        // 7 日周期であること (足して桁あふれしないところで確かめる)。
        if day < i64::MAX - 7 {
            assert_eq!(weekday(day + 7), w, "7 日周期になっていない");
        }
    }
}
