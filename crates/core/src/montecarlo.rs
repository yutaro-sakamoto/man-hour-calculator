//! モンテカルロ法による総工数分布の推定。
//!
//! 各試行でタスクごとに `[0,1)` の一様乱数を引き、逆関数法でそのタスクの
//! 工数に変換して合計する。それを指定回数くり返した合計値の集合が
//! 総工数の標本分布になる。
//!
//! 乱数は [`crate::rng::Rng`] (xoshiro256++) を固定シードで使うので、
//! **同じ入力とシードなら必ず同じ結果**が出る。

use crate::dist::Sampler;
use crate::empirical::EmpiricalDist;
use crate::prefix::{Assignment, EngineOutput, PrefixCdfs, PrefixSpec};
use crate::rng::Rng;

/// タスクの前提を日程に効かせるための材料。
///
/// 前提のタスクが終わる**日**が分からないと、後ろのタスクがいつ着手できるかは
/// 決まらない。別の人の仕事は別の暦で進むので、担当者ごとの累積の稼働
/// (`cumulative[member][day]`、基準日から数えたもの) で日と工数を行き来する。
///
/// 試行ごとに、タスク i の「終わる位置」を担当者の稼働の座標で求める:
///
/// ```text
/// 着手位置 = max(担当者の直前のタスクの終わる位置,
///                前提が終わった日までに担当者が働ける量)   ← 待ち
/// 終わる位置 = 着手位置 + 工数
/// ```
///
/// 待ちの間は何もしないとみなす (手の空いた人が別の仕事に回ることは
/// 見込まない。保守的)。終わる位置の分布は、前提が無ければ従来の累積和と
/// 一致するので、画面側の読み方 (`P(終わる位置 <= その日までの稼働)`) は
/// 変わらない。
#[derive(Debug, Clone, Copy)]
pub struct Waits<'a> {
    /// タスクごとの前提 (添字)。自分より前のタスクだけ。
    pub preds: &'a [Vec<usize>],
    /// 担当者ごとの累積の稼働 (人日)。基準日より前は 0。
    pub cumulative: &'a [Vec<f64>],
}

impl Waits<'_> {
    /// 担当者 `member` が、`other` の仕事 (`other` の座標で `end` に終わる) を
    /// 待ってから着手できる位置。期間内に終わらなければ無限大。
    fn ready_at(&self, member: usize, other: usize, end: f64) -> f64 {
        if end <= 0.0 {
            return 0.0;
        }
        if !end.is_finite() {
            return f64::INFINITY;
        }
        let (Some(theirs), Some(mine)) = (self.cumulative.get(other), self.cumulative.get(member))
        else {
            return 0.0;
        };
        // その日に終わる。着手はその翌日から (同じ日に並べると、半日ずれた
        // 引き継ぎを 0 日で済ませることになる)。
        let day = theirs.partition_point(|&c| c < end - 1e-9);
        mine.get(day).copied().unwrap_or(f64::INFINITY)
    }
}

/// 総工数のモンテカルロ・シミュレーションを実行する。
///
/// `iterations` が 0 の場合やタスクが空の場合は点質量を返す。
pub fn simulate(samplers: &[Sampler], iterations: usize, seed: u64) -> EmpiricalDist {
    let members = vec![0usize; samplers.len()];
    let grid_hi = [0.0];
    run(
        samplers,
        iterations,
        seed,
        PrefixSpec::none(),
        &Assignment {
            members: &members,
            grid_hi: &grid_hi,
        },
        None,
    )
    .total
}

