//! ABI の入口 ([`handle`]) のファジング。
//!
//! JS が渡してくるのは `f64` の並びで、型は何も守ってくれない。ここでは
//! 正しいリクエストを少しずつ壊して流し込み、次を確かめる。
//!
//! 1. panic しない (`handle` の約束。WASM では panic はアプリごと止まる)
//! 2. 応答は必ずヘッダを持ち、状態コードは既知のもの
//! 3. 失敗の応答はヘッダだけ (本体を読ませない)
//! 4. 成功の応答は、ヘッダが宣言する長さとぴったり一致する
//!    (JS はこの長さを信じて区画を切り出す)
//! 5. 成功したら、確率は `[0, 1]` に収まり、累積分布は単調
//!
//! まったくのでたらめは magic で弾かれて奥まで届かないので、
//! **正しいものを壊す** (特定の欄を NaN・無限大・負数・巨大値に替える、
//! 切り詰める、伸ばす)。回数は `MHC_FUZZ_ITERS` で増やせる。

use mhc_core::abi::{
    handle, response_offsets, Engine, Request, TaskInput, LAST_OFFSET, RESP_HEADER, VERSION,
};
use mhc_core::calendar::{CalendarConfig, CalendarEvent};
use mhc_core::member::MemberSchedule;
use mhc_core::rng::Rng;

fn iterations() -> usize {
    std::env::var("MHC_FUZZ_ITERS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(200)
}

/// 軽いリクエスト。**壊した結果が計算に進んでも重くならない**大きさにする
/// (試行回数やビン数を少なめに)。重い値は壊し方の側から入ってくる。
fn base(engine: Engine) -> Request {
    Request {
        engine,
        iterations: 2_000,
        n_bins: 16,
        grid_points: 256,
        prefix_bins: 32,
        calendar: CalendarConfig {
            start_day: 20_716,
            horizon_days: 60,
            hours_per_person_day: 8.0,
        },
        use_japanese_holidays: true,
        today_day: 20_720,
        tasks: vec![
            TaskInput::estimate_only(1.0, 2.0, 4.0),
            TaskInput {
                start_day: Some(20_716),
                progress: 0.5,
                ..TaskInput::estimate_only(3.0, 5.0, 9.0).assigned_to(1)
            },
            TaskInput {
                start_day: Some(20_716),
                progress: 1.0,
                end_day: Some(20_719),
                ..TaskInput::estimate_only(0.5, 1.0, 2.0)
            },
        ],
        members: vec![MemberSchedule::default(), MemberSchedule::default()],
        events: vec![CalendarEvent::all_day(20_725, 20_726)],
        ..Request::default()
    }
}

/// 差し込む値。境界と、型の外側。
const SPECIAL: &[f64] = &[
    f64::NAN,
    f64::INFINITY,
    f64::NEG_INFINITY,
    -1.0,
    0.0,
    0.5,
    1.0,
    2.0,
    1e300,
    -1e300,
    4_294_967_296.0,
    f64::MIN_POSITIVE,
    f64::EPSILON,
];

fn below(rng: &mut Rng, n: usize) -> usize {
    (rng.next_u64() % n as u64) as usize
}

fn mangle(rng: &mut Rng, buf: &mut Vec<f64>) {
    for _ in 0..=below(rng, 3) {
        let len = buf.len().max(1);
        match below(rng, 5) {
            // 1 つの欄を特別な値に。
            0 | 1 => {
                let at = below(rng, len);
                if let Some(slot) = buf.get_mut(at) {
                    *slot = SPECIAL[below(rng, SPECIAL.len())];
                }
            }
            // 小さな整数に (件数や添字の欄で、別の区画を指させる)。
            2 => {
                let at = below(rng, len);
                if let Some(slot) = buf.get_mut(at) {
                    *slot = below(rng, 40) as f64;
                }
            }
            3 => buf.truncate(below(rng, len)),
            _ => {
                for _ in 0..below(rng, 16) {
                    buf.push(SPECIAL[below(rng, SPECIAL.len())]);
                }
            }
        }
    }
}

/// 約束 2〜5 を確かめる。失敗したら理由を返す。
fn check(resp: &[f64]) -> Result<(), String> {
    if resp.len() < RESP_HEADER {
        return Err(format!("ヘッダより短い ({})", resp.len()));
    }
    if resp[1] != VERSION {
        return Err(format!("版が {} になっている", resp[1]));
    }
    let status = resp[0];
    if !(0.0..=8.0).contains(&status) || status.fract() != 0.0 {
        return Err(format!("知らない状態コード {status}"));
    }
    if status != 0.0 {
        return if resp.len() == RESP_HEADER {
            Ok(())
        } else {
            Err(format!("失敗なのに本体がある ({})", resp.len()))
        };
    }

    // JS の読み取り (web/src/wasm.ts) と同じ手順で長さを出す。
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
    let offsets = response_offsets(n_bins, n_pct, n_tasks, prefix_width, n_members, n_days);
    if offsets[LAST_OFFSET] != resp.len() {
        return Err(format!(
            "宣言長 {} と実際の長さ {} が違う",
            offsets[LAST_OFFSET],
            resp.len()
        ));
    }

    let probs = &resp[offsets[0]..offsets[0] + n_bins];
    if let Some(p) = probs.iter().find(|p| !(0.0..=1.0).contains(*p)) {
        return Err(format!("確率が範囲の外: {p}"));
    }
    let cdf = &resp[offsets[1]..offsets[1] + n_bins + 1];
    if cdf.iter().any(|c| !(0.0..=1.0 + 1e-9).contains(c)) {
        return Err("累積分布が [0, 1] の外".into());
    }
    if cdf.windows(2).any(|w| w[1] + 1e-12 < w[0]) {
        return Err("累積分布が単調でない".into());
    }
    Ok(())
}

#[test]
fn mangled_requests_never_panic_and_always_answer_in_shape() {
    let mut rng = Rng::new(0x00ab_1f00);
    let bases = [
        base(Engine::MonteCarlo).encode(),
        base(Engine::Convolution).encode(),
    ];
    for case in 0..iterations() {
        let mut buf = bases[case % bases.len()].clone();
        mangle(&mut rng, &mut buf);
        // 落ちたときに同じ入力を作り直せるよう、壊したものを残す。
        let resp = std::panic::catch_unwind(|| handle(&buf))
            .unwrap_or_else(|_| panic!("{case} 件目で panic した: {buf:?}"));
        if let Err(why) = check(&resp) {
            panic!("{case} 件目: {why}\n入力: {buf:?}");
        }
    }
}

/// 壊していない基準のリクエストは、どちらのエンジンでも通る。
/// (これが通らないと、上の検査はずっと「失敗の応答」しか見ていないことになる)
#[test]
fn the_unmangled_bases_succeed() {
    for engine in [Engine::MonteCarlo, Engine::Convolution] {
        let resp = handle(&base(engine).encode());
        assert_eq!(resp[0], 0.0, "{engine:?} が失敗した: {:?}", &resp[..8]);
        check(&resp).unwrap();
    }
}
