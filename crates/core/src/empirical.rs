//! 2 つの計算エンジンが共通で返す、離散化された分布の表現。
//!
//! モンテカルロは「ソート済みのサンプル列」、畳み込みは「グリッド上の確率質量」を
//! 生成するが、どちらも *値の列* と *そこまでの累積確率* のペアに落とせる。
//! 同じ型にそろえておくことで、分位点・CDF・ヒストグラムを求めるコードを
//! 1 本に統一でき、2 つのエンジンの結果を同じ土俵で比較できる。

/// 値と累積確率の対で表した分布。
#[derive(Debug, Clone)]
pub struct EmpiricalDist {
    /// 昇順にソートされた値。空にはならない。
    values: Vec<f64>,
    /// `cum[i] = P(X <= values[i])`。単調非減少で末尾は `1.0`。
    cum: Vec<f64>,
    mean: f64,
    sd: f64,
}

impl EmpiricalDist {
    /// ソート済みのサンプル列から作る (モンテカルロ用)。
    ///
    /// `values` は昇順であること。`cum[i]` は経験分布関数 `(i+1)/n`。
    pub fn from_sorted_samples(values: Vec<f64>, mean: f64, sd: f64) -> Self {
        debug_assert!(!values.is_empty());
        debug_assert!(
            values.windows(2).all(|w| w[0] <= w[1]),
            "values must be sorted"
        );
        let n = values.len();
        let cum = (1..=n).map(|i| i as f64 / n as f64).collect();
        Self {
            values,
            cum,
            mean,
            sd,
        }
    }

    /// グリッド上の確率質量から作る (畳み込み用)。
    ///
    /// `values` は昇順、`pmf` は同じ長さの非負値。内部で総和 1 に正規化する。
    pub fn from_grid(values: Vec<f64>, pmf: &[f64], mean: f64, sd: f64) -> Self {
        debug_assert_eq!(values.len(), pmf.len());
        debug_assert!(!values.is_empty());
        let total: f64 = pmf.iter().sum();
        let scale = if total > 0.0 { 1.0 / total } else { 0.0 };

        let mut cum = Vec::with_capacity(pmf.len());
        let mut running = 0.0;
        for &p in pmf {
            running += p.max(0.0) * scale;
            cum.push(running.min(1.0));
        }
        // 丸め誤差があっても末尾は必ず 1.0 にする。
        if let Some(last) = cum.last_mut() {
            *last = 1.0;
        }
        Self {
            values,
            cum,
            mean,
            sd,
        }
    }

    /// 幅のない分布 (すべてのタスクが確定値だった場合)。
    pub fn point_mass(value: f64) -> Self {
        Self {
            values: vec![value],
            cum: vec![1.0],
            mean: value,
            sd: 0.0,
        }
    }

    #[inline]
    pub fn mean(&self) -> f64 {
        self.mean
    }

    #[inline]
    pub fn sd(&self) -> f64 {
        self.sd
    }

    #[inline]
    pub fn min(&self) -> f64 {
        self.values[0]
    }

    #[inline]
    pub fn max(&self) -> f64 {
        self.values[self.values.len() - 1]
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.values.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        false
    }

    /// 分位関数。`p` は `[0,1]` に丸めて扱う。
    ///
    /// `p` について単調非減少で、戻り値は必ず `[min, max]` に収まる。
    pub fn quantile(&self, p: f64) -> f64 {
        let p = if p.is_finite() {
            p.clamp(0.0, 1.0)
        } else {
            0.5
        };
        if p <= self.cum[0] {
            return self.values[0];
        }
        // cum[i] >= p となる最小の i。p > cum[0] なので i >= 1。
        let i = self.cum.partition_point(|&c| c < p);
        if i >= self.values.len() {
            return self.max();
        }
        let (c0, c1) = (self.cum[i - 1], self.cum[i]);
        let (x0, x1) = (self.values[i - 1], self.values[i]);
        let t = if c1 > c0 { (p - c0) / (c1 - c0) } else { 0.0 };
        (x0 + t * (x1 - x0)).clamp(self.min(), self.max())
    }

    /// 累積分布関数 `P(X <= x)`。`x` について単調非減少で、戻り値は `[0,1]`。
    pub fn cdf_at(&self, x: f64) -> f64 {
        if x.is_nan() {
            return 0.0;
        }
        if x < self.values[0] {
            return 0.0;
        }
        if x >= self.max() {
            return 1.0;
        }
        // values[i] > x となる最小の i。x >= values[0] かつ x < max なので 1 <= i < len。
        let i = self.values.partition_point(|&v| v <= x);
        let (x0, x1) = (self.values[i - 1], self.values[i]);
        let (c0, c1) = (self.cum[i - 1], self.cum[i]);
        // partition_point の定義より x1 > x >= x0 なので x1 > x0。
        let t = if x1 > x0 { (x - x0) / (x1 - x0) } else { 1.0 };
        (c0 + t * (c1 - c0)).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples(v: &[f64]) -> EmpiricalDist {
        let mut values = v.to_vec();
        values.sort_by(f64::total_cmp);
        let n = values.len() as f64;
        let mean = values.iter().sum::<f64>() / n;
        let var = values.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / n;
        EmpiricalDist::from_sorted_samples(values, mean, var.sqrt())
    }

    #[test]
    fn quantile_hits_the_endpoints() {
        let d = samples(&[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(d.quantile(0.0), 1.0);
        assert_eq!(d.quantile(1.0), 4.0);
    }

    #[test]
    fn quantile_is_monotone_and_bounded() {
        let d = samples(&[3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0]);
        let mut prev = f64::NEG_INFINITY;
        for i in 0..=1000 {
            let q = d.quantile(i as f64 / 1000.0);
            assert!(q >= prev);
            assert!(q >= d.min() && q <= d.max());
            prev = q;
        }
    }

    #[test]
    fn cdf_is_monotone_and_bounded() {
        let d = samples(&[3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0]);
        let mut prev = f64::NEG_INFINITY;
        for i in 0..=1000 {
            let x = -2.0 + 14.0 * (i as f64 / 1000.0);
            let c = d.cdf_at(x);
            assert!((0.0..=1.0).contains(&c));
            assert!(c >= prev, "CDF が単調でない: x={x}");
            prev = c;
        }
        assert_eq!(d.cdf_at(0.0), 0.0);
        assert_eq!(d.cdf_at(100.0), 1.0);
        assert_eq!(d.cdf_at(f64::NAN), 0.0);
    }

    #[test]
    fn grid_distribution_normalises_its_mass() {
        // 正規化されていない質量 (総和 8) を渡しても、累積は 1 で終わる。
        let d = EmpiricalDist::from_grid(vec![0.0, 1.0, 2.0], &[2.0, 4.0, 2.0], 1.0, 0.7);
        assert_eq!(d.cdf_at(2.0), 1.0);
        // 累積は [0.25, 0.75, 1.0]。中央値は 0 と 1 の間を線形補間した位置になる。
        assert!((d.quantile(0.5) - 0.5).abs() < 1e-12);
        assert!((d.quantile(0.25) - 0.0).abs() < 1e-12);
        // 対称な質量なので、分布も中心 1.0 について対称。
        assert!((d.quantile(0.75) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn point_mass_behaves_like_a_constant() {
        let d = EmpiricalDist::point_mass(12.0);
        assert_eq!(d.quantile(0.0), 12.0);
        assert_eq!(d.quantile(0.9), 12.0);
        assert_eq!(d.cdf_at(11.999), 0.0);
        assert_eq!(d.cdf_at(12.0), 1.0);
        assert_eq!(d.sd(), 0.0);
    }
}
