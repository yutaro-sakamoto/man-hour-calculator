//! JavaScript と WASM の間でやり取りするバッファの読み書き。
//!
//! リクエストもレスポンスも **要素がすべて `f64` の平坦な配列**で表す。
//! 整数もフラグも日付も `f64` に載せる。こうしておくと JS 側は
//! `new Float64Array(memory.buffer, ptr, len)` ひとつで読み書きでき、
//! 型混在によるオフセットずれやアラインメント違反が構造的に起きない。
//!
//! 日付は「1970-01-01 からの日数」で表し、未入力は `NaN` で示す。
//!
//! レイアウトの詳細は `docs/ABI.md` を参照。

use crate::actuals::{self, Actual, TaskState};
use crate::calendar::{Calendar, CalendarConfig, CalendarEvent, MAX_HORIZON_DAYS};
use crate::convolve;
use crate::dist::{DistKind, Sampler, DEFAULT_LAMBDA};
use crate::estimate::TaskEstimate;
use crate::montecarlo;
use crate::prefix::PrefixSpec;
use crate::stats::{self, PCT_LEVELS};

/// リクエストが正しいバッファであることを確認するための印。
pub const MAGIC: f64 = 20_250_920.0;
/// ABI のバージョン。レイアウトを変えたら上げる。
pub const VERSION: f64 = 2.0;

/// リクエストのヘッダ長 (f64 の個数)。
pub const REQ_HEADER: usize = 32;
/// レスポンスのヘッダ長 (f64 の個数)。
pub const RESP_HEADER: usize = 24;
/// タスク 1 件がリクエストで占める要素数。
pub const REQ_TASK_STRIDE: usize = 6;
/// 予定 1 件がリクエストで占める要素数。
pub const REQ_EVENT_STRIDE: usize = 3;

pub const MAX_TASKS: usize = 500;
pub const MAX_EVENTS: usize = 2_000;
pub const MAX_FORCED_WORKDAYS: usize = 2_000;
pub const MAX_ITERATIONS: usize = 2_000_000;
pub const MIN_BINS: usize = 4;
pub const MAX_BINS: usize = 512;
pub const MIN_GRID: usize = 16;
pub const MAX_GRID: usize = 16_384;
pub const MAX_PREFIX_BINS: usize = 1_024;
/// カレンダーを返す最大日数 (約 5 年)。レスポンスが際限なく膨らむのを防ぐ。
pub const MAX_HORIZON: usize = 1_830;
/// モンテカルロの総サンプリング回数 (試行回数 × タスク数) の上限。
/// ブラウザの UI スレッドを何十秒も止めないための歯止め。
pub const MAX_WORK: usize = 50_000_000;
/// 累積和 CDF に使う要素数の上限。
pub const MAX_PREFIX_CELLS: usize = 200_000;

/// レスポンスの `status` に入る値。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Status {
    Ok = 0,
    /// バッファが短すぎる、または magic / version が合わない。
    BadHeader = 1,
    /// タスク数が 0、上限超え、またはバッファ長と矛盾している。
    BadTaskCount = 2,
    /// 試行回数・ビン数・グリッド数が範囲外、または計算量が大きすぎる。
    BadParams = 3,
    /// `min <= likely <= max` を満たさないタスクがある (`detail` に添字)。
    InvalidEstimate = 4,
    /// エンジンの指定が不正。
    UnknownEngine = 5,
    /// 相関つきの計算は畳み込みエンジンでは扱えない。
    CorrelationUnsupported = 6,
    /// カレンダーの設定が不正。
    BadCalendar = 7,
}

/// 計算エンジンの種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    MonteCarlo,
    Convolution,
}

impl Engine {
    fn from_code(code: f64) -> Option<Self> {
        match code as i64 {
            0 => Some(Self::MonteCarlo),
            1 => Some(Self::Convolution),
            _ => None,
        }
    }

    fn code(self) -> f64 {
        match self {
            Self::MonteCarlo => 0.0,
            Self::Convolution => 1.0,
        }
    }
}

/// 1 タスクぶんの入力 (見積もりと実績)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TaskInput {
    pub min: f64,
    pub likely: f64,
    pub max: f64,
    pub start_day: Option<i64>,
    /// 進捗率 `0.0..=1.0`。
    pub progress: f64,
    pub end_day: Option<i64>,
}