/// 総工数に加えて、各タスクまでの累積工数の分布も求める。
///
/// 累積和は**担当者ごとに**積み上げる。別の人のタスクは並行して進むので、
/// 一列に足してはいけない。試行ごとにグリッドの添字を数えるだけなので、
/// サンプルをタスク数ぶん保持する必要はなく、メモリはタスク数 × ビン数で収まる。
pub fn run(
    samplers: &[Sampler],
    iterations: usize,
    seed: u64,
    spec: PrefixSpec,
    assignment: &Assignment<'_>,
    waits: Option<&Waits<'_>>,
) -> EngineOutput {
    let mut prefix = PrefixCdfs::new(samplers.len(), spec);
    let members = assignment.members_count().max(1);

    if iterations == 0 {
        let mut running = vec![0.0; members];
        let mut total = 0.0;
        for (index, sampler) in samplers.iter().enumerate() {
            let likely = sampler.estimate().likely();
            total += likely;
            let member = assignment.member_of(index);
            running[member] += likely;
            let at = spec.bin_of(assignment.grid_hi_of(index), running[member]);
            prefix.set(index, &row_from_step(at, spec.bins));
        }
        return EngineOutput {
            total: EmpiricalDist::point_mass(total),
            prefix,
        };
    }

    let width = prefix.width();
    let mut counts = vec![0u32; samplers.len() * width];
    let mut running = vec![0.0; members];
    let mut ends = vec![0.0; samplers.len()];

    let mut rng = Rng::new(seed);
    let mut totals = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let mut total = 0.0;
        running.iter_mut().for_each(|value| *value = 0.0);
        for (index, sampler) in samplers.iter().enumerate() {
            let drawn = sampler.quantile(rng.next_u01());
            total += drawn;
            if width > 0 {
                let member = assignment.member_of(index);
                let start = match waits {
                    Some(waits) => waited_start(waits, assignment, index, running[member], &ends),
                    None => running[member],
                };
                let end = start + drawn;
                running[member] = end;
                ends[index] = end;
                let grid_hi = assignment.grid_hi_of(index);
                // 目盛りの外 (期間内に終わらない) は数えない。上限の点に寄せると
                // 「期間の最後の日には必ず終わっている」ことになってしまう。
                if end <= grid_hi * (1.0 + 1e-9) + 1e-12 {
                    counts[index * width + spec.bin_of(grid_hi, end)] += 1;
                }
            }
        }
        totals.push(total);
    }

    // 度数を累積して CDF にする。
    if width > 0 {
        let scale = 1.0 / iterations as f64;
        let mut row = vec![0.0; width];
        for index in 0..samplers.len() {
            let mut accumulated = 0u32;
            for (slot, &count) in row
                .iter_mut()
                .zip(&counts[index * width..(index + 1) * width])
            {
                accumulated += count;
                *slot = accumulated as f64 * scale;
            }
            prefix.set(index, &row);
        }
    }

    // 平均と標準偏差は 2 パスで求める (1 パスの二乗和は桁落ちしやすい)。
    let n = totals.len() as f64;
    let mean = totals.iter().sum::<f64>() / n;
    let variance = totals.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n;

    totals.sort_unstable_by(f64::total_cmp);
    EngineOutput {
        total: EmpiricalDist::from_sorted_samples(totals, mean, variance.max(0.0).sqrt()),
        prefix,
    }
}

/// どの試行でも超えない「終わる位置」(担当者ごと)。
///
/// 待ちは前のタスクの工数について**単調**なので (前が遅れれば後ろも遅れる)、
/// 全タスクを最大値で流したときの終わる位置が、各担当者の上限になる。
/// これを累積和の目盛りの上限に使う。期間いっぱいの稼働を上限にすると、
/// 刻みが粗くなって完了日が 1 日ずれていた。期間内に終わらなければ無限大。
pub fn upper_ends(maxima: &[f64], assignment: &Assignment<'_>, waits: &Waits<'_>) -> Vec<f64> {
    let mut running = vec![0.0; assignment.members_count().max(1)];
    let mut ends = vec![0.0; maxima.len()];
    for (index, &longest) in maxima.iter().enumerate() {
        let member = assignment.member_of(index);
        let start = waited_start(waits, assignment, index, running[member], &ends);
        running[member] = start + longest;
        ends[index] = running[member];
    }
    running
}

/// 前提を待ったうえでの着手位置 (担当者の稼働の座標)。
///
/// 同じ担当者の前提は、並び順で既に待てている (`running` がその先にある)。
fn waited_start(
    waits: &Waits<'_>,
    assignment: &Assignment<'_>,
    index: usize,
    running: f64,
    ends: &[f64],
) -> f64 {
    let member = assignment.member_of(index);
    let Some(preds) = waits.preds.get(index) else {
        return running;
    };
    preds
        .iter()
        .filter(|&&p| assignment.member_of(p) != member)
        .fold(running, |start, &p| {
            start.max(waits.ready_at(member, assignment.member_of(p), ends[p]))
        })
}

