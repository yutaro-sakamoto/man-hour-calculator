//! JavaScript と WASM の間でやり取りするバッファの読み書き。
//!
//! リクエストもレスポンスも **要素がすべて `f64` の平坦な配列**で表す。
//! 整数もフラグも日付も時刻も `f64` に載せる。こうしておくと JS 側は
//! `new Float64Array(memory.buffer, ptr, len)` ひとつで読み書きでき、
//! 型混在によるオフセットずれやアラインメント違反が構造的に起きない。
//!
//! 日付は「1970-01-01 からの日数」、時刻は「0 時からの分」で表し、
//! 未入力は `NaN` で示す。
//!
//! レイアウトの詳細は `docs/ABI.md` を参照。

use crate::actuals::{self, Actual, TaskState};
use crate::calendar::{japanese_holidays_for, Calendar, CalendarConfig, CalendarEvent};
use crate::convolve;
use crate::dist::{DistKind, Sampler, DEFAULT_LAMBDA};
use crate::estimate::TaskEstimate;
use crate::member::MemberSchedule;
use crate::montecarlo;
use crate::prefix::{Assignment, PrefixSpec};
use crate::stats::{self, PCT_LEVELS};

/// リクエストが正しいバッファであることを確認するための印。
pub const MAGIC: f64 = 20_250_920.0;
/// ABI のバージョン。レイアウトを変えたら上げる。
pub const VERSION: f64 = 4.0;

/// リクエストのヘッダ長 (f64 の個数)。
pub const REQ_HEADER: usize = 32;
/// レスポンスのヘッダ長 (f64 の個数)。
pub const RESP_HEADER: usize = 24;
/// タスク 1 件がリクエストで占める要素数。
pub const REQ_TASK_STRIDE: usize = 7;
/// 人員 1 人がリクエストで占める要素数 (曜日ごとの開始 7 + 終了 7 + 休憩 1)。
pub const REQ_MEMBER_STRIDE: usize = 15;
/// 予定 1 件がリクエストで占める要素数。
pub const REQ_EVENT_STRIDE: usize = 6;
/// 予定と人員の割当 1 件が占める要素数。
pub const REQ_EVENT_MEMBER_STRIDE: usize = 2;
/// 休みにした回 1 件が占める要素数 (`[予定の添字, 回の初日]`)。
pub const REQ_EVENT_EXCEPTION_STRIDE: usize = 2;

pub const MAX_TASKS: usize = 500;
pub const MAX_MEMBERS: usize = 30;
pub const MAX_EVENTS: usize = 1_000;
pub const MAX_EVENT_MEMBERS: usize = 10_000;
pub const MAX_EVENT_EXCEPTIONS: usize = 10_000;
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
pub const MAX_WORK: usize = 50_000_000;
/// 累積和 CDF に使う要素数の上限。
pub const MAX_PREFIX_CELLS: usize = 200_000;
/// 人員 × 日数の上限。人員ごとに 3 本の配列を返すので、ここが応答サイズを決める。
/// 30 人 × 1 年でも 10,950 なので、実用上ぶつかるのは
/// 「大人数 × 数年先まで」という現実味の薄い組み合わせだけ。
pub const MAX_MEMBER_DAYS: usize = 40_000;

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
    /// 人員の指定が不正 (0 人、上限超え、人員 × 日数が大きすぎる)。
    BadMembers = 8,
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

/// 1 タスクぶんの入力 (見積もり・実績・担当者)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TaskInput {
    pub min: f64,
    pub likely: f64,
    pub max: f64,
    pub start_day: Option<i64>,
    /// 進捗率 `0.0..=1.0`。
    pub progress: f64,
    pub end_day: Option<i64>,
    /// 担当する人員の添字。
    pub assignee: usize,
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
            assignee: 0,
        }
    }

    /// 担当者を指定する。
    pub fn assigned_to(mut self, member: usize) -> Self {
        self.assignee = member;
        self
    }
}

/// 予定に参加する人員。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventMember {
    pub event: usize,
    pub member: usize,
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
    pub use_japanese_holidays: bool,
    pub today_day: i64,
    pub tasks: Vec<TaskInput>,
    pub members: Vec<MemberSchedule>,
    pub events: Vec<CalendarEvent>,
    pub event_members: Vec<EventMember>,
    /// 休みにした回。`(予定の添字, 回の初日)`。
    pub event_exceptions: Vec<EventException>,
    pub forced_workdays: Vec<i64>,
}

/// 繰り返しのうち、休みにした 1 回。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventException {
    pub event: usize,
    /// その回の初日 (1970-01-01 からの日数)。
    pub day: i64,
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
                hours_per_person_day: 8.0,
            },
            use_japanese_holidays: true,
            today_day: 20_716,
            tasks: Vec::new(),
            members: vec![MemberSchedule::default()],
            events: Vec::new(),
            event_members: Vec::new(),
            event_exceptions: Vec::new(),
            forced_workdays: Vec::new(),
        }
    }
}

/// 未入力を表す `NaN` と数値の相互変換。
fn optional_to_f64<T: Into<f64>>(value: Option<T>) -> f64 {
    value.map(Into::into).unwrap_or(f64::NAN)
}

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

