//! 「タスク i までの累積工数」の分布。
//!
//! タスクは一覧の並び順に着手する前提なので、タスク i が終わるのは
//! **1 番目から i 番目までの工数の合計**を消化し終えたときになる。
//! その累積和 (prefix sum) の分布が分かれば、カレンダーと突き合わせて
//! 「タスク i が d 日までに終わっている確率」を出せる。
//!
//! 全タスクぶんの累積和をサンプルのまま抱えるとメモリを食うので、
//! 共通の工数グリッド上の CDF に畳んで持つ。グリッドは `[0, grid_hi]` を
//! `bins` 等分したもので、`row(i)[k]` は
//! `P(タスク i までの累積工数 <= k * step)` を表す。

use crate::empirical::EmpiricalDist;

/// 累積和の分布をどの粒度で記録するか。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrefixSpec {
    /// グリッドの分割数。`0` なら累積和を記録しない。
    pub bins: usize,
    /// グリッドの上限工数。
    pub grid_hi: f64,
}

impl PrefixSpec {
    /// 累積和を記録しない指定。
    pub fn none() -> Self {
        Self {
            bins: 0,
            grid_hi: 0.0,
        }
    }

    /// 記録するかどうか。
    pub fn is_enabled(&self) -> bool {
        self.bins > 0 && self.grid_hi > 0.0 && self.grid_hi.is_finite()
    }

    /// グリッドの刻み幅。
    pub fn step(&self) -> f64 {
        if self.is_enabled() {
            self.grid_hi / self.bins as f64
        } else {
            0.0
        }
    }

    /// 工数 `x` を含む最小のグリッド点の添字。
    ///
    /// 切り上げなので、この添字以降を数え上げれば `P(X <= k * step)` になる。
    pub fn bin_of(&self, x: f64) -> usize {
        if !self.is_enabled() || x.is_nan() || x <= 0.0 {
            return 0;
        }
        let index = (x / self.step()).ceil();
        // グリッドを超える工数 (無限大を含む) は上限の点に寄せる。
        if index < self.bins as f64 {
            index as usize
        } else {
            self.bins
        }
    }
}

/// タスクごとの累積和 CDF をまとめたもの。
#[derive(Debug, Clone)]
pub struct PrefixCdfs {
    tasks: usize,
    bins: usize,
    data: Vec<f64>,
}

impl PrefixCdfs {
    /// すべて 0 で初期化する。
    pub fn new(tasks: usize, spec: PrefixSpec) -> Self {
        let bins = if spec.is_enabled() { spec.bins } else { 0 };
        let width = if bins > 0 { bins + 1 } else { 0 };
        Self {
            tasks,
            bins,
            data: vec![0.0; tasks * width],
        }
    }

    #[inline]
    pub fn bins(&self) -> usize {
        self.bins
    }

    #[inline]
    pub fn tasks(&self) -> usize {
        self.tasks
    }

    /// 行の幅 (`bins + 1`)。累積和を記録していなければ 0。
    #[inline]
    pub fn width(&self) -> usize {
        if self.bins > 0 {
            self.bins + 1
        } else {
            0
        }
    }

    /// タスク `task` の CDF。
    pub fn row(&self, task: usize) -> &[f64] {
        let w = self.width();
        if w == 0 || task >= self.tasks {
            return &[];
        }
        &self.data[task * w..(task + 1) * w]
    }

    /// タスク `task` の CDF を書き込む。単調性と `[0,1]` への収まりを構成的に保証する。
    pub fn set(&mut self, task: usize, values: &[f64]) {
        let w = self.width();
        if w == 0 || task >= self.tasks {
            return;
        }
        let row = &mut self.data[task * w..(task + 1) * w];
        let mut previous = 0.0f64;
        for (slot, &value) in row.iter_mut().zip(values) {
            previous = value.clamp(previous, 1.0);
            *slot = previous;
        }
    }

    /// ABI にそのまま載せられる平坦な配列。
    pub fn as_slice(&self) -> &[f64] {
        &self.data
    }
}

/// 計算エンジンの出力。
#[derive(Debug, Clone)]
pub struct EngineOutput {
    /// 総工数の分布。
    pub total: EmpiricalDist,
    /// 各タスクまでの累積工数の分布。
    pub prefix: PrefixCdfs,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_of_rounds_up_and_stays_in_range() {
        let spec = PrefixSpec {
            bins: 10,
            grid_hi: 100.0,
        };
        assert_eq!(spec.step(), 10.0);
        assert_eq!(spec.bin_of(0.0), 0);
        assert_eq!(spec.bin_of(-5.0), 0);
        assert_eq!(spec.bin_of(0.1), 1);
        assert_eq!(spec.bin_of(10.0), 1, "境界はその点に含める");
        assert_eq!(spec.bin_of(10.1), 2);
        assert_eq!(spec.bin_of(100.0), 10);
        assert_eq!(spec.bin_of(500.0), 10, "上限で止める");
        assert_eq!(spec.bin_of(f64::NAN), 0);
        assert_eq!(spec.bin_of(f64::INFINITY), 10);
    }

    #[test]
    fn a_disabled_spec_records_nothing() {
        let spec = PrefixSpec::none();
        assert!(!spec.is_enabled());
        let cdfs = PrefixCdfs::new(3, spec);
        assert_eq!(cdfs.width(), 0);
        assert!(cdfs.as_slice().is_empty());
        assert!(cdfs.row(0).is_empty());
    }

    #[test]
    fn rows_are_forced_to_be_monotone_and_bounded() {
        let spec = PrefixSpec {
            bins: 4,
            grid_hi: 4.0,
        };
        let mut cdfs = PrefixCdfs::new(2, spec);
        // わざと単調でない値と 1 を超える値を入れる。
        cdfs.set(0, &[0.2, 0.1, 0.9, 1.4, 0.5]);
        assert_eq!(cdfs.row(0), &[0.2, 0.2, 0.9, 1.0, 1.0]);
        // 触っていない行は 0 のまま。
        assert_eq!(cdfs.row(1), &[0.0; 5]);
        assert_eq!(cdfs.as_slice().len(), 10);
    }

    #[test]
    fn out_of_range_tasks_are_ignored() {
        let mut cdfs = PrefixCdfs::new(
            1,
            PrefixSpec {
                bins: 2,
                grid_hi: 1.0,
            },
        );
        cdfs.set(5, &[1.0, 1.0, 1.0]);
        assert_eq!(cdfs.row(5), &[] as &[f64]);
        assert_eq!(cdfs.row(0), &[0.0; 3]);
    }
}
