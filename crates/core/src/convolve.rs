//! 数値畳み込みによる総工数分布の計算。
//!
//! 各タスクの分布を共通の刻み幅 `h` で離散化し、確率質量関数を順に畳み込む。
//! 独立な確率変数の和の分布は各分布の畳み込みになる、という定義そのままの計算で、
//! **乱数をまったく使わない**。したがって結果は完全に決定論的で、サンプリング誤差も
//! 存在しない。モンテカルロ側の実装が正しいかを測るオラクルとして使える。
//!
//! 離散化はビンの端点における CDF の差で行う。こうすると各ビンの確率は
//! 定義から非負になり、総和は `F(max) - F(min) = 1` にぴったり一致する
//! (途中の項が打ち消し合うため)。
//!
//! # 制約
//!
//! タスク同士の**独立性を仮定**している。相関を入れる場合はモンテカルロを使う。

use crate::dist::Sampler;
use crate::empirical::EmpiricalDist;

/// 2 つの確率質量関数を畳み込む。
fn convolve_pmf(a: &[f64], b: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; a.len() + b.len() - 1];
    for (i, &ai) in a.iter().enumerate() {
        if ai == 0.0 {
            continue;
        }
        for (j, &bj) in b.iter().enumerate() {
            out[i + j] += ai * bj;
        }
    }
    out
}

