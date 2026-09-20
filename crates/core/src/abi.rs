//! JavaScript と WASM の間でやり取りするバッファの読み書き。
//!
//! リクエストもレスポンスも **要素がすべて `f64` の平坦な配列**で表す。
//! 整数もフラグも `f64` に載せる。こうしておくと JS 側は
//! `new Float64Array(memory.buffer, ptr, len)` ひとつで読み書きでき、
//! 型混在によるオフセットずれやアラインメント違反が構造的に起きない。
//!
//! レイアウトの詳細は `docs/ABI.md` を参照。

use crate::convolve;
use crate::dist::{DistKind, Sampler, DEFAULT_LAMBDA};
use crate::estimate::TaskEstimate;
use crate::montecarlo;
use crate::stats::{self, PCT_LEVELS};

/// リクエストが正しいバッファであることを確認するための印。
pub const MAGIC: f64 = 20_250_920.0;
/// ABI のバージョン。レイアウトを変えたら上げる。
pub const VERSION: f64 = 1.0;

/// リクエストのヘッダ長 (f64 の個数)。
pub const REQ_HEADER: usize = 12;
/// レスポンスのヘッダ長 (f64 の個数)。
pub const RESP_HEADER: usize = 13;

pub const MAX_TASKS: usize = 500;
pub const MAX_ITERATIONS: usize = 2_000_000;
pub const MIN_BINS: usize = 4;
pub const MAX_BINS: usize = 512;
pub const MIN_GRID: usize = 16;
pub const MAX_GRID: usize = 16_384;
/// モンテカルロの総サンプリング回数 (試行回数 × タスク数) の上限。
/// ブラウザの UI スレッドを何十秒も止めないための歯止め。
pub const MAX_WORK: usize = 50_000_000;

/// レスポンスの `status` に入る値。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Status {
    Ok = 0,
    /// バッファが短すぎる、または magic / version が合わない。
    BadHeader = 1,
    /// タスク数が 0、上限超え、またはバッファ長と矛盾している。
    BadTaskCount = 2,
    /// 試行回数・ビン数・グリッド数が範囲外、または計算量が大きすぎる。
    BadParams = 3,
    /// `min <= likely <= max` を満たさないタスクがある (`detail` に添字)。
    InvalidEstimate = 4,
    /// エンジンの指定が不正。
    UnknownEngine = 5,
    /// 相関つきの計算は畳み込みエンジンでは扱えない。
    CorrelationUnsupported = 6,
}

/// 計算エンジンの種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    MonteCarlo,
    Convolution,
}

impl Engine {
    fn from_code(code: f64) -> Option<Self> {
        match code as i64 {
            0 => Some(Self::MonteCarlo),
            1 => Some(Self::Convolution),
            _ => None,
        }
    }
}

/// `f64` を添字などの `usize` に落とす。負数・NaN・巨大値は `None`。
fn as_index(v: f64) -> Option<usize> {
    if !v.is_finite() || v < 0.0 || v > usize::MAX as f64 {
        return None;
    }
    Some(v as usize)
}

/// エラーだけを載せたレスポンスを作る。
///
/// `n_bins` などはすべて 0 にするので、JS 側はヘッダだけ読めばよく、
/// 本体を読みにいって範囲外アクセスすることがない。
fn error_response(status: Status, detail: f64) -> Vec<f64> {
    let mut out = vec![0.0; RESP_HEADER];
    out[0] = status as u8 as f64;
    out[1] = VERSION;
    out[5] = detail;
    out
}