impl TaskInput {
    /// 実績を持たない、見積もりだけのタスク。
    pub fn estimate_only(min: f64, likely: f64, max: f64) -> Self {
        Self {
            min,
            likely,
            max,
            start_day: None,
            progress: 0.0,
            end_day: None,
        }
    }
}

/// 復号したリクエスト。
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub engine: Engine,
    pub kind: DistKind,
    pub lambda: f64,
    pub iterations: usize,
    pub seed: u64,
    pub n_bins: usize,
    pub grid_points: usize,
    pub correlation: f64,
    pub prefix_bins: usize,
    pub calendar: CalendarConfig,
    pub today_day: i64,
    pub tasks: Vec<TaskInput>,
    pub events: Vec<CalendarEvent>,
    pub forced_workdays: Vec<i64>,
}

impl Default for Request {
    fn default() -> Self {
        Self {
            engine: Engine::MonteCarlo,
            kind: DistKind::Pert,
            lambda: DEFAULT_LAMBDA,
            iterations: 100_000,
            seed: 20_250_920,
            n_bins: 48,
            grid_points: 2_048,
            correlation: 0.0,
            prefix_bins: 256,
            calendar: CalendarConfig {
                start_day: 20_716, // 2026-09-20
                horizon_days: 365,
                weekday_mask: 0b0011_1110,
                hours_per_day: 8.0,
                hours_per_person_day: 8.0,
                team_size: 1.0,
                use_japanese_holidays: true,
            },
            today_day: 20_716,
            tasks: Vec::new(),
            events: Vec::new(),
            forced_workdays: Vec::new(),
        }
    }
}

/// 未入力を表す `NaN` と日数の相互変換。
fn day_to_f64(day: Option<i64>) -> f64 {
    day.map(|d| d as f64).unwrap_or(f64::NAN)
}

fn f64_to_day(value: f64) -> Option<i64> {
    if value.is_finite() {
        Some(value as i64)
    } else {
        None
    }
}

/// `f64` を添字などの `usize` に落とす。負数・NaN・巨大値は `None`。
fn as_index(v: f64) -> Option<usize> {
    if !v.is_finite() || v < 0.0 || v > usize::MAX as f64 {
        return None;
    }
    Some(v as usize)
}

impl Request {
    /// バッファに書き出す。
    pub fn encode(&self) -> Vec<f64> {
        let mut out = vec![0.0; REQ_HEADER];
        out[0] = MAGIC;
        out[1] = VERSION;
        out[2] = self.engine.code();
        out[3] = match self.kind {
            DistKind::Pert => 0.0,
            DistKind::Triangular => 1.0,
        };
        out[4] = self.lambda;
        out[5] = self.tasks.len() as f64;
        out[6] = self.iterations as f64;
        out[7] = self.seed as f64;
        out[8] = self.n_bins as f64;
        out[9] = self.grid_points as f64;
        out[10] = self.correlation;
        out[11] = self.prefix_bins as f64;
        out[12] = self.events.len() as f64;
        out[13] = self.forced_workdays.len() as f64;
        out[14] = self.calendar.start_day as f64;
        out[15] = self.calendar.horizon_days as f64;
        out[16] = self.calendar.weekday_mask as f64;
        out[17] = self.calendar.hours_per_day;
        out[18] = self.calendar.hours_per_person_day;
        out[19] = self.calendar.team_size;
        out[20] = f64::from(self.calendar.use_japanese_holidays);
        out[21] = self.today_day as f64;

        for t in &self.tasks {
            out.extend_from_slice(&[
                t.min,
                t.likely,
                t.max,
                day_to_f64(t.start_day),
                t.progress,
                day_to_f64(t.end_day),
            ]);
        }
        for e in &self.events {
            out.extend_from_slice(&[e.start_day as f64, e.end_day as f64, e.hours]);
        }
        for &d in &self.forced_workdays {
            out.push(d as f64);
        }
        out
    }

