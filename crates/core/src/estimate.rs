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