/// リクエストバッファを処理してレスポンスバッファを返す。
///
/// この関数は決して panic しない。入力の不正はすべて `status` で返す。
pub fn handle(req: &[f64]) -> Vec<f64> {
    if req.len() < REQ_HEADER || req[0] != MAGIC || req[1] != VERSION {
        return error_response(Status::BadHeader, 0.0);
    }

    let Some(engine) = Engine::from_code(req[2]) else {
        return error_response(Status::UnknownEngine, req[2]);
    };
    let kind = DistKind::from_code(req[3]).unwrap_or(DistKind::Pert);
    let lambda = if req[4].is_finite() {
        req[4]
    } else {
        DEFAULT_LAMBDA
    };

    let Some(n_tasks) = as_index(req[5]) else {
        return error_response(Status::BadTaskCount, req[5]);
    };
    if n_tasks == 0 || n_tasks > MAX_TASKS || req.len() < REQ_HEADER + n_tasks * 3 {
        return error_response(Status::BadTaskCount, n_tasks as f64);
    }

    let (Some(iterations), Some(n_bins), Some(grid_points)) =
        (as_index(req[6]), as_index(req[8]), as_index(req[9]))
    else {
        return error_response(Status::BadParams, 0.0);
    };
    if !(1..=MAX_ITERATIONS).contains(&iterations)
        || !(MIN_BINS..=MAX_BINS).contains(&n_bins)
        || !(MIN_GRID..=MAX_GRID).contains(&grid_points)
    {
        return error_response(Status::BadParams, 0.0);
    }
    if engine == Engine::MonteCarlo && iterations.saturating_mul(n_tasks) > MAX_WORK {
        return error_response(Status::BadParams, 0.0);
    }

    let seed = if req[7].is_finite() && req[7] >= 0.0 {
        req[7] as u64
    } else {
        0
    };

    // 相関は M2 で実装する。ABI には場所を確保してあるので、
    // 0 以外が来たらまだ扱えないことを明示的に返す。
    let correlation = req[10];
    if correlation.is_finite() && correlation != 0.0 {
        return error_response(Status::CorrelationUnsupported, correlation);
    }

    let mut estimates = Vec::with_capacity(n_tasks);
    for i in 0..n_tasks {
        let base = REQ_HEADER + i * 3;
        match TaskEstimate::new(req[base], req[base + 1], req[base + 2]) {
            Ok(e) => estimates.push(e),
            Err(_) => return error_response(Status::InvalidEstimate, i as f64),
        }
    }

    let total_min: f64 = estimates.iter().map(|e| e.min()).sum();
    let total_likely: f64 = estimates.iter().map(|e| e.likely()).sum();
    let total_max: f64 = estimates.iter().map(|e| e.max()).sum();

    let samplers: Vec<Sampler> = estimates
        .iter()
        .map(|&e| Sampler::new(e, kind, lambda))
        .collect();

    let dist = match engine {
        Engine::MonteCarlo => montecarlo::simulate(&samplers, iterations, seed),
        Engine::Convolution => convolve::convolve(&samplers, grid_points),
    };
    let summary = stats::summarize(&dist, n_bins);

    // 感度 = そのタスクの分散が総分散に占める割合。タスクは独立なので
    // 分散は単純に足し合わせでき、この比がそのまま「総工数のばらつきへの寄与」になる。
    let total_variance: f64 = samplers.iter().map(|s| s.variance()).sum();
    let sensitivity: Vec<f64> = samplers
        .iter()
        .map(|s| {
            if total_variance > 0.0 {
                s.variance() / total_variance
            } else {
                0.0
            }
        })
        .collect();

    let n_pct = PCT_LEVELS.len();
    let mut out = Vec::with_capacity(RESP_HEADER + n_bins + (n_bins + 1) + n_pct * 2 + n_tasks);
    out.extend_from_slice(&[
        Status::Ok as u8 as f64,
        VERSION,
        n_bins as f64,
        n_pct as f64,
        n_tasks as f64,
        0.0, // detail
        summary.mean,
        summary.sd,
        summary.lo,
        summary.hi,
        total_min,
        total_likely,
        total_max,
    ]);
    debug_assert_eq!(out.len(), RESP_HEADER);
    out.extend_from_slice(&summary.probs);
    out.extend_from_slice(&summary.cdf);
    out.extend_from_slice(&PCT_LEVELS);
    out.extend_from_slice(&summary.percentiles);
    out.extend_from_slice(&sensitivity);
    out
}

/// リクエストヘッダに載せる設定値。
///
/// JS 側の `buildRequest()` と 1 対 1 に対応する。両者がずれると計算結果が
/// 黙って変わってしまうので、テストはこの型を通して JS と同じ並びを作る。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RequestParams {
    pub engine: Engine,
    pub kind: DistKind,
    pub lambda: f64,
    pub iterations: usize,
    pub seed: u64,
    pub n_bins: usize,
    pub grid_points: usize,
    pub correlation: f64,
}

impl Default for RequestParams {
    fn default() -> Self {
        Self {
            engine: Engine::MonteCarlo,
            kind: DistKind::Pert,
            lambda: DEFAULT_LAMBDA,
            iterations: 100_000,
            seed: 20_250_920,
            n_bins: 48,
            grid_points: 2048,
            correlation: 0.0,
        }
    }
}

