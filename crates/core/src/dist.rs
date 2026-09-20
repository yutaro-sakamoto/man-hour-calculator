//! 3 点見積もりを確率分布として扱うためのサンプラ。
//!
//! 対応する分布は 2 つ:
//!
//! - **三角分布** — 累積分布関数もその逆関数も閉形式で書ける。軽くて挙動が読みやすい。
//! - **PERT (ベータ) 分布** — 実務の見積もりで標準的に使われる。最可能値まわりに
//!   確率が集まり、両端は三角分布より薄くなる。閉形式の逆関数がないため、
//!   ベータ分布の PDF を数値積分して CDF グリッドを作り、そこから逆 CDF テーブルを
//!   前計算して線形補間でサンプリングする。
//!
//! 逆 CDF テーブルは累積和から作るため**単調性が構成上保証**され、両端はちょうど
//! `min` と `max` になる。つまりサンプル値が見積もり範囲の外に出ることはない。

use crate::estimate::TaskEstimate;

/// PERT 分布の既定の形状パラメータ。`(min + 4*likely + max) / 6` という
/// 標準的な PERT 平均に対応する。
pub const DEFAULT_LAMBDA: f64 = 4.0;

/// ベータ PDF を数値積分するときの分割数。
const CDF_NODES: usize = 1024;
/// 逆 CDF テーブルの分割数 (テーブル長は +1)。
const INV_NODES: usize = 1024;

/// 3 点見積もりに当てはめる分布の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistKind {
    /// PERT (ベータ) 分布。
    Pert,
    /// 三角分布。
    Triangular,
}

impl DistKind {
    /// ABI 上の数値表現から復元する。未知の値は `None`。
    pub fn from_code(code: f64) -> Option<Self> {
        match code as i64 {
            0 => Some(Self::Pert),
            1 => Some(Self::Triangular),
            _ => None,
        }
    }
}

/// ひとつのタスクの分布。CDF とその逆関数を提供する。
#[derive(Debug, Clone)]
pub struct Sampler {
    est: TaskEstimate,
    kind: DistKind,
    mean: f64,
    variance: f64,
    /// PERT のみ。`[0,1]` 上に正規化した CDF (長さ `CDF_NODES + 1`)。
    cdf_grid: Vec<f64>,
    /// PERT のみ。実スケールの逆 CDF テーブル (長さ `INV_NODES + 1`)。
    inv_grid: Vec<f64>,
}

/// 形状パラメータを扱える範囲に丸める。`NaN` などは既定値に落とす。
fn sanitize_lambda(lambda: f64) -> f64 {
    if lambda.is_finite() {
        lambda.clamp(0.0, 100.0)
    } else {
        DEFAULT_LAMBDA
    }
}

