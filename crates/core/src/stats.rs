//! 分布を画面に出せる形 (ヒストグラム・CDF・分位点) にまとめる。

use crate::empirical::EmpiricalDist;

/// 画面に出す分位点の水準。
pub const PCT_LEVELS: [f64; 7] = [0.10, 0.25, 0.50, 0.75, 0.80, 0.90, 0.95];

/// ヒストグラムの表示下限に使う分位点。
///
/// 理論上の下限 `Σmin` / 上限 `Σmax` をそのまま使うと、タスクが増えるほど
/// 両端の確率が無視できるほど小さくなり、グラフの中央に細い山が残るだけになる。
/// 両側 0.1% を切り落として、意味のある範囲だけを描く。
pub const DISPLAY_LO_Q: f64 = 0.001;
/// 画面に出す範囲の上側分位点。
pub const DISPLAY_HI_Q: f64 = 0.999;

/// 表示用にまとめた分布。
#[derive(Debug, Clone)]
pub struct Summary {
    /// ヒストグラムの下限。
    pub lo: f64,
    /// ヒストグラムの上限。
    pub hi: f64,
    /// 各ビンの確率。`lo`/`hi` の外側を切り落としているため総和は 1 よりわずかに小さい。
    pub probs: Vec<f64>,
    /// ビン境界における累積確率 (長さは `probs.len() + 1`)。
    pub cdf: Vec<f64>,
    pub mean: f64,
    pub sd: f64,
    /// [`PCT_LEVELS`] に対応する分位点の値。
    pub percentiles: Vec<f64>,
}

/// 分布をヒストグラムと分位点にまとめる。
///
/// 両エンジンがまったく同じこの関数を通るので、エンジンを切り替えても
/// グラフの軸の取り方は変わらず、素直に見比べられる。
pub fn summarize(dist: &EmpiricalDist, n_bins: usize) -> Summary {
    let mut lo = dist.quantile(DISPLAY_LO_Q);
    let mut hi = dist.quantile(DISPLAY_HI_Q);

    let span = hi - lo;
    if span.is_nan() || span <= 0.0 {
        // 分布が 1 点に潰れている場合。グラフが描けるように最小限の幅を与える。
        let center = dist.quantile(0.5);
        let pad = if center.abs() > 0.0 {
            center.abs() * 0.05
        } else {
            0.5
        };
        lo = center - pad;
        hi = center + pad;
    }

    let n_bins = n_bins.max(1);
    let step = (hi - lo) / n_bins as f64;

    let cdf: Vec<f64> = (0..=n_bins)
        .map(|i| dist.cdf_at(lo + i as f64 * step))
        .collect();
    // CDF の差分なので、各ビンの確率は定義から非負になる。
    let probs: Vec<f64> = (0..n_bins)
        .map(|i| (cdf[i + 1] - cdf[i]).max(0.0))
        .collect();
    let percentiles = PCT_LEVELS.iter().map(|&p| dist.quantile(p)).collect();

    Summary {
        lo,
        hi,
        probs,
        cdf,
        mean: dist.mean(),
        sd: dist.sd(),
        percentiles,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dist::{DistKind, Sampler, DEFAULT_LAMBDA};
    use crate::estimate::TaskEstimate;
    use crate::{convolve, montecarlo};

    fn samplers(rows: &[(f64, f64, f64)]) -> Vec<Sampler> {
        rows.iter()
            .map(|&(a, m, b)| {
                Sampler::new(
                    TaskEstimate::new(a, m, b).unwrap(),
                    DistKind::Pert,
                    DEFAULT_LAMBDA,
                )
            })
            .collect()
    }

    #[test]
    fn histogram_shape_is_well_formed() {
        let ss = samplers(&[(5.0, 8.0, 20.0), (2.0, 3.0, 5.0)]);
        for dist in [
            montecarlo::simulate(&ss, 100_000, 1),
            convolve::convolve(&ss, 2048),
        ] {
            let s = summarize(&dist, 40);
            assert_eq!(s.probs.len(), 40);
            assert_eq!(s.cdf.len(), 41);
            assert!(s.hi > s.lo);
            assert!(s.probs.iter().all(|&p| p >= 0.0), "確率が負になっている");
            assert!(s.cdf.windows(2).all(|w| w[1] >= w[0]), "CDF が単調でない");
            assert!(s.cdf[0] >= 0.0 && *s.cdf.last().unwrap() <= 1.0);
            let mass: f64 = s.probs.iter().sum();
            // 両側 0.1% を切っているので 0.998 前後に収まる。
            assert!(mass > 0.99 && mass <= 1.0, "総質量 {mass}");
        }
    }

    #[test]
    fn percentiles_come_back_in_increasing_order() {
        let ss = samplers(&[(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)]);
        let s = summarize(&montecarlo::simulate(&ss, 100_000, 9), 40);
        assert_eq!(s.percentiles.len(), PCT_LEVELS.len());
        assert!(
            s.percentiles.windows(2).all(|w| w[1] >= w[0]),
            "分位点が単調でない: {:?}",
            s.percentiles
        );
    }

    #[test]
    fn a_collapsed_distribution_still_produces_a_drawable_range() {
        let ss = samplers(&[(4.0, 4.0, 4.0)]);
        let s = summarize(&convolve::convolve(&ss, 512), 20);
        assert!(s.hi > s.lo, "幅ゼロの範囲を返してはいけない");
        assert!(s.probs.iter().sum::<f64>() > 0.99);
        assert!(s.percentiles.iter().all(|&p| (p - 4.0).abs() < 1e-9));
    }

    #[test]
    fn both_engines_produce_comparable_summaries() {
        let ss = samplers(&[(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)]);
        let a = summarize(&montecarlo::simulate(&ss, 400_000, 20_250_920), 60);
        let b = summarize(&convolve::convolve(&ss, 4096), 60);
        assert!((a.lo - b.lo).abs() < 1.0);
        assert!((a.hi - b.hi).abs() < 1.0);
        for (x, y) in a.percentiles.iter().zip(&b.percentiles) {
            assert!((x - y).abs() < 0.6, "分位点 {x} vs {y}");
        }
    }
}