fn f64_to_minute(value: f64) -> Option<i32> {
    if value.is_finite() {
        Some(value as i32)
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
        out[16] = self.members.len() as f64;
        out[17] = self.calendar.hours_per_person_day;
        out[18] = self.event_members.len() as f64;
        out[19] = f64::from(self.use_japanese_holidays);
        out[20] = self.today_day as f64;
        out[21] = self.event_exceptions.len() as f64;

        for task in &self.tasks {
            out.extend_from_slice(&[
                task.min,
                task.likely,
                task.max,
                day_to_f64(task.start_day),
                task.progress,
                day_to_f64(task.end_day),
                task.assignee as f64,
            ]);
        }
        for member in &self.members {
            out.extend(member.starts().iter().map(|&m| m as f64));
            out.extend(member.ends().iter().map(|&m| m as f64));
            out.push(f64::from(member.break_minutes()));
        }
        for event in &self.events {
            out.extend_from_slice(&[
                event.start_day as f64,
                event.end_day as f64,
                optional_to_f64(event.start_minute),
                optional_to_f64(event.end_minute),
                f64::from(event.repeat_weeks),
                day_to_f64(event.until_day),
            ]);
        }
        for link in &self.event_members {
            out.extend_from_slice(&[link.event as f64, link.member as f64]);
        }
        for skip in &self.event_exceptions {
            out.extend_from_slice(&[skip.event as f64, skip.day as f64]);
        }
        for &day in &self.forced_workdays {
            out.push(day as f64);
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
        let n_members = as_index(buf[16]).ok_or((Status::BadMembers, buf[16]))?;
        let n_event_members = as_index(buf[18]).ok_or((Status::BadCalendar, buf[18]))?;
        let n_exceptions = as_index(buf[21]).ok_or((Status::BadCalendar, buf[21]))?;

        if n_tasks == 0 || n_tasks > MAX_TASKS {
            return Err((Status::BadTaskCount, n_tasks as f64));
        }
        if n_members == 0 || n_members > MAX_MEMBERS {
            return Err((Status::BadMembers, n_members as f64));
        }
        if n_events > MAX_EVENTS
            || n_forced > MAX_FORCED_WORKDAYS
            || n_event_members > MAX_EVENT_MEMBERS
            || n_exceptions > MAX_EVENT_EXCEPTIONS
        {
            return Err((Status::BadCalendar, 0.0));
        }

        let tasks_at = REQ_HEADER;
        let members_at = tasks_at + n_tasks * REQ_TASK_STRIDE;
        let events_at = members_at + n_members * REQ_MEMBER_STRIDE;
        let links_at = events_at + n_events * REQ_EVENT_STRIDE;
        let skips_at = links_at + n_event_members * REQ_EVENT_MEMBER_STRIDE;
        let forced_at = skips_at + n_exceptions * REQ_EVENT_EXCEPTION_STRIDE;
        if buf.len() < forced_at + n_forced {
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
        if horizon > MAX_HORIZON {
            return Err((Status::BadCalendar, horizon as f64));
        }
        if n_members.saturating_mul(horizon) > MAX_MEMBER_DAYS {
            return Err((Status::BadMembers, (n_members * horizon) as f64));
        }
        let start_day = f64_to_day(buf[14]).ok_or((Status::BadCalendar, buf[14]))?;
        if !buf[17].is_finite() || buf[17] <= 0.0 {
            return Err((Status::BadCalendar, buf[17]));
        }

        let calendar = CalendarConfig {
            start_day,
            horizon_days: horizon,
            hours_per_person_day: buf[17],
        };

        let mut tasks = Vec::with_capacity(n_tasks);
        for i in 0..n_tasks {
            let at = tasks_at + i * REQ_TASK_STRIDE;
            let assignee = as_index(buf[at + 6]).unwrap_or(0);
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
                // 存在しない人員を指していたら先頭に倒す。
                assignee: if assignee < n_members { assignee } else { 0 },
            });
        }

        let mut members = Vec::with_capacity(n_members);
        for i in 0..n_members {
            let at = members_at + i * REQ_MEMBER_STRIDE;
            let mut start = [0i32; 7];
            let mut end = [0i32; 7];
            for weekday in 0..7 {
                start[weekday] = buf[at + weekday] as i32;
                end[weekday] = buf[at + 7 + weekday] as i32;
            }
            let break_minutes = if buf[at + 14].is_finite() {
                buf[at + 14] as i32
            } else {
                0
            };
            members.push(MemberSchedule::with_break(start, end, break_minutes));
        }

        // 休みにした回を先に集める。予定ごとに昇順で持たせたいので、
        // 予定を組み立てるより前に読む。
        let mut event_exceptions = Vec::with_capacity(n_exceptions);
        let mut skipped_per_event: Vec<Vec<i64>> = vec![Vec::new(); n_events];
        for i in 0..n_exceptions {
            let at = skips_at + i * REQ_EVENT_EXCEPTION_STRIDE;
            let (Some(event), Some(day)) = (as_index(buf[at]), f64_to_day(buf[at + 1])) else {
                continue;
            };
            if event < n_events {
                event_exceptions.push(EventException { event, day });
                skipped_per_event[event].push(day);
            }
        }
        for list in &mut skipped_per_event {
            list.sort_unstable();
            list.dedup();
        }

        let mut events = Vec::with_capacity(n_events);
        for (i, skipped) in skipped_per_event.into_iter().enumerate() {
            let at = events_at + i * REQ_EVENT_STRIDE;
            let (Some(from), Some(to)) = (f64_to_day(buf[at]), f64_to_day(buf[at + 1])) else {
                return Err((Status::BadCalendar, i as f64));
            };
            events.push(CalendarEvent {
                start_day: from,
                end_day: to.max(from),
                start_minute: f64_to_minute(buf[at + 2]),
                end_minute: f64_to_minute(buf[at + 3]),
                repeat_weeks: as_index(buf[at + 4]).unwrap_or(0).min(52) as u32,
                until_day: f64_to_day(buf[at + 5]),
                excluded_days: skipped,
            });
        }

        let mut event_members = Vec::with_capacity(n_event_members);
        for i in 0..n_event_members {
            let at = links_at + i * REQ_EVENT_MEMBER_STRIDE;
            let (Some(event), Some(member)) = (as_index(buf[at]), as_index(buf[at + 1])) else {
                continue;
            };
            if event < n_events && member < n_members {
                event_members.push(EventMember { event, member });
            }
        }

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
            use_japanese_holidays: buf[19] != 0.0,
            today_day: f64_to_day(buf[20]).unwrap_or(start_day),
            tasks,
            members,
            events,
            event_members,
            event_exceptions,
            forced_workdays,
        })
    }

    /// 人員ごとの予定を集める。予定は複数人で共有されうるので、
    /// 1 件が複数の人員のリストに入ることがある。
    fn events_per_member(&self) -> Vec<Vec<CalendarEvent>> {
        let mut per_member = vec![Vec::new(); self.members.len()];
        for link in &self.event_members {
            if let (Some(event), Some(list)) =
                (self.events.get(link.event), per_member.get_mut(link.member))
            {
                list.push(event.clone());
            }
        }
        per_member
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
    for (i, task) in request.tasks.iter().enumerate() {
        match TaskEstimate::new(task.min, task.likely, task.max) {
            Ok(e) => originals.push(e),
            Err(_) => return error_response(Status::InvalidEstimate, i as f64),
        }
    }

    // --- 人員ごとにカレンダーを組み立てる
    let holidays = if request.use_japanese_holidays {
        japanese_holidays_for(request.calendar.start_day, request.calendar.horizon_days)
    } else {
        Vec::new()
    };
    let per_member_events = request.events_per_member();
    let calendars: Vec<Calendar> = request
        .members
        .iter()
        .zip(&per_member_events)
        .map(|(schedule, events)| {
            Calendar::build(
                &request.calendar,
                schedule,
                events,
                &request.forced_workdays,
                &holidays,
            )
        })
        .collect();

    // --- 実績を織り込む。消化工数は担当者のカレンダーで測る。
    let forecasts: Vec<_> = originals
        .iter()
        .zip(&request.tasks)
        .map(|(&original, input)| {
            let actual = Actual {
                start_day: input.start_day,
                progress: input.progress,
                end_day: input.end_day,
            };
            let calendar = calendars
                .get(input.assignee)
                .unwrap_or_else(|| &calendars[0]);
            // 消化工数が測れないときの目安に、当初見積もりの期待値を渡す。
            let planned = Sampler::new(original, request.kind, request.lambda).mean();
            actuals::forecast(original, planned, &actual, calendar, request.today_day)
        })
        .collect();

    let total_min: f64 = forecasts.iter().map(|f| f.estimate.min()).sum();
    let total_likely: f64 = forecasts.iter().map(|f| f.estimate.likely()).sum();
    let total_max: f64 = forecasts.iter().map(|f| f.estimate.max()).sum();
    let total_spent: f64 = forecasts.iter().map(|f| f.spent).sum();

    // 標本を引くのは**残り**の工数。すでに終えたぶんをもう一度これからの
    // 稼働で賄うことにならないよう、日程が消化するのはこちら。
    // 総工数の分布は、あとで消化ぶんだけ平行移動して出す (定数のずれなので
    // 形は変わらない)。
    let samplers: Vec<Sampler> = forecasts
        .iter()
        .map(|f| Sampler::new(f.remaining, request.kind, request.lambda))
        .collect();

    // --- 担当者ごとの累積和グリッドの上限
    let assignees: Vec<usize> = request.tasks.iter().map(|t| t.assignee).collect();
    let mut member_grid_hi = vec![0.0; request.members.len()];
    for (index, forecast) in forecasts.iter().enumerate() {
        if let Some(slot) = member_grid_hi.get_mut(assignees[index]) {
            *slot += forecast.remaining.max();
        }
    }
    let assignment = Assignment {
        members: &assignees,
        grid_hi: &member_grid_hi,
    };

    // --- 分布を求める
    let spec = PrefixSpec {
        bins: request.prefix_bins,
    };
    let output = match request.engine {
        Engine::MonteCarlo => montecarlo::run(
            &samplers,
            request.iterations,
            request.seed,
            spec,
            &assignment,
        ),
        Engine::Convolution => convolve::run(&samplers, request.grid_points, spec, &assignment),
    };
    let summary = stats::summarize(&output.total, request.n_bins);

    // 感度 = そのタスクの分散が総分散に占める割合。タスクは独立なので
    // 分散は単純に足し合わせでき、この比がそのまま「総工数のばらつきへの寄与」になる。
    let total_variance: f64 = samplers.iter().map(|s| s.variance()).sum();

    // --- レスポンスを組み立てる
    let n_tasks = request.tasks.len();
    let n_members = request.members.len();
    let n_pct = PCT_LEVELS.len();
    let n_days = calendars.first().map(Calendar::len).unwrap_or(0);
    let prefix_width = output.prefix.width();
    let offsets = response_offsets(
        request.n_bins,
        n_pct,
        n_tasks,
        prefix_width,
        n_members,
        n_days,
    );

    let mut out = vec![0.0; RESP_HEADER];
    out[0] = Status::Ok as u8 as f64;
    out[1] = VERSION;
    out[2] = request.n_bins as f64;
    out[3] = n_pct as f64;
    out[4] = n_tasks as f64;
    // 分布は「残り」で求めてあるので、消化ぶんだけずらして総工数にする。
    // ずれは定数なので、ばらつき (sd) と形 (probs / cdf) はそのまま使える。
    out[6] = summary.mean + total_spent;
    out[7] = summary.sd;
    out[8] = summary.lo + total_spent;
    out[9] = summary.hi + total_spent;
    out[10] = total_min;
    out[11] = total_likely;
    out[12] = total_max;
    out[13] = if prefix_width > 0 {
        request.prefix_bins as f64
    } else {
        0.0
    };
    out[14] = n_days as f64;
    out[15] = request.calendar.start_day as f64;
    out[16] = total_spent;
    out[17] = n_members as f64;
    out[18] = calendars.iter().map(Calendar::total_capacity).sum();

    out.reserve(offsets[LAST_OFFSET] - RESP_HEADER);
    out.extend_from_slice(&summary.probs);
    out.extend_from_slice(&summary.cdf);
    out.extend_from_slice(&PCT_LEVELS);
    out.extend(summary.percentiles.iter().map(|value| value + total_spent));
    out.extend(samplers.iter().map(|s| {
        if total_variance > 0.0 {
            s.variance() / total_variance
        } else {
            0.0
        }
    }));
    for forecast in &forecasts {
        out.extend_from_slice(&[
            forecast.estimate.min(),
            forecast.estimate.likely(),
            forecast.estimate.max(),
        ]);
    }
    out.extend(forecasts.iter().map(|f| f.spent));
    out.extend(forecasts.iter().map(|f| f.state.code()));
    out.extend(assignees.iter().map(|&m| m as f64));
    out.extend_from_slice(output.prefix.as_slice());
    out.extend_from_slice(&member_grid_hi);
    for calendar in &calendars {
        out.extend_from_slice(calendar.capacity());
    }
    for calendar in &calendars {
        out.extend_from_slice(calendar.cumulative());
    }
    for calendar in &calendars {
        out.extend(calendar.flags().iter().map(|&f| f64::from(f)));
    }
    out
}