    /// バッファから読み取る。失敗したらステータスと補足情報を返す。
    pub fn decode(buf: &[f64]) -> Result<Self, (Status, f64)> {
        if buf.len() < REQ_HEADER || buf[0] != MAGIC || buf[1] != VERSION {
            return Err((Status::BadHeader, 0.0));
        }

        let engine = Engine::from_code(buf[2]).ok_or((Status::UnknownEngine, buf[2]))?;
        let kind = DistKind::from_code(buf[3]).unwrap_or(DistKind::Pert);
        let lambda = if buf[4].is_finite() {
            buf[4]
        } else {
            DEFAULT_LAMBDA
        };

        let n_tasks = as_index(buf[5]).ok_or((Status::BadTaskCount, buf[5]))?;
        let n_events = as_index(buf[12]).ok_or((Status::BadCalendar, buf[12]))?;
        let n_forced = as_index(buf[13]).ok_or((Status::BadCalendar, buf[13]))?;

        if n_tasks == 0 || n_tasks > MAX_TASKS {
            return Err((Status::BadTaskCount, n_tasks as f64));
        }
        if n_events > MAX_EVENTS || n_forced > MAX_FORCED_WORKDAYS {
            return Err((Status::BadCalendar, 0.0));
        }
        let expected =
            REQ_HEADER + n_tasks * REQ_TASK_STRIDE + n_events * REQ_EVENT_STRIDE + n_forced;
        if buf.len() < expected {
            return Err((Status::BadTaskCount, n_tasks as f64));
        }

        let (iterations, n_bins, grid_points, prefix_bins) = (
            as_index(buf[6]).ok_or((Status::BadParams, 0.0))?,
            as_index(buf[8]).ok_or((Status::BadParams, 0.0))?,
            as_index(buf[9]).ok_or((Status::BadParams, 0.0))?,
            as_index(buf[11]).ok_or((Status::BadParams, 0.0))?,
        );
        if !(1..=MAX_ITERATIONS).contains(&iterations)
            || !(MIN_BINS..=MAX_BINS).contains(&n_bins)
            || !(MIN_GRID..=MAX_GRID).contains(&grid_points)
            || prefix_bins > MAX_PREFIX_BINS
        {
            return Err((Status::BadParams, 0.0));
        }
        if engine == Engine::MonteCarlo && iterations.saturating_mul(n_tasks) > MAX_WORK {
            return Err((Status::BadParams, 0.0));
        }
        if n_tasks.saturating_mul(prefix_bins + 1) > MAX_PREFIX_CELLS {
            return Err((Status::BadParams, 0.0));
        }

        let horizon = as_index(buf[15]).ok_or((Status::BadCalendar, buf[15]))?;
        if horizon > MAX_HORIZON.min(MAX_HORIZON_DAYS) {
            return Err((Status::BadCalendar, horizon as f64));
        }
        let start_day = f64_to_day(buf[14]).ok_or((Status::BadCalendar, buf[14]))?;
        if !buf[17].is_finite() || !buf[18].is_finite() || !buf[19].is_finite() {
            return Err((Status::BadCalendar, 0.0));
        }
        if buf[18] <= 0.0 || buf[17] < 0.0 || buf[19] < 0.0 {
            return Err((Status::BadCalendar, 0.0));
        }

        let calendar = CalendarConfig {
            start_day,
            horizon_days: horizon,
            weekday_mask: (buf[16] as i64).clamp(0, 127) as u8,
            hours_per_day: buf[17],
            hours_per_person_day: buf[18],
            team_size: buf[19],
            use_japanese_holidays: buf[20] != 0.0,
        };

        let mut tasks = Vec::with_capacity(n_tasks);
        for i in 0..n_tasks {
            let at = REQ_HEADER + i * REQ_TASK_STRIDE;
            tasks.push(TaskInput {
                min: buf[at],
                likely: buf[at + 1],
                max: buf[at + 2],
                start_day: f64_to_day(buf[at + 3]),
                progress: if buf[at + 4].is_finite() {
                    buf[at + 4].clamp(0.0, 1.0)
                } else {
                    0.0
                },
                end_day: f64_to_day(buf[at + 5]),
            });
        }

        let events_at = REQ_HEADER + n_tasks * REQ_TASK_STRIDE;
        let mut events = Vec::with_capacity(n_events);
        for i in 0..n_events {
            let at = events_at + i * REQ_EVENT_STRIDE;
            let (Some(from), Some(to)) = (f64_to_day(buf[at]), f64_to_day(buf[at + 1])) else {
                return Err((Status::BadCalendar, i as f64));
            };
            events.push(CalendarEvent {
                start_day: from,
                end_day: to.max(from),
                hours: if buf[at + 2].is_finite() {
                    buf[at + 2]
                } else {
                    -1.0
                },
            });
        }

        let forced_at = events_at + n_events * REQ_EVENT_STRIDE;
        let forced_workdays = (0..n_forced)
            .filter_map(|i| f64_to_day(buf[forced_at + i]))
            .collect();

        Ok(Self {
            engine,
            kind,
            lambda,
            iterations,
            seed: if buf[7].is_finite() && buf[7] >= 0.0 {
                buf[7] as u64
            } else {
                0
            },
            n_bins,
            grid_points,
            correlation: buf[10],
            prefix_bins,
            calendar,
            today_day: f64_to_day(buf[21]).unwrap_or(start_day),
            tasks,
            events,
            forced_workdays,
        })
    }
}