/// 添字 `at` 以降が 1.0 になる階段状の CDF。確定値のタスク用。
fn row_from_step(at: usize, bins: usize) -> Vec<f64> {
    (0..=bins)
        .map(|k| if k >= at { 1.0 } else { 0.0 })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dist::{DistKind, DEFAULT_LAMBDA};
    use crate::estimate::TaskEstimate;

    fn samplers(rows: &[(f64, f64, f64)], kind: DistKind) -> Vec<Sampler> {
        rows.iter()
            .map(|&(a, m, b)| {
                Sampler::new(TaskEstimate::new(a, m, b).unwrap(), kind, DEFAULT_LAMBDA)
            })
            .collect()
    }

    #[test]
    fn totals_never_leave_the_sum_of_the_estimate_ranges() {
        let rows = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];
        let lo: f64 = rows.iter().map(|r| r.0).sum();
        let hi: f64 = rows.iter().map(|r| r.2).sum();
        for kind in [DistKind::Pert, DistKind::Triangular] {
            let d = simulate(&samplers(&rows, kind), 50_000, 1);
            assert!(d.min() >= lo, "{kind:?}: 最小 {} < {lo}", d.min());
            assert!(d.max() <= hi, "{kind:?}: 最大 {} > {hi}", d.max());
        }
    }

    #[test]
    fn mean_converges_to_the_sum_of_the_task_means() {
        let rows = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];
        for kind in [DistKind::Pert, DistKind::Triangular] {
            let ss = samplers(&rows, kind);
            let analytic: f64 = ss.iter().map(|s| s.mean()).sum();
            let d = simulate(&ss, 200_000, 20_250_920);
            assert!(
                (d.mean() - analytic).abs() < 0.1,
                "{kind:?}: 標本平均 {} vs 解析平均 {analytic}",
                d.mean()
            );
        }
    }

    #[test]
    fn variance_converges_to_the_sum_of_the_task_variances() {
        // タスクが独立なので分散は足し算になるはず。
        let rows = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];
        let ss = samplers(&rows, DistKind::Pert);
        let analytic_sd: f64 = ss.iter().map(|s| s.variance()).sum::<f64>().sqrt();
        let d = simulate(&ss, 200_000, 3);
        assert!(
            (d.sd() - analytic_sd).abs() / analytic_sd < 0.02,
            "標本 SD {} vs 解析 SD {analytic_sd}",
            d.sd()
        );
    }

    #[test]
    fn the_same_seed_reproduces_the_same_distribution() {
        let ss = samplers(&[(1.0, 2.0, 9.0)], DistKind::Pert);
        let a = simulate(&ss, 10_000, 77);
        let b = simulate(&ss, 10_000, 77);
        assert_eq!(a.quantile(0.8), b.quantile(0.8));

        let c = simulate(&ss, 10_000, 78);
        assert_ne!(a.quantile(0.8), c.quantile(0.8), "シードが違えば結果も違う");
    }

    #[test]
    fn p80_exceeds_the_sum_of_the_most_likely_estimates() {
        // このアプリの主張そのもの: 最可能値を足しただけでは足りない。
        let rows = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];
        let sum_likely: f64 = rows.iter().map(|r| r.1).sum();
        let d = simulate(&samplers(&rows, DistKind::Pert), 200_000, 11);
        assert!(
            d.quantile(0.80) > sum_likely,
            "P80 {} が最可能値の合計 {sum_likely} を超えていない",
            d.quantile(0.80)
        );
    }

    #[test]
    fn fixed_tasks_produce_a_point_mass() {
        let ss = samplers(&[(3.0, 3.0, 3.0), (4.0, 4.0, 4.0)], DistKind::Pert);
        let d = simulate(&ss, 1_000, 1);
        assert_eq!(d.min(), 7.0);
        assert_eq!(d.max(), 7.0);
        assert_eq!(d.sd(), 0.0);
    }

    #[test]
    fn zero_iterations_falls_back_to_the_likely_total() {
        let ss = samplers(&[(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)], DistKind::Pert);
        let d = simulate(&ss, 0, 1);
        assert_eq!(d.mean(), 7.0);
    }
}