/// 正規化していないベータ PDF `t^(a-1) * (1-t)^(b-1)`。
fn beta_pdf_unnorm(t: f64, alpha: f64, beta: f64) -> f64 {
    let left = if alpha == 1.0 {
        1.0
    } else {
        t.powf(alpha - 1.0)
    };
    let right = if beta == 1.0 {
        1.0
    } else {
        (1.0 - t).powf(beta - 1.0)
    };
    let v = left * right;
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

/// ベータ PDF を台形則で積分し、`[0,1]` 上の正規化済み CDF グリッドを作る。
///
/// 返り値は必ず単調非減少で、先頭が `0.0`、末尾が `1.0` になる。
fn build_beta_cdf(mode_ratio: f64, lambda: f64) -> Vec<f64> {
    let alpha = 1.0 + lambda * mode_ratio;
    let beta = 1.0 + lambda * (1.0 - mode_ratio);
    let n = CDF_NODES;
    let h = 1.0 / n as f64;

    let mut cdf = vec![0.0; n + 1];
    let mut prev = beta_pdf_unnorm(0.0, alpha, beta);
    for i in 1..=n {
        let cur = beta_pdf_unnorm(i as f64 * h, alpha, beta);
        cdf[i] = cdf[i - 1] + 0.5 * (prev + cur) * h;
        prev = cur;
    }

    let total = cdf[n];
    if !(total > 0.0 && total.is_finite()) {
        // 数値的に積分できなかった場合の退避策として一様分布を使う。
        // 実用上ここに来ることはないが、NaN を下流に流さないための保険。
        for (i, v) in cdf.iter_mut().enumerate() {
            *v = i as f64 / n as f64;
        }
        return cdf;
    }

    for v in cdf.iter_mut() {
        *v /= total;
    }
    // 丸め誤差で単調性が崩れうるので、構成的に潰しておく。
    cdf[0] = 0.0;
    for i in 1..=n {
        cdf[i] = cdf[i].clamp(cdf[i - 1], 1.0);
    }
    cdf[n] = 1.0;
    cdf
}

/// CDF グリッドを反転して、等間隔の `u` に対する逆 CDF テーブルを作る。
///
/// 返り値は必ず単調非減少で、先頭が `a`、末尾が `b`。
fn build_inverse(cdf: &[f64], a: f64, b: f64) -> Vec<f64> {
    let n = cdf.len() - 1;
    let k = INV_NODES;
    let mut inv = vec![0.0; k + 1];

    let mut seg = 0usize;
    for (j, slot) in inv.iter_mut().enumerate() {
        let u = j as f64 / k as f64;
        while seg < n && cdf[seg + 1] < u {
            seg += 1;
        }
        let i = seg.min(n - 1);
        let (c0, c1) = (cdf[i], cdf[i + 1]);
        let frac = if c1 > c0 {
            ((u - c0) / (c1 - c0)).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let t = (i as f64 + frac) / n as f64;
        *slot = a + t * (b - a);
    }

    inv[0] = a;
    for j in 1..=k {
        inv[j] = inv[j].clamp(inv[j - 1], b);
    }
    inv[k] = b;
    inv
}

impl Sampler {
    /// 見積もりと分布の種類からサンプラを構築する。
    ///
    /// PERT の場合はここで CDF グリッドと逆 CDF テーブルを前計算する
    /// (サンプリング 1 回あたりのコストを `O(1)` にするため)。
    pub fn new(est: TaskEstimate, kind: DistKind, lambda: f64) -> Self {
        let (a, m, b) = (est.min(), est.likely(), est.max());

        if est.is_degenerate() {
            return Self {
                est,
                kind,
                mean: a,
                variance: 0.0,
                cdf_grid: Vec::new(),
                inv_grid: Vec::new(),
            };
        }

        match kind {
            DistKind::Triangular => {
                let mean = (a + m + b) / 3.0;
                let variance = (a * a + m * m + b * b - a * m - a * b - m * b) / 18.0;
                Self {
                    est,
                    kind,
                    mean,
                    variance: variance.max(0.0),
                    cdf_grid: Vec::new(),
                    inv_grid: Vec::new(),
                }
            }
            DistKind::Pert => {
                let lambda = sanitize_lambda(lambda);
                // PERT の平均と分散は解析的に求まるので、数値積分の結果ではなく
                // こちらを使う (グリッド解像度に依存しない値にするため)。
                let mean = (a + lambda * m + b) / (lambda + 2.0);
                let variance = ((mean - a) * (b - mean) / (lambda + 3.0)).max(0.0);
                let cdf_grid = build_beta_cdf((m - a) / (b - a), lambda);
                let inv_grid = build_inverse(&cdf_grid, a, b);
                Self {
                    est,
                    kind,
                    mean,
                    variance,
                    cdf_grid,
                    inv_grid,
                }
            }
        }
    }

    /// もとの 3 点見積もり。
    #[inline]
    pub fn estimate(&self) -> TaskEstimate {
        self.est
    }

    #[inline]
    pub fn kind(&self) -> DistKind {
        self.kind
    }

    #[inline]
    pub fn mean(&self) -> f64 {
        self.mean
    }

    #[inline]
    pub fn variance(&self) -> f64 {
        self.variance
    }

    #[inline]
    pub fn sd(&self) -> f64 {
        self.variance.sqrt()
    }

    /// 逆 CDF (分位関数)。`u` は `[0, 1]` に丸めて扱う。
    ///
    /// 戻り値は必ず `[min, max]` の中に収まる。
    pub fn quantile(&self, u: f64) -> f64 {
        let (a, m, b) = (self.est.min(), self.est.likely(), self.est.max());
        if self.est.is_degenerate() {
            return a;
        }
        let u = if u.is_finite() {
            u.clamp(0.0, 1.0)
        } else {
            0.5
        };

        match self.kind {
            DistKind::Triangular => {
                let width = b - a;
                let split = (m - a) / width;
                let x = if u <= split {
                    a + (u * width * (m - a)).sqrt()
                } else {
                    b - ((1.0 - u) * width * (b - m)).sqrt()
                };
                x.clamp(a, b)
            }
            DistKind::Pert => {
                let k = INV_NODES;
                let pos = u * k as f64;
                let j = (pos as usize).min(k - 1);
                let frac = pos - j as f64;
                let x = self.inv_grid[j] + frac * (self.inv_grid[j + 1] - self.inv_grid[j]);
                x.clamp(a, b)
            }
        }
    }

    /// 累積分布関数 `P(X <= x)`。戻り値は必ず `[0, 1]`。
    pub fn cdf(&self, x: f64) -> f64 {
        let (a, m, b) = (self.est.min(), self.est.likely(), self.est.max());
        if self.est.is_degenerate() {
            return if x < a { 0.0 } else { 1.0 };
        }
        if !x.is_finite() {
            return if x.is_nan() || x < 0.0 { 0.0 } else { 1.0 };
        }
        if x <= a {
            return 0.0;
        }
        if x >= b {
            return 1.0;
        }

        let v = match self.kind {
            DistKind::Triangular => {
                let width = b - a;
                if x < m {
                    // a < x < m なので m > a が保証され、ゼロ除算は起きない。
                    (x - a) * (x - a) / (width * (m - a))
                } else {
                    // m <= x < b なので b > m が保証される。
                    1.0 - (b - x) * (b - x) / (width * (b - m))
                }
            }
            DistKind::Pert => {
                let n = CDF_NODES;
                let t = (x - a) / (b - a);
                let pos = t * n as f64;
                let i = (pos as usize).min(n - 1);
                let frac = pos - i as f64;
                self.cdf_grid[i] + frac * (self.cdf_grid[i + 1] - self.cdf_grid[i])
            }
        };
        v.clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;

    fn est(a: f64, m: f64, b: f64) -> TaskEstimate {
        TaskEstimate::new(a, m, b).unwrap()
    }

    /// テスト用にランダムだが妥当な 3 点見積もりを作る。
    fn random_estimate(rng: &mut Rng) -> TaskEstimate {
        let a = rng.next_u01() * 20.0;
        let mut xs = [a + rng.next_u01() * 30.0, a + rng.next_u01() * 30.0];
        if xs[0] > xs[1] {
            xs.swap(0, 1);
        }
        TaskEstimate::new(a, xs[0], xs[1]).unwrap()
    }

    #[test]
    fn pert_mean_matches_the_classic_formula() {
        let s = Sampler::new(est(5.0, 8.0, 20.0), DistKind::Pert, DEFAULT_LAMBDA);
        assert!((s.mean() - (5.0 + 4.0 * 8.0 + 20.0) / 6.0).abs() < 1e-12);
        // 標準 PERT の分散は (mean-a)(b-mean)/7。
        let expected = (s.mean() - 5.0) * (20.0 - s.mean()) / 7.0;
        assert!((s.variance() - expected).abs() < 1e-12);
    }

    #[test]
    fn triangular_mean_and_variance_match_the_closed_form() {
        let s = Sampler::new(est(5.0, 8.0, 20.0), DistKind::Triangular, 0.0);
        assert!((s.mean() - 11.0).abs() < 1e-12);
        let (a, m, b) = (5.0, 8.0, 20.0);
        let expected = (a * a + m * m + b * b - a * m - a * b - m * b) / 18.0;
        assert!((s.variance() - expected).abs() < 1e-12);
    }

    #[test]
    fn triangular_cdf_is_exact_at_the_mode() {
        let s = Sampler::new(est(0.0, 3.0, 10.0), DistKind::Triangular, 0.0);
        // F(m) = (m-a)/(b-a)
        assert!((s.cdf(3.0) - 0.3).abs() < 1e-12);
    }

    #[test]
    fn quantiles_stay_inside_the_estimate_range() {
        let mut rng = Rng::new(20_250_920);
        for kind in [DistKind::Pert, DistKind::Triangular] {
            for _ in 0..500 {
                let e = random_estimate(&mut rng);
                let s = Sampler::new(e, kind, DEFAULT_LAMBDA);
                for _ in 0..50 {
                    let x = s.quantile(rng.next_u01());
                    assert!(
                        x >= e.min() && x <= e.max(),
                        "{kind:?}: {x} が [{}, {}] の外",
                        e.min(),
                        e.max()
                    );
                }
                // 端点も確認する。
                assert_eq!(s.quantile(0.0), e.min());
                assert_eq!(s.quantile(1.0), e.max());
            }
        }
    }

    #[test]
    fn quantile_is_monotone_in_u() {
        let mut rng = Rng::new(1234);
        for kind in [DistKind::Pert, DistKind::Triangular] {
            for _ in 0..200 {
                let s = Sampler::new(random_estimate(&mut rng), kind, DEFAULT_LAMBDA);
                let mut prev = f64::NEG_INFINITY;
                for j in 0..=200 {
                    let x = s.quantile(j as f64 / 200.0);
                    assert!(x >= prev, "{kind:?}: 分位関数が単調でない");
                    prev = x;
                }
            }
        }
    }

    #[test]
    fn cdf_is_monotone_and_bounded() {
        let mut rng = Rng::new(99);
        for kind in [DistKind::Pert, DistKind::Triangular] {
            for _ in 0..200 {
                let e = random_estimate(&mut rng);
                let s = Sampler::new(e, kind, DEFAULT_LAMBDA);
                let (lo, hi) = (e.min() - 1.0, e.max() + 1.0);
                let mut prev = f64::NEG_INFINITY;
                for j in 0..=200 {
                    let x = lo + (hi - lo) * (j as f64 / 200.0);
                    let c = s.cdf(x);
                    assert!((0.0..=1.0).contains(&c), "{kind:?}: CDF={c}");
                    assert!(c >= prev, "{kind:?}: CDF が単調でない");
                    prev = c;
                }
                assert_eq!(s.cdf(e.min() - 1.0), 0.0);
                assert_eq!(s.cdf(e.max() + 1.0), 1.0);
            }
        }
    }

    #[test]
    fn cdf_and_quantile_are_mutually_inverse() {
        let mut rng = Rng::new(555);
        for kind in [DistKind::Pert, DistKind::Triangular] {
            for _ in 0..200 {
                let e = random_estimate(&mut rng);
                let s = Sampler::new(e, kind, DEFAULT_LAMBDA);
                for _ in 0..20 {
                    let u = 0.01 + rng.next_u01() * 0.98;
                    let round_trip = s.cdf(s.quantile(u));
                    assert!(
                        (round_trip - u).abs() < 5e-3,
                        "{kind:?}: F(F^-1({u})) = {round_trip}"
                    );
                }
            }
        }
    }

    #[test]
    fn sampling_reproduces_the_analytic_mean() {
        let e = est(5.0, 8.0, 20.0);
        for kind in [DistKind::Pert, DistKind::Triangular] {
            let s = Sampler::new(e, kind, DEFAULT_LAMBDA);
            let mut rng = Rng::new(4242);
            let n = 200_000;
            let sum: f64 = (0..n).map(|_| s.quantile(rng.next_u01())).sum();
            let mc_mean = sum / n as f64;
            assert!(
                (mc_mean - s.mean()).abs() < 0.05,
                "{kind:?}: 標本平均 {mc_mean} vs 解析平均 {}",
                s.mean()
            );
        }
    }

    #[test]
    fn degenerate_estimates_collapse_to_a_point_mass() {
        for kind in [DistKind::Pert, DistKind::Triangular] {
            let s = Sampler::new(est(7.0, 7.0, 7.0), kind, DEFAULT_LAMBDA);
            assert_eq!(s.quantile(0.0), 7.0);
            assert_eq!(s.quantile(0.5), 7.0);
            assert_eq!(s.quantile(1.0), 7.0);
            assert_eq!(s.mean(), 7.0);
            assert_eq!(s.variance(), 0.0);
            assert_eq!(s.cdf(6.999), 0.0);
            assert_eq!(s.cdf(7.0), 1.0);
        }
    }

    #[test]
    fn one_sided_estimates_do_not_divide_by_zero() {
        // likely == min と likely == max はゼロ除算を誘発しやすい形。
        for e in [est(2.0, 2.0, 6.0), est(2.0, 6.0, 6.0)] {
            for kind in [DistKind::Pert, DistKind::Triangular] {
                let s = Sampler::new(e, kind, DEFAULT_LAMBDA);
                for j in 0..=100 {
                    let x = s.quantile(j as f64 / 100.0);
                    assert!(x.is_finite(), "{kind:?}: 分位点が有限でない");
                    assert!(x >= e.min() && x <= e.max());
                    assert!(s.cdf(x).is_finite());
                }
            }
        }
    }

    #[test]
    fn lambda_controls_the_spread_of_the_pert_distribution() {
        let e = est(0.0, 5.0, 10.0);
        let tight = Sampler::new(e, DistKind::Pert, 20.0);
        let loose = Sampler::new(e, DistKind::Pert, 1.0);
        assert!(
            tight.variance() < loose.variance(),
            "lambda を大きくすると最可能値に集中するはず"
        );
    }

    #[test]
    fn non_finite_lambda_falls_back_to_the_default() {
        let e = est(0.0, 5.0, 10.0);
        let a = Sampler::new(e, DistKind::Pert, f64::NAN);
        let b = Sampler::new(e, DistKind::Pert, DEFAULT_LAMBDA);
        assert!((a.mean() - b.mean()).abs() < 1e-12);
    }
}