/// エラーだけを載せたレスポンスを作る。
///
/// `n_bins` などはすべて 0 にするので、JS 側はヘッダだけ読めばよく、
/// 本体を読みにいって範囲外アクセスすることがない。
fn error_response(status: Status, detail: f64) -> Vec<f64> {
    let mut out = vec![0.0; RESP_HEADER];
    out[0] = status as u8 as f64;
    out[1] = VERSION;
    out[5] = detail;
    out
}

/// リクエストバッファを処理してレスポンスバッファを返す。
///
/// この関数は決して panic しない。入力の不正はすべて `status` で返す。
pub fn handle(buf: &[f64]) -> Vec<f64> {
    let request = match Request::decode(buf) {
        Ok(r) => r,
        Err((status, detail)) => return error_response(status, detail),
    };

    // 相関は将来の拡張用に場所だけ確保してある。
    if request.correlation.is_finite() && request.correlation != 0.0 {
        return error_response(Status::CorrelationUnsupported, request.correlation);
    }

    // --- 当初の見積もりを検証する
    let mut originals = Vec::with_capacity(request.tasks.len());
    for (i, t) in request.tasks.iter().enumerate() {
        match TaskEstimate::new(t.min, t.likely, t.max) {
            Ok(e) => originals.push(e),
            Err(_) => return error_response(Status::InvalidEstimate, i as f64),
        }
    }

    // --- カレンダーを組み立て、実績を織り込む
    let calendar = Calendar::build(&request.calendar, &request.events, &request.forced_workdays);
    let forecasts: Vec<_> = originals
        .iter()
        .zip(&request.tasks)
        .map(|(&original, input)| {
            let actual = Actual {
                start_day: input.start_day,
                progress: input.progress,
                end_day: input.end_day,
            };
            actuals::forecast(original, &actual, &calendar, request.today_day)
        })
        .collect();

    let total_min: f64 = forecasts.iter().map(|f| f.estimate.min()).sum();
    let total_likely: f64 = forecasts.iter().map(|f| f.estimate.likely()).sum();
    let total_max: f64 = forecasts.iter().map(|f| f.estimate.max()).sum();
    let total_spent: f64 = forecasts.iter().map(|f| f.spent).sum();

    let samplers: Vec<Sampler> = forecasts
        .iter()
        .map(|f| Sampler::new(f.estimate, request.kind, request.lambda))
        .collect();

    // --- 分布を求める
    let spec = PrefixSpec {
        bins: request.prefix_bins,
        grid_hi: total_max,
    };
    let output = match request.engine {
        Engine::MonteCarlo => montecarlo::run(&samplers, request.iterations, request.seed, spec),
        Engine::Convolution => convolve::run(&samplers, request.grid_points, spec),
    };
    let summary = stats::summarize(&output.total, request.n_bins);

    // 感度 = そのタスクの分散が総分散に占める割合。タスクは独立なので
    // 分散は単純に足し合わせでき、この比がそのまま「総工数のばらつきへの寄与」になる。
    let total_variance: f64 = samplers.iter().map(|s| s.variance()).sum();

    // --- レスポンスを組み立てる
    let n_tasks = request.tasks.len();
    let n_pct = PCT_LEVELS.len();
    let n_days = calendar.len();
    let prefix_width = output.prefix.width();

    let mut out = Vec::with_capacity(
        RESP_HEADER
            + request.n_bins * 2
            + 1
            + n_pct * 2
            + n_tasks * 6
            + n_tasks * prefix_width
            + n_days * 3,
    );
    out.resize(RESP_HEADER, 0.0);
    out[0] = Status::Ok as u8 as f64;
    out[1] = VERSION;
    out[2] = request.n_bins as f64;
    out[3] = n_pct as f64;
    out[4] = n_tasks as f64;
    out[6] = summary.mean;
    out[7] = summary.sd;
    out[8] = summary.lo;
    out[9] = summary.hi;
    out[10] = total_min;
    out[11] = total_likely;
    out[12] = total_max;
    out[13] = if prefix_width > 0 {
        request.prefix_bins as f64
    } else {
        0.0
    };
    out[14] = spec.grid_hi;
    out[15] = n_days as f64;
    out[16] = calendar.start_day() as f64;
    out[17] = total_spent;
    out[18] = request.calendar.base_capacity();
    out[19] = calendar.total_capacity();

    out.extend_from_slice(&summary.probs);
    out.extend_from_slice(&summary.cdf);
    out.extend_from_slice(&PCT_LEVELS);
    out.extend_from_slice(&summary.percentiles);
    out.extend(samplers.iter().map(|s| {
        if total_variance > 0.0 {
            s.variance() / total_variance
        } else {
            0.0
        }
    }));
    for f in &forecasts {
        out.extend_from_slice(&[f.estimate.min(), f.estimate.likely(), f.estimate.max()]);
    }
    out.extend(forecasts.iter().map(|f| f.spent));
    out.extend(forecasts.iter().map(|f| f.state.code()));
    out.extend_from_slice(output.prefix.as_slice());
    out.extend_from_slice(calendar.capacity());
    out.extend_from_slice(calendar.cumulative());
    out.extend(calendar.flags().iter().map(|&f| f as f64));
    out
}