/// 畳み込みで総工数の分布を求める。
///
/// `grid_points` は全体レンジ `[Σmin, Σmax]` の分割数。大きいほど精度が上がるが、
/// 計算量は `O(grid_points^2)` に近づく。
pub fn convolve(samplers: &[Sampler], grid_points: usize) -> EmpiricalDist {
    let lo: f64 = samplers.iter().map(|s| s.estimate().min()).sum();
    let hi: f64 = samplers.iter().map(|s| s.estimate().max()).sum();

    // 全タスクが確定値なら分布は 1 点に潰れる。
    let span = hi - lo;
    if span.is_nan() || span <= 0.0 {
        return EmpiricalDist::point_mass(lo);
    }

    let grid_points = grid_points.max(1);
    let h = span / grid_points as f64;

    // 幅を持つタスクだけを畳み込む。確定値のタスクの工数は `lo` に含まれている。
    let mut acc = vec![1.0f64];
    let mut spread_tasks = 0usize;
    for s in samplers {
        let e = s.estimate();
        if e.is_degenerate() {
            continue;
        }
        spread_tasks += 1;

        // ビン数は幅を刻み幅で割った切り上げ。最後の端点は必ず max 以上になるので、
        // 差分の総和はちょうど 1 になる。
        let bins = ((e.width() / h).ceil() as usize).max(1);
        let mut pmf = Vec::with_capacity(bins);
        let mut prev = 0.0;
        for j in 1..=bins {
            let edge = e.min() + j as f64 * h;
            let c = s.cdf(edge);
            pmf.push((c - prev).max(0.0));
            prev = c;
        }
        acc = convolve_pmf(&acc, &pmf);
    }

    // 各タスクのビン j は区間 [min + j*h, min + (j+1)*h] を代表するので、
    // 代表値には中点 min + (j+0.5)*h を使う。合計するとタスク 1 つにつき
    // h/2 のオフセットが乗るため、グリッド全体を spread_tasks * h/2 ずらす。
    let offset = lo + 0.5 * spread_tasks as f64 * h;
    let values: Vec<f64> = (0..acc.len()).map(|k| offset + k as f64 * h).collect();

    let total: f64 = acc.iter().sum();
    let scale = if total > 0.0 { 1.0 / total } else { 0.0 };
    let mean: f64 = values.iter().zip(&acc).map(|(&v, &p)| v * p * scale).sum();
    let variance: f64 = values
        .iter()
        .zip(&acc)
        .map(|(&v, &p)| (v - mean) * (v - mean) * p * scale)
        .sum();

    EmpiricalDist::from_grid(values, &acc, mean, variance.max(0.0).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dist::{DistKind, DEFAULT_LAMBDA};
    use crate::estimate::TaskEstimate;
    use crate::montecarlo;

    fn samplers(rows: &[(f64, f64, f64)], kind: DistKind) -> Vec<Sampler> {
        rows.iter()
            .map(|&(a, m, b)| {
                Sampler::new(TaskEstimate::new(a, m, b).unwrap(), kind, DEFAULT_LAMBDA)
            })
            .collect()
    }

    #[test]
    fn support_stays_within_the_sum_of_the_estimate_ranges() {
        let rows = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];
        let lo: f64 = rows.iter().map(|r| r.0).sum();
        let hi: f64 = rows.iter().map(|r| r.2).sum();
        for kind in [DistKind::Pert, DistKind::Triangular] {
            let d = convolve(&samplers(&rows, kind), 2048);
            // 中点表現のぶん半ビンだけはみ出しうるので、その余裕を見込む。
            let slack = (hi - lo) / 2048.0 * rows.len() as f64;
            assert!(d.min() >= lo - slack, "{kind:?}: 最小 {}", d.min());
            assert!(d.max() <= hi + slack, "{kind:?}: 最大 {}", d.max());
        }
    }

    #[test]
    fn mean_matches_the_sum_of_the_task_means() {
        let rows = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];
        for kind in [DistKind::Pert, DistKind::Triangular] {
            let ss = samplers(&rows, kind);
            let analytic: f64 = ss.iter().map(|s| s.mean()).sum();
            let d = convolve(&ss, 2048);
            assert!(
                (d.mean() - analytic).abs() < 0.05,
                "{kind:?}: 畳み込みの平均 {} vs 解析平均 {analytic}",
                d.mean()
            );
        }
    }

    #[test]
    fn sd_matches_the_root_sum_of_squares() {
        let rows = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];
        let ss = samplers(&rows, DistKind::Pert);
        let analytic: f64 = ss.iter().map(|s| s.variance()).sum::<f64>().sqrt();
        let d = convolve(&ss, 2048);
        assert!(
            (d.sd() - analytic).abs() / analytic < 0.01,
            "畳み込みの SD {} vs 解析 SD {analytic}",
            d.sd()
        );
    }

    #[test]
    fn it_is_fully_deterministic() {
        let ss = samplers(&[(1.0, 4.0, 9.0), (2.0, 2.5, 8.0)], DistKind::Pert);
        let a = convolve(&ss, 1024);
        let b = convolve(&ss, 1024);
        for p in [0.1, 0.5, 0.8, 0.95] {
            assert_eq!(a.quantile(p), b.quantile(p));
        }
    }

    /// 2 つのエンジンが互いのオラクルになる、という中心的な検査。
    /// 片方だけにあるバグはここで必ず露見する。
    #[test]
    fn both_engines_agree_on_the_percentiles() {
        let cases: [&[(f64, f64, f64)]; 4] = [
            &[(5.0, 8.0, 20.0)],
            &[(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)],
            &[(1.0, 1.0, 2.0), (0.5, 3.0, 3.0), (2.0, 2.0, 2.0)],
            &[
                (3.0, 5.0, 8.0),
                (1.0, 2.0, 10.0),
                (4.0, 4.5, 5.0),
                (0.0, 1.0, 6.0),
                (7.0, 9.0, 12.0),
            ],
        ];
        for kind in [DistKind::Pert, DistKind::Triangular] {
            for rows in cases {
                let ss = samplers(rows, kind);
                let mc = montecarlo::simulate(&ss, 400_000, 20_250_920);
                let cv = convolve(&ss, 4096);
                let span: f64 = rows.iter().map(|r| r.2 - r.0).sum();
                let tol = (span * 0.01).max(1e-6);
                for p in [0.10, 0.25, 0.50, 0.75, 0.80, 0.90, 0.95] {
                    let (a, b) = (mc.quantile(p), cv.quantile(p));
                    assert!(
                        (a - b).abs() <= tol,
                        "{kind:?} {rows:?}: P{:.0} が一致しない (MC {a}, 畳み込み {b}, 許容 {tol})",
                        p * 100.0
                    );
                }
                assert!(
                    (mc.mean() - cv.mean()).abs() <= tol,
                    "{kind:?}: 平均が一致しない"
                );
            }
        }
    }

    #[test]
    fn fixed_tasks_produce_a_point_mass() {
        let ss = samplers(&[(3.0, 3.0, 3.0), (4.0, 4.0, 4.0)], DistKind::Pert);
        let d = convolve(&ss, 1024);
        assert_eq!(d.min(), 7.0);
        assert_eq!(d.max(), 7.0);
    }

    #[test]
    fn mixing_fixed_and_uncertain_tasks_shifts_the_distribution() {
        let uncertain = samplers(&[(0.0, 5.0, 10.0)], DistKind::Pert);
        let mixed = samplers(&[(0.0, 5.0, 10.0), (4.0, 4.0, 4.0)], DistKind::Pert);
        let a = convolve(&uncertain, 2048);
        let b = convolve(&mixed, 2048);
        assert!(
            (b.mean() - a.mean() - 4.0).abs() < 0.05,
            "確定タスクぶんだけ平行移動するはず"
        );
        assert!(
            (b.sd() - a.sd()).abs() < 0.05,
            "確定タスクはばらつきを増やさない"
        );
    }
}
