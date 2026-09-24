//! 計算結果のゴールデンテスト。
//!
//! 「同じ種なら、環境や版をまたいでも同じ結果」(`rng.rs`) を約束している。
//! 見積もりの数字が版を上げるたびに黙って動くと、議論の土台にならない。
//! 固定のリクエストを流し、応答の数字を `tests/fixtures/compute.expected.txt`
//! と突き合わせる。
//!
//! **わざと**結果を変えたとき (分布の直し・既定値の変更) は書き直す:
//!
//! ```sh
//! MHC_UPDATE_GOLDEN=1 cargo test -p mhc-core --test golden_compute
//! ```
//!
//! 差分は必ずレビューで目で見る。数字が動いた理由を説明できないなら、
//! それは不具合。

use std::fmt::Write;
use std::path::Path;

use mhc_core::abi::{handle, response_offsets, Engine, Request, TaskInput, RESP_HEADER};
use mhc_core::calendar::{CalendarConfig, CalendarEvent};
use mhc_core::member::MemberSchedule;

/// 実際の使い方に近いリクエスト。実績・担当・予定・祝日をひととおり含める。
fn request(engine: Engine) -> Request {
    // 2026-09-21 (月)。
    let monday = 20_717;
    Request {
        engine,
        iterations: 20_000,
        n_bins: 24,
        grid_points: 512,
        prefix_bins: 32,
        calendar: CalendarConfig {
            start_day: monday,
            horizon_days: 120,
            hours_per_person_day: 8.0,
        },
        use_japanese_holidays: true,
        today_day: monday + 3,
        tasks: vec![
            TaskInput {
                start_day: Some(monday),
                progress: 1.0,
                end_day: Some(monday + 2),
                ..TaskInput::estimate_only(2.0, 3.0, 5.0)
            },
            TaskInput {
                start_day: Some(monday + 2),
                progress: 0.4,
                ..TaskInput::estimate_only(3.0, 5.0, 10.0).assigned_to(1)
            },
            TaskInput::estimate_only(1.0, 2.0, 6.0),
            TaskInput::estimate_only(4.0, 6.0, 12.0).assigned_to(1),
            TaskInput::estimate_only(0.5, 1.0, 1.5),
        ],
        members: vec![MemberSchedule::default(), MemberSchedule::default()],
        events: vec![CalendarEvent::all_day(monday + 10, monday + 11)],
        ..Request::default()
    }
}

/// 応答から、見ている値を行にする。有効数字 12 桁 (浮動小数の末尾の揺れは
/// 比較のほうで許す)。
fn summarize(engine: Engine) -> String {
    let resp = handle(&request(engine).encode());
    assert_eq!(resp[0], 0.0, "{engine:?} が失敗した");
    let n_bins = resp[2] as usize;
    let n_pct = resp[3] as usize;
    let n_tasks = resp[4] as usize;
    let prefix_width = if resp[13] > 0.0 {
        resp[13] as usize + 1
    } else {
        0
    };
    let n_days = resp[14] as usize;
    let n_members = resp[17] as usize;
    let at = response_offsets(n_bins, n_pct, n_tasks, prefix_width, n_members, n_days);

    let mut out = String::new();
    let mut line = |name: &str, values: &[f64]| {
        let text: Vec<String> = values.iter().map(|v| format!("{v:.12e}")).collect();
        writeln!(out, "{engine:?} {name} {}", text.join(" ")).unwrap();
    };
    line("header", &resp[..RESP_HEADER]);
    line("percentiles", &resp[at[3]..at[3] + n_pct]);
    line("probs", &resp[at[0]..at[0] + n_bins]);
    line("sensitivity", &resp[at[4]..at[4] + n_tasks]);
    line("effective", &resp[at[5]..at[5] + n_tasks * 3]);
    line("spent", &resp[at[6]..at[6] + n_tasks]);
    line("capacity", &resp[at[11]..at[11] + n_members * n_days]);
    out
}

/// 行ごとに、相対 1e-9 まで同じなら同じとみなす。libm の最後の 1 ビットの
/// 違い (OS や版の違い) で落ちないようにするため。それより大きい差は不具合。
fn close(expected: &str, actual: &str) -> Result<(), String> {
    let (e_lines, a_lines): (Vec<_>, Vec<_>) =
        (expected.lines().collect(), actual.lines().collect());
    if e_lines.len() != a_lines.len() {
        return Err(format!(
            "行の数が違う ({} と {})",
            e_lines.len(),
            a_lines.len()
        ));
    }
    for (e, a) in e_lines.iter().zip(&a_lines) {
        let (ew, aw): (Vec<_>, Vec<_>) = (e.split(' ').collect(), a.split(' ').collect());
        if ew.len() != aw.len() || ew[..2] != aw[..2] {
            return Err(format!("行の形が違う:\n  期待 {e}\n  実際 {a}"));
        }
        for (x, y) in ew[2..].iter().zip(&aw[2..]) {
            let (x, y): (f64, f64) = (x.parse().unwrap(), y.parse().unwrap());
            let same = (x.is_nan() && y.is_nan())
                || x == y
                || (x - y).abs() <= 1e-9 * x.abs().max(y.abs());
            if !same {
                return Err(format!("{} {}: {x} が {y} になった", ew[0], ew[1]));
            }
        }
    }
    Ok(())
}

#[test]
fn a_fixed_request_gives_the_same_numbers_as_before() {
    let actual = summarize(Engine::MonteCarlo) + &summarize(Engine::Convolution);
    let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/compute.expected.txt");
    if std::env::var_os("MHC_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(golden.parent().unwrap()).unwrap();
        std::fs::write(&golden, &actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&golden)
        .expect("ゴールデンが無い。MHC_UPDATE_GOLDEN=1 で作って中身を確かめる");
    if let Err(why) = close(&expected, &actual) {
        panic!("計算結果が変わった: {why}\n(わざとなら MHC_UPDATE_GOLDEN=1 で書き直す)");
    }
}

/// 同じリクエストを 2 回流すと、ビット単位で同じ (種が効いている)。
#[test]
fn the_same_request_twice_is_bit_identical() {
    for engine in [Engine::MonteCarlo, Engine::Convolution] {
        let a = handle(&request(engine).encode());
        let b = handle(&request(engine).encode());
        assert!(
            a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()),
            "{engine:?}"
        );
    }
}