/// レスポンスの各区画がどこから始まるかを数えるヘルパ。JS 側の読み取りと対応する。
///
/// 返り値は `(probs, cdf, levels, values, sensitivity, effective, spent, state,
/// prefix, capacity, cumulative, flags, 末尾)` の開始位置。
pub fn response_offsets(
    n_bins: usize,
    n_pct: usize,
    n_tasks: usize,
    prefix_width: usize,
    n_days: usize,
) -> [usize; 13] {
    let mut at = RESP_HEADER;
    let mut offsets = [0usize; 13];
    for (slot, len) in offsets.iter_mut().zip([
        n_bins,
        n_bins + 1,
        n_pct,
        n_pct,
        n_tasks,
        n_tasks * 3,
        n_tasks,
        n_tasks,
        n_tasks * prefix_width,
        n_days,
        n_days,
        n_days,
        0,
    ]) {
        *slot = at;
        at += len;
    }
    offsets
}

/// タスクの状態コードを復元する (テストと JS の突き合わせ用)。
pub fn state_from_code(code: f64) -> TaskState {
    match code as i64 {
        2 => TaskState::Done,
        1 => TaskState::InProgress,
        _ => TaskState::NotStarted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::date::days_from_civil;

    const TASKS: [(f64, f64, f64); 3] = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];
    /// 2026-09-21 (月)。
    fn monday() -> i64 {
        days_from_civil(2026, 9, 21)
    }

    fn request(engine: Engine) -> Request {
        Request {
            engine,
            iterations: 50_000,
            n_bins: 40,
            calendar: CalendarConfig {
                start_day: monday(),
                horizon_days: 180,
                use_japanese_holidays: false,
                ..Request::default().calendar
            },
            today_day: monday(),
            tasks: TASKS
                .iter()
                .map(|&(a, m, b)| TaskInput::estimate_only(a, m, b))
                .collect(),
            ..Request::default()
        }
    }

    /// レスポンスを区画ごとに切り出す。JS 側の読み取り手順をそのまま再現している。
    struct Response<'a> {
        raw: &'a [f64],
        offsets: [usize; 13],
        n_bins: usize,
        n_tasks: usize,
        prefix_width: usize,
        n_days: usize,
    }

    impl<'a> Response<'a> {
        fn parse(raw: &'a [f64]) -> Self {
            let n_bins = raw[2] as usize;
            let n_pct = raw[3] as usize;
            let n_tasks = raw[4] as usize;
            let prefix_width = if raw[13] > 0.0 {
                raw[13] as usize + 1
            } else {
                0
            };
            let n_days = raw[15] as usize;
            Self {
                raw,
                offsets: response_offsets(n_bins, n_pct, n_tasks, prefix_width, n_days),
                n_bins,
                n_tasks,
                prefix_width,
                n_days,
            }
        }
        fn section(&self, index: usize, len: usize) -> &[f64] {
            &self.raw[self.offsets[index]..self.offsets[index] + len]
        }
        fn probs(&self) -> &[f64] {
            self.section(0, self.n_bins)
        }
        fn cdf(&self) -> &[f64] {
            self.section(1, self.n_bins + 1)
        }
        fn levels(&self) -> &[f64] {
            self.section(2, PCT_LEVELS.len())
        }
        fn percentiles(&self) -> &[f64] {
            self.section(3, PCT_LEVELS.len())
        }
        fn sensitivity(&self) -> &[f64] {
            self.section(4, self.n_tasks)
        }
        fn effective(&self, task: usize) -> (f64, f64, f64) {
            let s = self.section(5, self.n_tasks * 3);
            (s[task * 3], s[task * 3 + 1], s[task * 3 + 2])
        }
        fn spent(&self) -> &[f64] {
            self.section(6, self.n_tasks)
        }
        fn states(&self) -> &[f64] {
            self.section(7, self.n_tasks)
        }
        fn prefix(&self, task: usize) -> &[f64] {
            let all = self.section(8, self.n_tasks * self.prefix_width);
            &all[task * self.prefix_width..(task + 1) * self.prefix_width]
        }
        fn capacity(&self) -> &[f64] {
            self.section(9, self.n_days)
        }
        fn cumulative(&self) -> &[f64] {
            self.section(10, self.n_days)
        }
        fn flags(&self) -> &[f64] {
            self.section(11, self.n_days)
        }
        /// ヘッダの宣言どおりに読み切れること。JS が範囲外を読まないための最重要不変条件。
        fn assert_consistent(&self) {
            assert_eq!(
                self.raw.len(),
                self.offsets[12],
                "宣言長とバッファ長が一致しない"
            );
        }
        fn p80(&self) -> f64 {
            self.percentiles()[4]
        }
    }

    #[test]
    fn encoding_a_request_round_trips() {
        let mut r = request(Engine::Convolution);
        r.kind = DistKind::Triangular;
        r.events = vec![
            CalendarEvent {
                start_day: monday() + 3,
                end_day: monday() + 4,
                hours: -1.0,
            },
            CalendarEvent {
                start_day: monday() + 10,
                end_day: monday() + 10,
                hours: 2.5,
            },
        ];
        r.forced_workdays = vec![monday() + 5, monday() + 12];
        r.tasks[1].start_day = Some(monday());
        r.tasks[1].progress = 0.4;
        r.tasks[2].end_day = Some(monday() + 7);
        r.tasks[2].start_day = Some(monday() + 1);

        let decoded = Request::decode(&r.encode()).expect("復号できるはず");
        assert_eq!(decoded, r);
    }

    #[test]
    fn a_valid_request_succeeds_on_both_engines() {
        for engine in [Engine::MonteCarlo, Engine::Convolution] {
            let raw = handle(&request(engine).encode());
            let resp = Response::parse(&raw);
            assert_eq!(raw[0], Status::Ok as u8 as f64, "{engine:?}");
            resp.assert_consistent();
            assert_eq!(raw[10], 17.0, "Σmin");
            assert_eq!(raw[11], 26.0, "Σlikely");
            assert_eq!(raw[12], 65.0, "Σmax");
            assert_eq!(resp.levels(), &PCT_LEVELS);
            assert!(resp.probs().iter().all(|&p| p >= 0.0));
            assert!(resp.cdf().windows(2).all(|w| w[1] >= w[0]));
            assert!(resp.percentiles().windows(2).all(|w| w[1] >= w[0]));
            assert!((resp.sensitivity().iter().sum::<f64>() - 1.0).abs() < 1e-9);
            assert!(
                resp.p80() > raw[11],
                "{engine:?}: P80 が Σlikely を超えない"
            );
        }
    }

    #[test]
    fn the_response_layout_holds_across_parameter_ranges() {
        for (n_bins, prefix_bins, horizon) in [
            (MIN_BINS, 0, 0),
            (17, 64, 30),
            (MAX_BINS, 256, 365),
            (64, MAX_PREFIX_BINS, 1),
        ] {
            let mut r = request(Engine::Convolution);
            r.n_bins = n_bins;
            r.prefix_bins = prefix_bins;
            r.calendar.horizon_days = horizon;
            let raw = handle(&r.encode());
            assert_eq!(raw[0], Status::Ok as u8 as f64, "bins={n_bins}");
            Response::parse(&raw).assert_consistent();
        }
    }

    #[test]
    fn the_calendar_comes_back_with_capacity_and_flags() {
        let mut r = request(Engine::Convolution);
        r.calendar.horizon_days = 14;
        r.calendar.use_japanese_holidays = true;
        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        resp.assert_consistent();

        assert_eq!(resp.capacity().len(), 14);
        assert_eq!(raw[16], monday() as f64, "カレンダーの開始日");
        assert!((raw[18] - 1.0).abs() < 1e-12, "1 稼働日あたり 1 人日");
        // 2026-09-21 は敬老の日、22 は国民の休日、23 は秋分の日。
        assert_eq!(&resp.capacity()[0..3], &[0.0; 3]);
        assert_eq!(resp.flags()[0] as u8 & crate::calendar::FLAG_HOLIDAY, 2);
        assert!(resp.cumulative().windows(2).all(|w| w[1] >= w[0]));
        assert_eq!(*resp.cumulative().last().unwrap(), raw[19]);
    }

    #[test]
    fn a_completed_task_is_replaced_by_its_actual_effort() {
        let mut r = request(Engine::Convolution);
        // 1 番目を月曜着手・金曜完了にする → 稼働 5 日ぶん。
        r.tasks[0].start_day = Some(monday());
        r.tasks[0].end_day = Some(monday() + 4);
        r.tasks[0].progress = 1.0;
        r.today_day = monday() + 10;

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        resp.assert_consistent();
        assert_eq!(resp.effective(0), (5.0, 5.0, 5.0), "完了したタスクは幅ゼロ");
        assert_eq!(resp.spent()[0], 5.0);
        assert_eq!(resp.states()[0], 2.0, "Done");
        assert_eq!(resp.states()[1], 0.0, "NotStarted");
        // Σlikely は 8 + 3 + 15 = 26 から 5 + 3 + 15 = 23 に変わる。
        assert_eq!(raw[11], 23.0);
        assert_eq!(raw[17], 5.0, "消化済み工数の合計");
    }

    #[test]
    fn an_in_progress_task_widens_the_forecast_when_it_falls_behind() {
        let mut r = request(Engine::Convolution);
        r.tasks[0].start_day = Some(monday());
        r.tasks[0].progress = 0.25;
        r.today_day = monday() + 11; // 10 稼働日を消化

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        assert_eq!(resp.states()[0], 1.0, "InProgress");
        assert_eq!(resp.spent()[0], 10.0);
        let (min, likely, _) = resp.effective(0);
        assert!(min >= 10.0, "消化済みを下回らない");
        assert!(likely > 8.0, "遅れているので見通しは当初より大きい");
    }

    #[test]
    fn prefix_distributions_are_returned_per_task() {
        for engine in [Engine::MonteCarlo, Engine::Convolution] {
            let raw = handle(&request(engine).encode());
            let resp = Response::parse(&raw);
            resp.assert_consistent();
            assert_eq!(resp.prefix_width, 257);
            assert_eq!(raw[14], 65.0, "累積和グリッドの上限は Σmax");

            for i in 0..3 {
                let row = resp.prefix(i);
                assert!(
                    row.windows(2).all(|w| w[1] >= w[0]),
                    "{engine:?}: 単調でない"
                );
                assert_eq!(row[0], 0.0);
                assert!(*row.last().unwrap() > 0.999);
                if i > 0 {
                    let previous = resp.prefix(i - 1);
                    assert!(row.iter().zip(previous).all(|(a, b)| *a <= b + 1e-9));
                }
            }
        }
    }

    #[test]
    fn prefix_bins_of_zero_omits_the_section() {
        let mut r = request(Engine::Convolution);
        r.prefix_bins = 0;
        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        resp.assert_consistent();
        assert_eq!(raw[13], 0.0);
        assert_eq!(resp.prefix_width, 0);
    }

    #[test]
    fn short_or_corrupt_headers_are_rejected() {
        assert_eq!(handle(&[])[0], Status::BadHeader as u8 as f64);
        assert_eq!(handle(&[1.0, 2.0, 3.0])[0], Status::BadHeader as u8 as f64);

        for (index, value) in [(0, 1.0), (1, 99.0)] {
            let mut raw = request(Engine::MonteCarlo).encode();
            raw[index] = value;
            assert_eq!(handle(&raw)[0], Status::BadHeader as u8 as f64);
        }
    }

    #[test]
    fn task_count_must_match_the_buffer() {
        for value in [99.0, 0.0, -1.0, f64::NAN, (MAX_TASKS + 1) as f64] {
            let mut raw = request(Engine::MonteCarlo).encode();
            raw[5] = value;
            assert_eq!(
                handle(&raw)[0],
                Status::BadTaskCount as u8 as f64,
                "n_tasks = {value} が弾かれていない"
            );
        }
    }

    #[test]
    fn out_of_range_parameters_are_rejected() {
        for (index, value) in [
            (6, 0.0), // 試行回数 0
            (6, (MAX_ITERATIONS + 1) as f64),
            (6, f64::NAN),
            (8, 1.0), // ビン数が少なすぎる
            (8, (MAX_BINS + 1) as f64),
            (9, 1.0), // グリッドが粗すぎる
            (9, (MAX_GRID + 1) as f64),
            (11, (MAX_PREFIX_BINS + 1) as f64), // 累積和のビン数
        ] {
            let mut raw = request(Engine::MonteCarlo).encode();
            raw[index] = value;
            assert_eq!(
                handle(&raw)[0],
                Status::BadParams as u8 as f64,
                "buf[{index}] = {value} が弾かれていない"
            );
        }
    }

    #[test]
    fn bad_calendar_settings_are_rejected() {
        for (index, value) in [
            (15, (MAX_HORIZON + 1) as f64), // 期間が長すぎる
            (15, -1.0),
            (17, f64::NAN), // 1 日の作業時間
            (18, 0.0),      // 1 人日あたりの時間が 0
            (18, -8.0),
            (19, -1.0),                    // チーム人数が負
            (12, (MAX_EVENTS + 1) as f64), // 予定が多すぎる
        ] {
            let mut raw = request(Engine::MonteCarlo).encode();
            raw[index] = value;
            assert_eq!(
                handle(&raw)[0],
                Status::BadCalendar as u8 as f64,
                "buf[{index}] = {value} が弾かれていない"
            );
        }
    }

    #[test]
    fn excessive_work_is_refused_instead_of_freezing_the_browser() {
        let mut r = request(Engine::MonteCarlo);
        r.tasks = vec![TaskInput::estimate_only(1.0, 2.0, 3.0); 100];
        r.iterations = MAX_ITERATIONS;
        assert_eq!(handle(&r.encode())[0], Status::BadParams as u8 as f64);
    }

    #[test]
    fn invalid_estimates_report_the_offending_task() {
        let mut r = request(Engine::MonteCarlo);
        r.tasks[1] = TaskInput::estimate_only(9.0, 3.0, 5.0);
        let raw = handle(&r.encode());
        assert_eq!(raw[0], Status::InvalidEstimate as u8 as f64);
        assert_eq!(raw[5], 1.0, "2 番目のタスクが不正");
    }

    #[test]
    fn unknown_engine_and_correlation_are_reported() {
        let mut raw = request(Engine::MonteCarlo).encode();
        raw[2] = 7.0;
        assert_eq!(handle(&raw)[0], Status::UnknownEngine as u8 as f64);

        let mut raw = request(Engine::MonteCarlo).encode();
        raw[10] = 0.5;
        assert_eq!(handle(&raw)[0], Status::CorrelationUnsupported as u8 as f64);
    }

    #[test]
    fn error_responses_carry_no_body() {
        let raw = handle(&[]);
        assert_eq!(raw.len(), RESP_HEADER);
        assert_eq!(raw[2], 0.0, "n_bins は 0");
        assert_eq!(raw[4], 0.0, "n_tasks は 0");
        assert_eq!(raw[15], 0.0, "n_days は 0");
    }

    #[test]
    fn an_unknown_distribution_code_falls_back_to_pert() {
        let mut raw = request(Engine::Convolution).encode();
        raw[3] = 42.0;
        let fallback = handle(&raw);
        raw[3] = 0.0;
        let pert = handle(&raw);
        assert_eq!(fallback[0], Status::Ok as u8 as f64);
        assert_eq!(fallback[6], pert[6], "平均が PERT と一致する");
    }

    #[test]
    fn events_and_forced_workdays_change_the_capacity() {
        let mut r = request(Engine::Convolution);
        r.calendar.horizon_days = 14;
        r.events = vec![CalendarEvent {
            start_day: monday() + 1,
            end_day: monday() + 1,
            hours: -1.0,
        }];
        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        assert_eq!(resp.capacity()[1], 0.0, "終日の予定で稼働が 0 になる");
        assert_eq!(resp.flags()[1] as u8 & crate::calendar::FLAG_EVENT, 4);

        // 土曜 (添字 5) を休日出勤にする。
        r.forced_workdays = vec![monday() + 5];
        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        assert_eq!(resp.capacity()[5], 1.0);
    }
}
