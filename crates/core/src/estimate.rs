//! 検証済みの 3 点見積もり。

use core::fmt;

/// 3 点見積もり(最小・最可能・最大)。
///
/// フィールドは private で、生成は [`TaskEstimate::new`] を通すしかない。
/// つまり **この値が存在する時点で** 以下が成り立つことが型で保証される
/// (parse, don't validate):
///
/// - `min`, `likely`, `max` はいずれも有限 (NaN でも無限大でもない)
/// - `0.0 <= min <= likely <= max`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TaskEstimate {
    min: f64,
    likely: f64,
    max: f64,
}

/// [`TaskEstimate::new`] が値を拒否する理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstimateError {
    /// NaN または無限大が含まれている。
    NotFinite,
    /// 負の工数が含まれている。
    Negative,
    /// `min <= likely <= max` の順序を満たしていない。
    OutOfOrder,
}

impl fmt::Display for EstimateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::NotFinite => "estimate contains NaN or infinity",
            Self::Negative => "estimate contains a negative value",
            Self::OutOfOrder => "estimate does not satisfy min <= likely <= max",
        };
        f.write_str(s)
    }
}

impl TaskEstimate {
    /// 不変条件を検査して [`TaskEstimate`] を作る。
    pub fn new(min: f64, likely: f64, max: f64) -> Result<Self, EstimateError> {
        if !(min.is_finite() && likely.is_finite() && max.is_finite()) {
            return Err(EstimateError::NotFinite);
        }
        if min < 0.0 {
            return Err(EstimateError::Negative);
        }
        // NaN は上で弾いているので、この比較は全順序として振る舞う。
        if !(min <= likely && likely <= max) {
            return Err(EstimateError::OutOfOrder);
        }
        Ok(Self { min, likely, max })
    }

    #[inline]
    pub fn min(&self) -> f64 {
        self.min
    }

    #[inline]
    pub fn likely(&self) -> f64 {
        self.likely
    }

    #[inline]
    pub fn max(&self) -> f64 {
        self.max
    }

    /// 分布の幅。`0.0` なら点質量(幅のない確定値)。
    #[inline]
    pub fn width(&self) -> f64 {
        self.max - self.min
    }

    /// 幅を持たない(= 確定値である)か。
    #[inline]
    pub fn is_degenerate(&self) -> bool {
        // フィールドは有限かつ min <= max なので、width は NaN にならず必ず 0 以上。
        self.width() <= 0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_and_degenerate_estimates() {
        assert!(TaskEstimate::new(1.0, 2.0, 3.0).is_ok());
        assert!(TaskEstimate::new(0.0, 0.0, 0.0).is_ok(), "点質量も妥当");
        assert!(TaskEstimate::new(2.0, 2.0, 5.0).is_ok(), "min == likely");
        assert!(TaskEstimate::new(2.0, 5.0, 5.0).is_ok(), "likely == max");
    }

    #[test]
    fn rejects_invalid_estimates() {
        use EstimateError::*;
        assert_eq!(TaskEstimate::new(f64::NAN, 1.0, 2.0), Err(NotFinite));
        assert_eq!(TaskEstimate::new(1.0, f64::INFINITY, 2.0), Err(NotFinite));
        assert_eq!(TaskEstimate::new(-1.0, 1.0, 2.0), Err(Negative));
        assert_eq!(TaskEstimate::new(3.0, 2.0, 5.0), Err(OutOfOrder));
        assert_eq!(TaskEstimate::new(1.0, 5.0, 2.0), Err(OutOfOrder));
    }

    #[test]
    fn degenerate_detection() {
        let point = TaskEstimate::new(4.0, 4.0, 4.0).unwrap();
        assert!(point.is_degenerate());
        assert_eq!(point.width(), 0.0);

        let spread = TaskEstimate::new(4.0, 5.0, 6.0).unwrap();
        assert!(!spread.is_degenerate());
    }
}

/// 3 点見積もりの不変条件を**有界モデル検査**で確かめる。
///
/// この型は「作れた時点で `0 <= min <= likely <= max` かつ有限」を
/// 約束している。約束しているのは型なので、テストで標本を撃つのではなく、
/// **すべての `f64` の組について**成り立つことを Kani に証明させる。
#[cfg(kani)]
mod verification {
    use super::*;

    /// 作れたなら不変条件が成り立つ (健全性)。
    #[kani::proof]
    fn a_constructed_estimate_always_satisfies_its_invariant() {
        let (min, likely, max): (f64, f64, f64) = (kani::any(), kani::any(), kani::any());
        if let Ok(e) = TaskEstimate::new(min, likely, max) {
            assert!(e.min().is_finite() && e.likely().is_finite() && e.max().is_finite());
            assert!(e.min() >= 0.0, "負の値を通した");
            assert!(e.min() <= e.likely(), "min <= likely が破れた");
            assert!(e.likely() <= e.max(), "likely <= max が破れた");
            // 幅は NaN にならず、必ず 0 以上。
            assert!(e.width() >= 0.0, "幅が負か NaN");
        }
    }

    /// 不変条件を満たす入力は必ず受け付ける (完全性)。
    ///
    /// 健全性だけだと「全部断る」実装でも通ってしまう。
    #[kani::proof]
    fn any_valid_triple_is_accepted() {
        let (min, likely, max): (f64, f64, f64) = (kani::any(), kani::any(), kani::any());
        kani::assume(min.is_finite() && likely.is_finite() && max.is_finite());
        kani::assume(min >= 0.0 && min <= likely && likely <= max);
        assert!(
            TaskEstimate::new(min, likely, max).is_ok(),
            "妥当な組を断った"
        );
    }

    /// `NaN` はどの位置にあっても必ず弾かれる。
    ///
    /// `NaN` は比較がすべて偽になるので、素朴な `if min > likely` の形だと
    /// すり抜ける。ここが通ることで、以降の比較を全順序として扱ってよい
    /// ことが保証される。
    #[kani::proof]
    fn nan_never_gets_through() {
        let (a, b): (f64, f64) = (kani::any(), kani::any());
        assert!(TaskEstimate::new(f64::NAN, a, b).is_err());
        assert!(TaskEstimate::new(a, f64::NAN, b).is_err());
        assert!(TaskEstimate::new(a, b, f64::NAN).is_err());
    }
}
