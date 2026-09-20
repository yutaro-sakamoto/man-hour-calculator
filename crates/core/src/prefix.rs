//! 「タスク i までの累積工数」の分布。
//!
//! タスクは一覧の並び順に着手する前提なので、タスク i が終わるのは
//! **1 番目から i 番目までの工数の合計**を消化し終えたときになる。
//! その累積和 (prefix sum) の分布が分かれば、カレンダーと突き合わせて
//! 「タスク i が d 日までに終わっている確率」を出せる。
//!
//! 人員がいる場合、「そこまで」は **同じ担当者のタスクの中で** 数える。
//! 別の人のタスクは並行して進むので、順番に足してはいけない。
//!
//! 全タスクぶんの累積和をサンプルのまま抱えるとメモリを食うので、
//! 担当者ごとの工数グリッド上の CDF に畳んで持つ。グリッドは
//! `[0, その担当者の担当ぶんの最大工数]` を `bins` 等分したもので、
//! `row(i)[k]` は `P(タスク i までの累積工数 <= k * step)` を表す。

use crate::empirical::EmpiricalDist;

/// 累積和の分布をどの粒度で記録するか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrefixSpec {
    /// グリッドの分割数。`0` なら累積和を記録しない。
    pub bins: usize,
}

impl PrefixSpec {
    /// 累積和を記録しない指定。
    pub fn none() -> Self {
        Self { bins: 0 }
    }

    /// 記録するかどうか。
    pub fn is_enabled(&self) -> bool {
        self.bins > 0
    }

    /// グリッドの刻み幅。
    pub fn step(&self, grid_hi: f64) -> f64 {
        if self.is_enabled() && grid_hi > 0.0 && grid_hi.is_finite() {
            grid_hi / self.bins as f64
        } else {
            0.0
        }
    }

    /// 工数 `x` を含む最小のグリッド点の添字。
    ///
    /// 切り上げなので、この添字以降を数え上げれば `P(X <= k * step)` になる。
    pub fn bin_of(&self, grid_hi: f64, x: f64) -> usize {
        let step = self.step(grid_hi);
        if step <= 0.0 || x.is_nan() || x <= 0.0 {
            return 0;
        }
        let index = (x / step).ceil();
        // グリッドを超える工数 (無限大を含む) は上限の点に寄せる。
        if index < self.bins as f64 {
            index as usize
        } else {
            self.bins
        }
    }
}

/// タスクを人員ごとの待ち行列に割り当てた形。
#[derive(Debug, Clone, Copy)]
pub struct Assignment<'a> {
    /// タスクごとの担当者の添字。
    pub members: &'a [usize],
    /// 人員ごとの累積和グリッドの上限 (その人の担当ぶんの最大工数の合計)。
    pub grid_hi: &'a [f64],
}

impl<'a> Assignment<'a> {
    /// 担当者の添字。範囲外なら 0 に倒す。
    pub fn member_of(&self, task: usize) -> usize {
        let member = self.members.get(task).copied().unwrap_or(0);
        if member < self.grid_hi.len() {
            member
        } else {
            0
        }
    }

    /// そのタスクの担当者のグリッド上限。
    pub fn grid_hi_of(&self, task: usize) -> f64 {
        self.grid_hi
            .get(self.member_of(task))
            .copied()
            .unwrap_or(0.0)
    }

    pub fn members_count(&self) -> usize {
        self.grid_hi.len()
    }

    /// 担当者 `member` のタスクを並び順に返す。
    pub fn tasks_of(&self, member: usize) -> Vec<usize> {
        self.members
            .iter()
            .enumerate()
            .filter(|&(_, &m)| m == member)
            .map(|(index, _)| index)
            .collect()
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
        let spec = PrefixSpec { bins: 10 };
        assert_eq!(spec.step(100.0), 10.0);
        assert_eq!(spec.bin_of(100.0, 0.0), 0);
        assert_eq!(spec.bin_of(100.0, -5.0), 0);
        assert_eq!(spec.bin_of(100.0, 0.1), 1);
        assert_eq!(spec.bin_of(100.0, 10.0), 1, "境界はその点に含める");
        assert_eq!(spec.bin_of(100.0, 10.1), 2);
        assert_eq!(spec.bin_of(100.0, 100.0), 10);
        assert_eq!(spec.bin_of(100.0, 500.0), 10, "上限で止める");
        assert_eq!(spec.bin_of(100.0, f64::NAN), 0);
        assert_eq!(spec.bin_of(100.0, f64::INFINITY), 10);
        assert_eq!(spec.bin_of(0.0, 5.0), 0, "グリッドが無ければ 0");
    }

    #[test]
    fn an_assignment_splits_tasks_per_member() {
        let members = [0usize, 1, 0, 2];
        let grid_hi = [10.0, 20.0, 30.0];
        let assignment = Assignment {
            members: &members,
            grid_hi: &grid_hi,
        };
        assert_eq!(assignment.members_count(), 3);
        assert_eq!(assignment.tasks_of(0), vec![0, 2]);
        assert_eq!(assignment.tasks_of(1), vec![1]);
        assert_eq!(assignment.tasks_of(3), Vec::<usize>::new());
        assert_eq!(assignment.grid_hi_of(1), 20.0);
        // 範囲外の担当者は 0 番に倒す。
        let broken = [9usize];
        let fallback = Assignment {
            members: &broken,
            grid_hi: &grid_hi,
        };
        assert_eq!(fallback.member_of(0), 0);
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
        let spec = PrefixSpec { bins: 4 };
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
        let mut cdfs = PrefixCdfs::new(1, PrefixSpec { bins: 2 });
        cdfs.set(5, &[1.0, 1.0, 1.0]);
        assert_eq!(cdfs.row(5), &[] as &[f64]);
        assert_eq!(cdfs.row(0), &[0.0; 3]);
    }
}