/// [`response_offsets`] が返す配列の、末尾 (= 全体の長さ) の位置。
pub const LAST_OFFSET: usize = 14;

/// レスポンス本体の各区画がどこから始まるかを数える。JS 側の読み取りと対応する。
///
/// 返り値の最後の要素はバッファ全体の長さ。
pub fn response_offsets(
    n_bins: usize,
    n_pct: usize,
    n_tasks: usize,
    prefix_width: usize,
    n_members: usize,
    n_days: usize,
) -> [usize; 15] {
    let mut at = RESP_HEADER;
    let mut offsets = [0usize; 15];
    for (slot, len) in offsets.iter_mut().zip([
        n_bins,                 // bin_probs
        n_bins + 1,             // cdf
        n_pct,                  // percentile_levels
        n_pct,                  // percentile_values
        n_tasks,                // sensitivity
        n_tasks * 3,            // effective
        n_tasks,                // spent
        n_tasks,                // state
        n_tasks,                // assignee
        n_tasks * prefix_width, // prefix_cdf
        n_members,              // member_grid_hi
        n_members * n_days,     // member_capacity
        n_members * n_days,     // member_cumulative
        n_members * n_days,     // member_flags
        0,                      // 末尾 (= 全体の長さ)
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
    use crate::calendar::{FLAG_EVENT, FLAG_FORCED_WORKDAY, FLAG_HOLIDAY};
    use crate::date::days_from_civil;

    const TASKS: [(f64, f64, f64); 3] = [(5.0, 8.0, 20.0), (2.0, 3.0, 5.0), (10.0, 15.0, 40.0)];

    /// 2026-09-21 (月)。
    fn monday() -> i64 {
        days_from_civil(2026, 9, 21)
    }

    /// 月〜金 9:00〜17:00 (= 1 人日/日)。
    fn eight_hour_weekdays() -> MemberSchedule {
        let mut start = [0; 7];
        let mut end = [0; 7];
        for weekday in 1..=5 {
            start[weekday] = 9 * 60;
            end[weekday] = 17 * 60;
        }
        MemberSchedule::new(start, end)
    }

    fn request(engine: Engine) -> Request {
        Request {
            engine,
            iterations: 50_000,
            n_bins: 40,
            calendar: CalendarConfig {
                start_day: monday(),
                horizon_days: 180,
                hours_per_person_day: 8.0,
            },
            use_japanese_holidays: false,
            today_day: monday(),
            members: vec![eight_hour_weekdays()],
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
        offsets: [usize; 15],
        n_bins: usize,
        n_tasks: usize,
        n_members: usize,
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
            let n_days = raw[14] as usize;
            let n_members = raw[17] as usize;
            Self {
                raw,
                offsets: response_offsets(n_bins, n_pct, n_tasks, prefix_width, n_members, n_days),
                n_bins,
                n_tasks,
                n_members,
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
            let all = self.section(5, self.n_tasks * 3);
            (all[task * 3], all[task * 3 + 1], all[task * 3 + 2])
        }
        fn spent(&self) -> &[f64] {
            self.section(6, self.n_tasks)
        }
        fn states(&self) -> &[f64] {
            self.section(7, self.n_tasks)
        }
        fn assignees(&self) -> &[f64] {
            self.section(8, self.n_tasks)
        }
        fn prefix(&self, task: usize) -> &[f64] {
            let all = self.section(9, self.n_tasks * self.prefix_width);
            &all[task * self.prefix_width..(task + 1) * self.prefix_width]
        }
        fn member_grid_hi(&self) -> &[f64] {
            self.section(10, self.n_members)
        }
        fn capacity(&self, member: usize) -> &[f64] {
            let all = self.section(11, self.n_members * self.n_days);
            &all[member * self.n_days..(member + 1) * self.n_days]
        }
        fn cumulative(&self, member: usize) -> &[f64] {
            let all = self.section(12, self.n_members * self.n_days);
            &all[member * self.n_days..(member + 1) * self.n_days]
        }
        fn flags(&self, member: usize) -> &[f64] {
            let all = self.section(13, self.n_members * self.n_days);
            &all[member * self.n_days..(member + 1) * self.n_days]
        }
        /// ヘッダの宣言どおりに読み切れること。JS が範囲外を読まないための最重要不変条件。
        fn assert_consistent(&self) {
            assert_eq!(
                self.raw.len(),
                self.offsets[LAST_OFFSET],
                "宣言長とバッファ長が一致しない"
            );
        }
        fn p80(&self) -> f64 {
            self.percentiles()[4]
        }
    }

    #[test]
    fn a_skipped_occurrence_survives_the_round_trip() {
        // 休みにした回は `[予定の添字, 回の初日]` の組で運ばれ、
        // 読み取り側で予定ごとの昇順の一覧に組み直される。
        let mut r = request(Engine::Convolution);
        r.members = vec![eight_hour_weekdays()];
        r.events = vec![CalendarEvent {
            start_day: monday(),
            end_day: monday(),
            start_minute: None,
            end_minute: None,
            repeat_weeks: 1,
            until_day: None,
            excluded_days: Vec::new(),
        }];
        // わざと降順・重複つきで渡す。
        r.event_exceptions = vec![
            EventException {
                event: 0,
                day: monday() + 14,
            },
            EventException {
                event: 0,
                day: monday() + 7,
            },
            EventException {
                event: 0,
                day: monday() + 7,
            },
        ];

        let back = Request::decode(&r.encode()).expect("読める");
        assert_eq!(
            back.events[0].excluded_days,
            vec![monday() + 7, monday() + 14],
            "昇順に整えて重複を畳む (二分探索で引くため)"
        );
    }

    #[test]
    fn a_skip_pointing_at_no_event_is_dropped() {
        let mut r = request(Engine::Convolution);
        r.members = vec![eight_hour_weekdays()];
        r.events = vec![CalendarEvent::all_day(monday(), monday())];
        r.event_exceptions = vec![EventException {
            event: 9,
            day: monday(),
        }];

        let back = Request::decode(&r.encode()).expect("読める");
        assert!(back.event_exceptions.is_empty(), "行き先の無い指定は落とす");
        assert!(back.events[0].excluded_days.is_empty());
    }

    #[test]
    fn encoding_a_request_round_trips() {
        let mut r = request(Engine::Convolution);
        r.kind = DistKind::Triangular;
        r.members = vec![eight_hour_weekdays(), MemberSchedule::default()];
        r.events = vec![
            CalendarEvent::all_day(monday() + 3, monday() + 4),
            CalendarEvent {
                start_day: monday() + 1,
                end_day: monday() + 1,
                start_minute: Some(10 * 60 + 5),
                end_minute: Some(10 * 60 + 50),
                repeat_weeks: 2,
                until_day: Some(monday() + 60),
                excluded_days: vec![monday() + 15],
            },
        ];
        r.event_exceptions = vec![EventException {
            event: 1,
            day: monday() + 15,
        }];
        r.event_members = vec![
            EventMember {
                event: 0,
                member: 0,
            },
            EventMember {
                event: 1,
                member: 0,
            },
            EventMember {
                event: 1,
                member: 1,
            },
        ];
        r.forced_workdays = vec![monday() + 5, monday() + 12];
        r.tasks[1].start_day = Some(monday());
        r.tasks[1].progress = 0.4;
        r.tasks[1].assignee = 1;
        r.tasks[2].start_day = Some(monday() + 1);
        r.tasks[2].end_day = Some(monday() + 7);

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
            assert_eq!(resp.assignees(), &[0.0; 3]);
            assert_eq!(resp.member_grid_hi(), &[65.0]);
        }
    }

    #[test]
    fn the_response_layout_holds_across_parameter_ranges() {
        for (n_bins, prefix_bins, horizon, members) in [
            (MIN_BINS, 0, 0, 1),
            (17, 64, 30, 3),
            (MAX_BINS, 256, 365, 2),
            (64, MAX_PREFIX_BINS, 1, 1),
        ] {
            let mut r = request(Engine::Convolution);
            r.n_bins = n_bins;
            r.prefix_bins = prefix_bins;
            r.calendar.horizon_days = horizon;
            r.members = vec![eight_hour_weekdays(); members];
            let raw = handle(&r.encode());
            assert_eq!(raw[0], Status::Ok as u8 as f64, "bins={n_bins}");
            Response::parse(&raw).assert_consistent();
        }
    }

    /// 担当者を分けると、それぞれのカレンダーで並行して進む。
    #[test]
    fn tasks_assigned_to_different_members_run_in_parallel() {
        let mut r = request(Engine::Convolution);
        r.members = vec![eight_hour_weekdays(), eight_hour_weekdays()];
        r.tasks = vec![
            TaskInput::estimate_only(5.0, 5.0, 5.0).assigned_to(0),
            TaskInput::estimate_only(5.0, 5.0, 5.0).assigned_to(1),
        ];
        r.calendar.horizon_days = 30;

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        resp.assert_consistent();
        assert_eq!(resp.member_grid_hi(), &[5.0, 5.0], "担当ぶんだけを持つ");

        // どちらも 5 人日なので、5 稼働日後にそれぞれ完了する。
        // 累積和はタスクごとに 5 人日で 1 に達する (直列に 10 人日にはならない)。
        let step = 5.0 / r.prefix_bins as f64;
        let at_five = (5.0 / step).round() as usize;
        for task in 0..2 {
            let row = resp.prefix(task);
            assert!(
                row[at_five - 1] < 0.5,
                "タスク {task}: 5 人日未満では終わらない"
            );
            assert!(row[at_five] > 0.99, "タスク {task}: 5 人日で完了する");
        }
    }

    /// 同じ人に積むと直列になる。
    #[test]
    fn tasks_on_the_same_member_queue_up() {
        let mut r = request(Engine::Convolution);
        r.members = vec![eight_hour_weekdays(), eight_hour_weekdays()];
        r.tasks = vec![
            TaskInput::estimate_only(5.0, 5.0, 5.0).assigned_to(0),
            TaskInput::estimate_only(5.0, 5.0, 5.0).assigned_to(0),
        ];
        r.calendar.horizon_days = 30;

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        assert_eq!(resp.member_grid_hi(), &[10.0, 0.0]);

        let step = 10.0 / r.prefix_bins as f64;
        let at = |effort: f64| (effort / step).round() as usize;
        assert!(resp.prefix(0)[at(5.0)] > 0.99, "1 件目は 5 人日で完了");
        assert!(
            resp.prefix(1)[at(5.0)] < 0.01,
            "2 件目は 5 人日では終わらない"
        );
        assert!(resp.prefix(1)[at(10.0)] > 0.99, "2 件目は 10 人日で完了");
    }

    #[test]
    fn each_member_gets_their_own_calendar() {
        let mut r = request(Engine::Convolution);
        r.calendar.horizon_days = 7;
        // 2 人目は午前中だけ働く。
        let mut start = [0; 7];
        let mut end = [0; 7];
        for weekday in 1..=5 {
            start[weekday] = 9 * 60;
            end[weekday] = 13 * 60;
        }
        r.members = vec![eight_hour_weekdays(), MemberSchedule::new(start, end)];

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        resp.assert_consistent();
        assert_eq!(resp.capacity(0)[0], 1.0);
        assert_eq!(resp.capacity(1)[0], 0.5, "半日だけ");
        assert_eq!(*resp.cumulative(0).last().unwrap(), 5.0);
        assert_eq!(*resp.cumulative(1).last().unwrap(), 2.5);
        assert!((raw[18] - 7.5).abs() < 1e-12, "全員ぶんの合計");
    }

    #[test]
    fn a_shared_event_takes_time_from_every_participant() {
        let mut r = request(Engine::Convolution);
        r.calendar.horizon_days = 7;
        r.members = vec![
            eight_hour_weekdays(),
            eight_hour_weekdays(),
            eight_hour_weekdays(),
        ];
        // 1 時間の定例に 0 番と 2 番だけ出る。
        r.events = vec![CalendarEvent {
            start_day: monday(),
            end_day: monday(),
            start_minute: Some(10 * 60),
            end_minute: Some(11 * 60),
            repeat_weeks: 0,
            until_day: None,
            excluded_days: Vec::new(),
        }];
        r.event_members = vec![
            EventMember {
                event: 0,
                member: 0,
            },
            EventMember {
                event: 0,
                member: 2,
            },
        ];

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        assert!((resp.capacity(0)[0] - 7.0 / 8.0).abs() < 1e-12);
        assert_eq!(resp.capacity(1)[0], 1.0, "参加していない人は削られない");
        assert!((resp.capacity(2)[0] - 7.0 / 8.0).abs() < 1e-12);
        assert_eq!(resp.flags(0)[0] as u8 & FLAG_EVENT, FLAG_EVENT);
        assert_eq!(resp.flags(1)[0] as u8 & FLAG_EVENT, 0);
    }

    #[test]
    fn a_biweekly_event_only_hits_every_other_week() {
        let mut r = request(Engine::Convolution);
        r.calendar.horizon_days = 28;
        r.events = vec![CalendarEvent {
            start_day: monday(),
            end_day: monday(),
            start_minute: Some(9 * 60),
            end_minute: Some(11 * 60),
            repeat_weeks: 2,
            until_day: None,
            excluded_days: Vec::new(),
        }];
        r.event_members = vec![EventMember {
            event: 0,
            member: 0,
        }];

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        for week in 0..4 {
            let index = week * 7;
            let expected = if week % 2 == 0 { 6.0 / 8.0 } else { 1.0 };
            assert!(
                (resp.capacity(0)[index] - expected).abs() < 1e-12,
                "{week} 週目"
            );
        }
    }

    #[test]
    fn five_minute_events_are_honoured() {
        let mut r = request(Engine::Convolution);
        r.calendar.horizon_days = 3;
        r.events = vec![CalendarEvent {
            start_day: monday(),
            end_day: monday(),
            start_minute: Some(9 * 60 + 55),
            end_minute: Some(10 * 60),
            repeat_weeks: 0,
            until_day: None,
            excluded_days: Vec::new(),
        }];
        r.event_members = vec![EventMember {
            event: 0,
            member: 0,
        }];

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        // 8 時間のうち 5 分だけ失われる。
        assert!((resp.capacity(0)[0] - 475.0 / 480.0).abs() < 1e-12);
    }

    #[test]
    fn the_calendar_comes_back_with_capacity_and_flags() {
        let mut r = request(Engine::Convolution);
        r.calendar.horizon_days = 14;
        r.use_japanese_holidays = true;
        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        resp.assert_consistent();

        assert_eq!(resp.capacity(0).len(), 14);
        assert_eq!(raw[15], monday() as f64, "カレンダーの開始日");
        // 2026-09-21 は敬老の日、22 は国民の休日、23 は秋分の日。
        assert_eq!(&resp.capacity(0)[0..3], &[0.0; 3]);
        assert_eq!(resp.flags(0)[0] as u8 & FLAG_HOLIDAY, FLAG_HOLIDAY);
        assert!(resp.cumulative(0).windows(2).all(|w| w[1] >= w[0]));
    }

    #[test]
    fn a_forced_workday_applies_to_everyone() {
        let mut r = request(Engine::Convolution);
        r.calendar.horizon_days = 14;
        r.members = vec![eight_hour_weekdays(), eight_hour_weekdays()];
        r.forced_workdays = vec![monday() + 5]; // 土曜

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        for member in 0..2 {
            assert_eq!(resp.capacity(member)[5], 1.0, "{member} 人目");
            assert_eq!(
                resp.flags(member)[5] as u8 & FLAG_FORCED_WORKDAY,
                FLAG_FORCED_WORKDAY
            );
        }
    }

    #[test]
    fn spent_effort_is_measured_on_the_assignee_calendar() {
        let mut r = request(Engine::Convolution);
        // 2 人目は半日勤務。
        let mut start = [0; 7];
        let mut end = [0; 7];
        for weekday in 1..=5 {
            start[weekday] = 9 * 60;
            end[weekday] = 13 * 60;
        }
        r.members = vec![eight_hour_weekdays(), MemberSchedule::new(start, end)];
        r.tasks = vec![
            TaskInput {
                start_day: Some(monday()),
                end_day: Some(monday() + 4),
                progress: 1.0,
                ..TaskInput::estimate_only(5.0, 8.0, 20.0)
            },
            TaskInput {
                start_day: Some(monday()),
                end_day: Some(monday() + 4),
                progress: 1.0,
                ..TaskInput::estimate_only(5.0, 8.0, 20.0)
            }
            .assigned_to(1),
        ];
        r.today_day = monday() + 10;

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        assert_eq!(resp.spent()[0], 5.0, "フルタイムの人は 5 人日");
        assert_eq!(resp.spent()[1], 2.5, "半日勤務の人は 2.5 人日");
        assert_eq!(resp.effective(1), (2.5, 2.5, 2.5));
        assert_eq!(resp.states(), &[2.0, 2.0]);
        assert_eq!(raw[16], 7.5, "消化済み工数の合計");
    }

    #[test]
    fn progress_shortens_the_schedule_without_changing_the_total() {
        // 着手日を入れずに進捗率だけを入れた場合。消化工数は測れないので
        // 予定どおり進んだとみなす。総工数は動かず、残りだけが減る。
        let measure = |progress: f64| {
            let mut r = request(Engine::Convolution);
            r.members = vec![eight_hour_weekdays()];
            r.tasks = vec![TaskInput {
                progress,
                ..TaskInput::estimate_only(10.0, 10.0, 10.0)
            }];
            let raw = handle(&r.encode());
            let resp = Response::parse(&raw);
            // 残り = 担当者の累積和グリッドの上限。日程が消化するのはここ。
            (
                resp.percentiles()[4],
                resp.member_grid_hi()[0],
                resp.spent()[0],
            )
        };

        let (fresh_p80, fresh_remaining, fresh_spent) = measure(0.0);
        let (half_p80, half_remaining, half_spent) = measure(0.5);

        assert_eq!(fresh_remaining, 10.0, "手つかずなら 10 人日ぶん残っている");
        assert_eq!(half_remaining, 5.0, "半分終わっていれば残りは 5 人日");
        assert_eq!(fresh_spent, 0.0);
        assert_eq!(half_spent, 5.0, "測れないので予定どおり進んだとみなす");
        assert!(
            (half_p80 - fresh_p80).abs() < 1e-9,
            "総工数は動かない: {fresh_p80} → {half_p80}"
        );
    }

    #[test]
    fn falling_behind_shows_up_as_more_total_effort() {
        // 5 日かけて 25% しか進んでいない = 当初の見立てより重い仕事だった。
        // 総工数は増え、それでも残りは当初の 3/4 に減る。
        let mut r = request(Engine::Convolution);
        r.members = vec![eight_hour_weekdays()];
        r.tasks = vec![TaskInput {
            start_day: Some(monday()),
            progress: 0.25,
            ..TaskInput::estimate_only(8.0, 8.0, 8.0)
        }];
        r.today_day = monday() + 4;

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        assert_eq!(resp.spent()[0], 5.0, "月曜から金曜まで 5 人日");
        assert_eq!(resp.member_grid_hi()[0], 6.0, "残りは 8 の 3/4");
        assert!(
            (resp.percentiles()[4] - 11.0).abs() < 1e-9,
            "総工数は 5 + 6 = 11 人日 (当初の 8 より重い)"
        );
    }

    #[test]
    fn a_finished_task_asks_nothing_more_of_the_calendar() {
        let mut r = request(Engine::Convolution);
        r.members = vec![eight_hour_weekdays()];
        r.tasks = vec![TaskInput {
            start_day: Some(monday()),
            end_day: Some(monday() + 4),
            progress: 1.0,
            ..TaskInput::estimate_only(5.0, 8.0, 20.0)
        }];
        r.today_day = monday() + 10;

        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        assert_eq!(
            resp.member_grid_hi()[0],
            0.0,
            "終わった仕事をこれからの稼働で賄ってはいけない"
        );
        // 総工数のほうは、実際にかかったぶんとして残る。
        assert_eq!(raw[16], 5.0, "消化済み工数");
        assert!((resp.percentiles()[4] - 5.0).abs() < 1e-9);
    }

    #[test]
    fn prefix_distributions_are_returned_per_task() {
        for engine in [Engine::MonteCarlo, Engine::Convolution] {
            let raw = handle(&request(engine).encode());
            let resp = Response::parse(&raw);
            resp.assert_consistent();
            assert_eq!(resp.prefix_width, 257);

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
    fn both_engines_agree_on_the_per_member_prefixes() {
        let mut r = request(Engine::MonteCarlo);
        r.members = vec![eight_hour_weekdays(), eight_hour_weekdays()];
        r.tasks = vec![
            TaskInput::estimate_only(5.0, 8.0, 20.0).assigned_to(0),
            TaskInput::estimate_only(2.0, 3.0, 5.0).assigned_to(1),
            TaskInput::estimate_only(10.0, 15.0, 40.0).assigned_to(0),
            TaskInput::estimate_only(1.0, 4.0, 9.0).assigned_to(1),
        ];
        r.iterations = 400_000;
        let monte_carlo = handle(&r.encode());

        r.engine = Engine::Convolution;
        r.grid_points = 4_096;
        let convolution = handle(&r.encode());

        let a = Response::parse(&monte_carlo);
        let b = Response::parse(&convolution);
        assert_eq!(a.member_grid_hi(), &[60.0, 14.0]);
        for task in 0..4 {
            for (k, (&x, &y)) in a.prefix(task).iter().zip(b.prefix(task)).enumerate() {
                assert!(
                    (x - y).abs() < 0.02,
                    "タスク {task} の k={k} で {x} と {y} が一致しない"
                );
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
    fn member_count_must_be_sane() {
        for value in [0.0, -1.0, f64::NAN, (MAX_MEMBERS + 1) as f64] {
            let mut raw = request(Engine::MonteCarlo).encode();
            raw[16] = value;
            assert_eq!(
                handle(&raw)[0],
                Status::BadMembers as u8 as f64,
                "n_members = {value} が弾かれていない"
            );
        }

        // 人員 × 日数が大きすぎる組み合わせも弾く。
        let mut r = request(Engine::MonteCarlo);
        r.members = vec![eight_hour_weekdays(); MAX_MEMBERS];
        r.calendar.horizon_days = MAX_HORIZON;
        assert_eq!(handle(&r.encode())[0], Status::BadMembers as u8 as f64);
    }

    #[test]
    fn an_assignee_outside_the_member_list_falls_back_to_the_first() {
        let mut r = request(Engine::Convolution);
        r.tasks[0].assignee = 7;
        let raw = handle(&r.encode());
        let resp = Response::parse(&raw);
        assert_eq!(raw[0], Status::Ok as u8 as f64);
        assert_eq!(resp.assignees()[0], 0.0);
    }

    #[test]
    fn out_of_range_parameters_are_rejected() {
        for (index, value) in [
            (6, 0.0),
            (6, (MAX_ITERATIONS + 1) as f64),
            (6, f64::NAN),
            (8, 1.0),
            (8, (MAX_BINS + 1) as f64),
            (9, 1.0),
            (9, (MAX_GRID + 1) as f64),
            (11, (MAX_PREFIX_BINS + 1) as f64),
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
            (15, (MAX_HORIZON + 1) as f64),
            (15, -1.0),
            (17, f64::NAN),
            (17, 0.0),
            (17, -8.0),
            (12, (MAX_EVENTS + 1) as f64),
            (18, (MAX_EVENT_MEMBERS + 1) as f64),
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
        assert_eq!(raw[14], 0.0, "n_days は 0");
        assert_eq!(raw[17], 0.0, "n_members は 0");
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
}
