//! 3点見積もり(最小・最可能・最大)から総工数の確率分布を求めるコアロジック。
//!
//! このクレートは純粋なロジックだけを持ち、WASM にも OS にも依存しない。
//! `unsafe` は一切使わず(`forbid`)、FFI の詳細は `mhc-wasm` 側に閉じ込めてある。
//!
//! 計算エンジンは 2 つあり、同じ [`EmpiricalDist`] を返す:
//!
//! - [`montecarlo`] — 各タスクの分布から乱数サンプリングして総和を繰り返す。
//! - [`convolve`] — 各タスクの分布を共通グリッド上に離散化して逐次畳み込む。
//!   乱数を使わないので完全に決定論的で、モンテカルロの正しさを測るオラクルになる。
//!
//! [`EmpiricalDist`]: empirical::EmpiricalDist

#![forbid(unsafe_code)]

pub mod abi;
pub mod actuals;
pub mod calendar;
pub mod convolve;
pub mod date;
pub mod dist;
pub mod empirical;
pub mod estimate;
pub mod member;
pub mod montecarlo;
pub mod prefix;
pub mod rng;
pub mod stats;

pub use dist::{DistKind, Sampler};
pub use empirical::EmpiricalDist;
pub use estimate::{EstimateError, TaskEstimate};
pub use stats::Summary;