/// テストと JS 側の実装を照らし合わせるためのリクエスト組み立てヘルパ。
pub fn build_request(params: RequestParams, tasks: &[(f64, f64, f64)]) -> Vec<f64> {
    let mut req = vec![
        MAGIC,
        VERSION,
        match params.engine {
            Engine::MonteCarlo => 0.0,
            Engine::Convolution => 1.0,
        },
        match params.kind {
            DistKind::Pert => 0.0,
            DistKind::Triangular => 1.0,
        },
        params.lambda,
        tasks.len() as f64,
        params.iterations as f64,
        params.seed as f64,
        params.n_bins as f64,
        params.grid_points as f64,
        params.correlation,
        0.0,
    ];
    debug_assert_eq!(req.len(), REQ_HEADER);
    for &(a, m, b) in tasks {
        req.extend_from_slice(&[a, m, b]);
    }
    req
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASKS: [(f64, f64, f64); 3] = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];

    fn ok_request(engine: Engine) -> Vec<f64> {
        build_request(
            RequestParams {
                engine,
                iterations: 50_000,
                n_bins: 40,
                ..RequestParams::default()
            },
            &TASKS,
        )
    }

    /// レスポンスをヘッダの宣言どおりに読み切れること。JS 側が範囲外を
    /// 読まないための、いちばん大事な不変条件。
    fn assert_layout_is_consistent(resp: &[f64]) {
        let n_bins = resp[2] as usize;
        let n_pct = resp[3] as usize;
        let n_tasks = resp[4] as usize;
        let expected = RESP_HEADER + n_bins + (n_bins + 1) + n_pct * 2 + n_tasks;
        assert_eq!(resp.len(), expected, "宣言長とバッファ長が一致しない");
    }

    #[test]
    fn a_valid_request_succeeds_on_both_engines() {
        for engine in [Engine::MonteCarlo, Engine::Convolution] {
            let resp = handle(&ok_request(engine));
            assert_eq!(resp[0], Status::Ok as u8 as f64, "{engine:?}");
            assert_layout_is_consistent(&resp);
            assert_eq!(resp[2], 40.0);
            assert_eq!(resp[4], 3.0);
            // 合計値はそのまま返ってくる。
            assert_eq!(resp[10], 17.0);
            assert_eq!(resp[11], 26.0);
            assert_eq!(resp[12], 65.0);
        }
    }

    #[test]
    fn response_body_is_well_formed() {
        let resp = handle(&ok_request(Engine::MonteCarlo));
        let n_bins = resp[2] as usize;
        let n_pct = resp[3] as usize;
        let probs = &resp[RESP_HEADER..RESP_HEADER + n_bins];
        let cdf = &resp[RESP_HEADER + n_bins..RESP_HEADER + n_bins * 2 + 1];
        let levels_at = RESP_HEADER + n_bins * 2 + 1;
        let levels = &resp[levels_at..levels_at + n_pct];
        let values = &resp[levels_at + n_pct..levels_at + n_pct * 2];
        let sens = &resp[levels_at + n_pct * 2..];

        assert!(probs.iter().all(|&p| p >= 0.0));
        assert!(cdf.windows(2).all(|w| w[1] >= w[0]));
        assert_eq!(levels, &PCT_LEVELS);
        assert!(values.windows(2).all(|w| w[1] >= w[0]));
        assert_eq!(sens.len(), 3);
        assert!(
            (sens.iter().sum::<f64>() - 1.0).abs() < 1e-9,
            "感度の合計は 1"
        );
    }

    #[test]
    fn p80_beats_the_sum_of_the_most_likely_estimates() {
        for engine in [Engine::MonteCarlo, Engine::Convolution] {
            let resp = handle(&ok_request(engine));
            let n_bins = resp[2] as usize;
            let n_pct = resp[3] as usize;
            let values_at = RESP_HEADER + n_bins * 2 + 1 + n_pct;
            let p80 = resp[values_at + 4]; // PCT_LEVELS[4] == 0.80
            assert!(
                p80 > resp[11],
                "{engine:?}: P80 {p80} <= Σlikely {}",
                resp[11]
            );
        }
    }

    #[test]
    fn short_or_corrupt_headers_are_rejected() {
        assert_eq!(handle(&[])[0], Status::BadHeader as u8 as f64);
        assert_eq!(handle(&[1.0, 2.0, 3.0])[0], Status::BadHeader as u8 as f64);

        let mut req = ok_request(Engine::MonteCarlo);
        req[0] = 1.0;
        assert_eq!(handle(&req)[0], Status::BadHeader as u8 as f64);

        let mut req = ok_request(Engine::MonteCarlo);
        req[1] = 99.0;
        assert_eq!(handle(&req)[0], Status::BadHeader as u8 as f64);
    }

    #[test]
    fn task_count_must_match_the_buffer() {
        let mut req = ok_request(Engine::MonteCarlo);
        req[5] = 99.0; // バッファにはタスクが 3 つしかない
        assert_eq!(handle(&req)[0], Status::BadTaskCount as u8 as f64);

        let mut req = ok_request(Engine::MonteCarlo);
        req[5] = 0.0;
        assert_eq!(handle(&req)[0], Status::BadTaskCount as u8 as f64);

        let mut req = ok_request(Engine::MonteCarlo);
        req[5] = -1.0;
        assert_eq!(handle(&req)[0], Status::BadTaskCount as u8 as f64);

        let mut req = ok_request(Engine::MonteCarlo);
        req[5] = f64::NAN;
        assert_eq!(handle(&req)[0], Status::BadTaskCount as u8 as f64);
    }

    #[test]
    fn out_of_range_parameters_are_rejected() {
        for (idx, value) in [
            (6, 0.0), // 試行回数 0
            (6, (MAX_ITERATIONS + 1) as f64),
            (8, 1.0), // ビン数が少なすぎる
            (8, (MAX_BINS + 1) as f64),
            (9, 1.0), // グリッドが粗すぎる
            (9, (MAX_GRID + 1) as f64),
            (6, f64::NAN),
        ] {
            let mut req = ok_request(Engine::MonteCarlo);
            req[idx] = value;
            assert_eq!(
                handle(&req)[0],
                Status::BadParams as u8 as f64,
                "req[{idx}] = {value} が弾かれていない"
            );
        }
    }

    #[test]
    fn excessive_work_is_refused_instead_of_freezing_the_browser() {
        let tasks = vec![(1.0, 2.0, 3.0); 100];
        let req = build_request(
            RequestParams {
                iterations: MAX_ITERATIONS,
                n_bins: 40,
                ..RequestParams::default()
            },
            &tasks,
        );
        assert_eq!(handle(&req)[0], Status::BadParams as u8 as f64);
    }

    #[test]
    fn invalid_estimates_report_the_offending_task() {
        let tasks = [(5.0, 8.0, 20.0), (9.0, 3.0, 5.0)];
        let req = build_request(
            RequestParams {
                iterations: 1_000,
                n_bins: 40,
                ..RequestParams::default()
            },
            &tasks,
        );
        let resp = handle(&req);
        assert_eq!(resp[0], Status::InvalidEstimate as u8 as f64);
        assert_eq!(resp[5], 1.0, "2 番目のタスクが不正なはず");
    }

    #[test]
    fn unknown_engine_is_reported() {
        let mut req = ok_request(Engine::MonteCarlo);
        req[2] = 7.0;
        assert_eq!(handle(&req)[0], Status::UnknownEngine as u8 as f64);
    }

    #[test]
    fn correlation_is_not_supported_yet() {
        let mut req = ok_request(Engine::MonteCarlo);
        req[10] = 0.5;
        assert_eq!(handle(&req)[0], Status::CorrelationUnsupported as u8 as f64);
    }

    #[test]
    fn error_responses_carry_no_body() {
        let resp = handle(&[]);
        assert_eq!(resp.len(), RESP_HEADER);
        assert_eq!(resp[2], 0.0, "n_bins は 0");
        assert_eq!(resp[4], 0.0, "n_tasks は 0");
    }

    #[test]
    fn an_unknown_distribution_code_falls_back_to_pert() {
        let mut req = ok_request(Engine::Convolution);
        req[3] = 42.0;
        let fallback = handle(&req);
        req[3] = 0.0;
        let pert = handle(&req);
        assert_eq!(fallback[0], Status::Ok as u8 as f64);
        assert_eq!(fallback[6], pert[6], "平均が PERT と一致するはず");
    }

    #[test]
    fn the_response_layout_holds_for_every_bin_count() {
        for n_bins in [MIN_BINS, 17, 64, MAX_BINS] {
            let req = build_request(
                RequestParams {
                    engine: Engine::Convolution,
                    kind: DistKind::Triangular,
                    iterations: 1_000,
                    n_bins,
                    grid_points: 1024,
                    ..RequestParams::default()
                },
                &TASKS,
            );
            let resp = handle(&req);
            assert_eq!(resp[0], Status::Ok as u8 as f64);
            assert_layout_is_consistent(&resp);
        }
    }
}
