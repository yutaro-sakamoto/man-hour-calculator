//! 決定論的な擬似乱数生成器 (xoshiro256++)。
//!
//! 外部クレートを使わないのは依存を減らすためだけでなく、**同じシードなら
//! 環境やバージョンをまたいでも必ず同じ結果になる**ことを保証したいから。
//! 見積もりの数字が実行するたびに変わると議論の土台にならない。

/// xoshiro256++ 生成器。
#[derive(Debug, Clone)]
pub struct Rng {
    state: [u64; 4],
}

/// シードを 4 語の内部状態に展開するための混合関数。
fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

impl Rng {
    /// シードから生成器を作る。全状態が 0 になると xoshiro は破綻するため、
    /// splitmix64 で展開したうえで念のため 0 を避ける。
    pub fn new(seed: u64) -> Self {
        let mut s = seed;
        let mut state = [0u64; 4];
        for slot in state.iter_mut() {
            *slot = splitmix64(&mut s);
        }
        if state == [0; 4] {
            state = [1, 2, 3, 4];
        }
        Self { state }
    }

    /// 次の 64 ビット乱数。
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let result = self.state[0]
            .wrapping_add(self.state[3])
            .rotate_left(23)
            .wrapping_add(self.state[0]);
        let t = self.state[1] << 17;
        self.state[2] ^= self.state[0];
        self.state[3] ^= self.state[1];
        self.state[1] ^= self.state[2];
        self.state[0] ^= self.state[3];
        self.state[2] ^= t;
        self.state[3] = self.state[3].rotate_left(45);
        result
    }

    /// 半開区間 `[0, 1)` の一様乱数。
    ///
    /// 上位 53 ビットだけを使うので、結果はちょうど `k / 2^53`
    /// (`k` は `0 <= k < 2^53` の整数) の形になり、**1.0 を返すことはない**。
    /// これは逆関数法で分布の上端を超えないために必要な性質。
    #[inline]
    pub fn next_u01(&mut self) -> f64 {
        // 2^-53
        const SCALE: f64 = 1.0 / 9_007_199_254_740_992.0;
        (self.next_u64() >> 11) as f64 * SCALE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_gives_same_sequence() {
        let a: Vec<u64> = (0..16).map(|_| Rng::new(42).next_u64()).collect();
        let mut rng = Rng::new(42);
        let b: Vec<u64> = (0..16).map(|_| Rng::new(42).next_u64()).collect();
        assert_eq!(a, b);
        // 連続して引けば当然値は変わる。
        let first = rng.next_u64();
        assert_ne!(first, rng.next_u64());
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = Rng::new(1);
        let mut b = Rng::new(2);
        let xs: Vec<u64> = (0..8).map(|_| a.next_u64()).collect();
        let ys: Vec<u64> = (0..8).map(|_| b.next_u64()).collect();
        assert_ne!(xs, ys);
    }

    #[test]
    fn u01_stays_in_half_open_unit_interval() {
        let mut rng = Rng::new(0xdead_beef);
        for _ in 0..200_000 {
            let u = rng.next_u01();
            assert!((0.0..1.0).contains(&u), "u = {u} は [0,1) の外");
        }
    }

    #[test]
    fn u01_is_roughly_uniform() {
        let mut rng = Rng::new(7);
        let n = 200_000;
        let mut buckets = [0usize; 10];
        let mut sum = 0.0;
        for _ in 0..n {
            let u = rng.next_u01();
            sum += u;
            buckets[(u * 10.0) as usize] += 1;
        }
        let mean = sum / n as f64;
        assert!((mean - 0.5).abs() < 0.01, "平均 {mean} が 0.5 から離れすぎ");
        for (i, count) in buckets.iter().enumerate() {
            let share = *count as f64 / n as f64;
            assert!((share - 0.1).abs() < 0.01, "bucket {i} の割合 {share}");
        }
    }

    #[test]
    fn zero_seed_does_not_break_the_generator() {
        let mut rng = Rng::new(0);
        let xs: Vec<u64> = (0..8).map(|_| rng.next_u64()).collect();
        assert!(xs.iter().any(|&x| x != 0));
    }
}
