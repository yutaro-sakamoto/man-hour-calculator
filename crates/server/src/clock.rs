//! 時刻を文字列にする。
//!
//! これだけのために日付のクレートを 1 つ増やすほどのことはない。
//! 必要なのは「いまを RFC 3339 で」だけで、閏秒も時間帯も扱わない
//! (`crates/api` が受け取るのは UTC の文字列だけ)。
//!
//! 曆の計算は `crates/core` の `date.rs` と同じ Howard Hinnant の手順。

use std::time::{SystemTime, UNIX_EPOCH};

/// 1970-01-01 からの日数を年月日に戻す。
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // 0..=146096
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// UNIX 秒を `2026-09-20T10:00:00Z` の形にする。
pub fn rfc3339(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (rest / 3600, (rest % 3600) / 60, rest % 60);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// いま。時計が 1970 より前を指していたら、そこを底にする。
pub fn now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    rfc3339(seconds)
}

/// `2026-09-20T10:00:00Z` → `2026-09-20`。
pub fn day_of(now: &str) -> &str {
    now.get(..10).unwrap_or(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_moments_come_out_right() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_000_000_000), "2001-09-09T01:46:40Z");
        // 閏年の 2 月 29 日をまたぐところ。
        assert_eq!(rfc3339(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_789_905_600), "2026-09-20T12:00:00Z");
    }

    #[test]
    fn the_day_is_the_first_ten_characters() {
        assert_eq!(day_of("2026-09-20T10:00:00Z"), "2026-09-20");
        assert_eq!(day_of("短い"), "短い");
    }

    #[test]
    fn now_is_shaped_like_a_timestamp() {
        let text = now();
        assert_eq!(text.len(), 20, "{text}");
        assert!(text.ends_with('Z'), "{text}");
        assert!(text.starts_with("20"), "{text}");
    }

    /// `crates/api` の日付の読み取りと突き合わせる。
    #[test]
    fn the_day_agrees_with_the_api_side() {
        for seconds in [0_i64, 1_000_000_000, 1_789_905_600] {
            let text = rfc3339(seconds);
            assert_eq!(
                mhc_api::health::day_of(day_of(&text)),
                Some(seconds.div_euclid(86_400)),
                "{text}"
            );
        }
    }
}
