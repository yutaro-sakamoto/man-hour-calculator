/** 日英の文言辞書。キーは flat で、`{name}` を第 2 引数で埋める。 */

import type { Lang } from "./format.ts";

const ja = {
  "app.title": "工数見積もり",
  "app.tagline": "3 点見積もりから総工数の確率分布と完了日を求めます",
  "lang.ja": "日本語",
  "lang.en": "English",

  "file.menu": "ファイル",
  "file.new": "新規",
  "file.open": "ファイルを開く…",
  "file.save": "ファイルに保存",
  "file.exportCsv": "CSV で書き出す",
  "file.importCsv": "CSV を読み込む…",
  "file.sample": "サンプルを読み込む",
  "file.projectName": "プロジェクト名",
  "file.confirmNew": "いまの内容を破棄して新規作成しますか？",
  "file.confirmImport": "いまの内容を読み込んだ内容で置き換えますか？",
  "file.badFile": "このファイルは読み込めませんでした。",
  "file.imported": "{name} を読み込みました。",
  "file.saved": "ファイルに保存しました。",
  "file.autosaved": "自動保存しました ({time})",
  "file.autosaveOff": "自動保存できません (ブラウザの保存領域が使えません)",

  "tab.tasks": "タスク",
  "tab.calendar": "カレンダー",
  "tab.distribution": "工数の分布",
  "tab.schedule": "スケジュール",

  "summary.effortP80": "総工数 P80",
  "summary.finishP80": "完了日 P80",
  "summary.finishP50": "完了日 P50",
  "summary.progress": "進捗",
  "summary.spent": "消化済み",
  "summary.remaining": "残り",
  "summary.notFinishing": "期間内に終わりません",
  "summary.noData": "—",

  "filter.heading": "絞り込み",
  "filter.text": "名前で検索",
  "filter.group": "グループ",
  "filter.priority": "優先度",
  "filter.state": "状態",
  "filter.all": "すべて",
  "filter.none": "(未分類)",
  "filter.clear": "絞り込みを解除",
  "filter.showing": "{shown} / {total} 件を表示中",
  "filter.viewOnly": "絞り込みは表示だけに効きます。計算対象は「使用」のチェックで決まります。",

  "columns.estimate": "見積もり",
  "columns.actual": "実績",
  "columns.all": "すべて",

  "tasks.heading": "タスク",
  "tasks.add": "行を追加",
  "tasks.addChild": "子タスクを追加",
  "tasks.indent": "階層を下げる",
  "tasks.outdent": "階層を上げる",
  "tasks.up": "上へ",
  "tasks.down": "下へ",
  "tasks.remove": "削除",
  "tasks.removeRow": "{name} を削除",
  "tasks.enableShown": "表示中を使用する",
  "tasks.disableShown": "表示中を除外する",
  "tasks.empty": "タスクがありません。「行を追加」か「サンプルを読み込む」から始めてください。",
  "tasks.noMatch": "絞り込みに一致するタスクがありません。",
  "tasks.untitled": "無題のタスク",
  "tasks.orderHint": "上から順に着手する前提で日付を計算します。並べ替えると完了日も変わります。",
  "tasks.rollupHint": "子を持つタスクの見積もりは配下の合計です。直接は編集できません。",
  "tasks.totals": "使用中 {count} 件 / 最小 {min} ・ 最可能 {likely} ・ 最大 {max} {unit}",
  "tasks.sortByPriority": "優先度順に並べ替え",

  "col.use": "使用",
  "col.name": "タスク名",
  "col.priority": "優先度",
  "col.group": "グループ",
  "col.min": "最小",
  "col.likely": "最可能",
  "col.max": "最大",
  "col.start": "着手日",
  "col.progress": "進捗%",
  "col.end": "完了日",
  "col.forecast": "予測工数",
  "col.spent": "消化",
  "col.state": "状態",
  "col.finish": "完了予測 (P80)",
  "col.actions": "操作",

  "priority.high": "高",
  "priority.normal": "中",
  "priority.low": "低",

  "state.notStarted": "未着手",
  "state.inProgress": "進行中",
  "state.done": "完了",

  "cal.heading": "稼働カレンダー",
  "cal.basics": "基本設定",
  "cal.start": "開始日",
  "cal.today": "基準日 (今日)",
  "cal.horizon": "計算する日数",
  "cal.workdays": "稼働曜日",
  "cal.hoursPerDay": "1 日の作業時間",
  "cal.hoursPerPersonDay": "1 人日の時間",
  "cal.teamSize": "人数",
  "cal.useHolidays": "日本の祝日を休みにする",
  "cal.capacityPerDay": "1 稼働日あたり {value} 人日",
  "cal.totalCapacity": "期間全体で {value} 人日",
  "cal.events": "予定",
  "cal.addEvent": "予定を追加",
  "cal.eventName": "内容",
  "cal.eventFrom": "開始",
  "cal.eventTo": "終了",
  "cal.eventHours": "消費時間",
  "cal.allDay": "終日",
  "cal.hoursUnit": "時間/日",
  "cal.removeEvent": "この予定を削除",
  "cal.noEvents": "予定はまだありません。会議や休暇を入れると、その分だけ日程が後ろにずれます。",
  "cal.monthView": "月表示",
  "cal.prevMonth": "前の月",
  "cal.nextMonth": "次の月",
  "cal.thisMonth": "今月",
  "cal.legendWorkday": "稼働日",
  "cal.legendWeekend": "週末",
  "cal.legendHoliday": "祝日",
  "cal.legendEvent": "予定あり",
  "cal.legendForced": "休日出勤",
  "cal.clickHint": "日付をクリックすると休日出勤の指定を切り替えられます。",
  "cal.dayCapacity": "{date}: {value} 人日",

  "results.heading": "総工数の分布",
  "results.mean": "平均",
  "results.p50": "P50 (中央値)",
  "results.p80": "P80",
  "results.p90": "P90",
  "results.sd": "標準偏差",
  "results.buffer": "P80 の上乗せ",
  "results.bufferHint": "P80 − 最可能値の合計。これがいわゆるバッファです。",
  "results.engine": "エンジン",
  "results.settings": "計算設定",

  "settings.dist": "分布",
  "settings.dist.pert": "PERT (ベータ)",
  "settings.dist.tri": "三角分布",
  "settings.lambda": "PERT の形状 λ",
  "settings.engine": "エンジン",
  "settings.engine.mc": "モンテカルロ",
  "settings.engine.conv": "数値畳み込み",
  "settings.iterations": "試行回数",
  "settings.seed": "乱数シード",
  "settings.bins": "ビン数",
  "settings.grid": "グリッド分割数",
  "settings.hint.mc": "乱数サンプリングで総和の分布を推定します。シードが同じなら結果も同じです。",
  "settings.hint.conv":
    "各タスクの分布を直接畳み込みます。乱数を使わないため完全に決定論的で、モンテカルロの答え合わせに使えます。",

  "chart.histTitle": "総工数の分布",
  "chart.histNote": "棒の高さはその範囲に着地する確率",
  "chart.cdfTitle": "累積確率 (S 字カーブ)",
  "chart.cdfNote": "「この工数以内に収まる確率」を読み取れます",
  "chart.xAxis": "総工数 ({unit})",
  "chart.tooltipRange": "{from} 〜 {to} {unit}",
  "chart.tooltipProb": "この範囲に入る確率",
  "chart.tooltipCum": "これ以下に収まる確率",
  "chart.p80Marker": "P80",
  "chart.noData": "計算結果がありません",
  "chart.altHist": "総工数のヒストグラムと累積確率。同じ内容を下の表でも読めます。",

  "probe.label": "工数を指定して確率を見る",
  "probe.result": "<b>{days}</b> {unit} 以内に収まる確率は <b>{prob}%</b>",

  "pct.heading": "分位点",
  "pct.level": "水準",
  "pct.value": "総工数 ({unit})",
  "pct.date": "完了予測日",
  "pct.meaning": "意味",
  "pct.meaningText": "{pct}% の確率でこの値以内に収まる",

  "dataview.summary": "データ表で見る",
  "dataview.range": "範囲 ({unit})",
  "dataview.prob": "確率",
  "dataview.cum": "累積",

  "sens.heading": "ばらつきへの寄与",
  "sens.note": "総工数のぶれに、どのタスクがどれだけ効いているか",
  "sens.task": "タスク",
  "sens.share": "寄与率",

  "sched.heading": "完了日の見通し",
  "sched.ganttTitle": "タスクごとの完了予測",
  "sched.ganttNote": "帯は P10〜P90 の幅、濃い部分が P25〜P75、縦線が P50",
  "sched.taskCol": "タスク",
  "sched.overall": "全体",
  "sched.notFinishing": "期間内に終わりません",
  "sched.extendHorizon": "カレンダーの「計算する日数」を延ばすと先まで計算できます。",
  "sched.pickDate": "この日までに完了している確率",
  "sched.probability": "完了確率",
  "sched.curveTitle": "全体が完了している確率",
  "sched.curveNote": "指定日までにすべて終わっている確率",
  "sched.xAxis": "日付",
  "sched.tooltip": "{date} 時点: <b>{prob}</b>",
  "sched.noResult": "計算結果がありません",
  "sched.legendBand": "P10〜P90",
  "sched.legendCore": "P25〜P75",
  "sched.legendMedian": "P50",
  "sched.today": "基準日",

  "status.loading": "計算エンジンを読み込み中…",
  "status.computing": "計算中…",
  "status.done": "{engine} で計算しました ({ms} ms)",
  "status.noTasks": "計算するタスクがありません。使用するタスクを 1 つ以上選んでください。",

  "error.title": "計算できませんでした",
  "error.1": "リクエストの形式が不正です (ABI バージョン不一致の可能性があります)。",
  "error.2": "タスク数が不正です。1 件以上 500 件以下にしてください。",
  "error.3": "試行回数・ビン数・グリッド分割数のいずれかが範囲外か、計算量が大きすぎます。",
  "error.4":
    "{index} 番目のタスクの見積もりが不正です。最小 ≤ 最可能 ≤ 最大 を満たす 0 以上の数値にしてください。",
  "error.5": "エンジンの指定が不正です。",
  "error.6": "相関つきの計算はまだ実装されていません。",
  "error.7": "カレンダーの設定が不正です。稼働時間や期間を確認してください。",
  "error.invalidRows": "{count} 件のタスクで見積もりが読めません。",
  "error.unknown": "未知のエラー (コード {code}) が発生しました。",
  "error.boot": "WASM の読み込みに失敗しました: {message}",

  "footer.offline":
    "このページは 1 枚の HTML で完結しており、外部への通信はありません。オフラインでもそのまま動きます。",
  "footer.engine": "計算コアは Rust を WebAssembly にビルドしたものです。",

  "unit.days": "人日",
  "unit.hours": "時間",
} as const;

type Dictionary = Record<keyof typeof ja, string>;

const en: Dictionary = {
  "app.title": "Effort Estimator",
  "app.tagline": "Turns three-point estimates into a probability distribution and a finish date",
  "lang.ja": "日本語",
  "lang.en": "English",

  "file.menu": "File",
  "file.new": "New",
  "file.open": "Open file…",
  "file.save": "Save to file",
  "file.exportCsv": "Export CSV",
  "file.importCsv": "Import CSV…",
  "file.sample": "Load sample",
  "file.projectName": "Project name",
  "file.confirmNew": "Discard the current project and start a new one?",
  "file.confirmImport": "Replace the current project with the imported one?",
  "file.badFile": "That file could not be read.",
  "file.imported": "Loaded {name}.",
  "file.saved": "Saved to file.",
  "file.autosaved": "Autosaved ({time})",
  "file.autosaveOff": "Cannot autosave (browser storage is unavailable)",

  "tab.tasks": "Tasks",
  "tab.calendar": "Calendar",
  "tab.distribution": "Effort",
  "tab.schedule": "Schedule",

  "summary.effortP80": "Effort P80",
  "summary.finishP80": "Finish P80",
  "summary.finishP50": "Finish P50",
  "summary.progress": "Progress",
  "summary.spent": "Spent",
  "summary.remaining": "Remaining",
  "summary.notFinishing": "Does not finish in range",
  "summary.noData": "—",

  "filter.heading": "Filter",
  "filter.text": "Search by name",
  "filter.group": "Group",
  "filter.priority": "Priority",
  "filter.state": "State",
  "filter.all": "All",
  "filter.none": "(none)",
  "filter.clear": "Clear filter",
  "filter.showing": "Showing {shown} of {total}",
  "filter.viewOnly":
    "Filtering only affects the list. The “Use” checkbox decides what is computed.",

  "columns.estimate": "Estimate",
  "columns.actual": "Actuals",
  "columns.all": "All",

  "tasks.heading": "Tasks",
  "tasks.add": "Add row",
  "tasks.addChild": "Add subtask",
  "tasks.indent": "Indent",
  "tasks.outdent": "Outdent",
  "tasks.up": "Move up",
  "tasks.down": "Move down",
  "tasks.remove": "Remove",
  "tasks.removeRow": "Remove {name}",
  "tasks.enableShown": "Use all shown",
  "tasks.disableShown": "Exclude all shown",
  "tasks.empty": "No tasks yet. Start with “Add row” or “Load sample”.",
  "tasks.noMatch": "No tasks match the filter.",
  "tasks.untitled": "Untitled task",
  "tasks.orderHint": "Tasks are worked top to bottom. Reordering changes the finish dates.",
  "tasks.rollupHint": "A parent task shows the sum of its children and cannot be edited directly.",
  "tasks.totals": "{count} in use / min {min} · likely {likely} · max {max} {unit}",
  "tasks.sortByPriority": "Sort by priority",

  "col.use": "Use",
  "col.name": "Task",
  "col.priority": "Priority",
  "col.group": "Group",
  "col.min": "Min",
  "col.likely": "Likely",
  "col.max": "Max",
  "col.start": "Started",
  "col.progress": "Progress %",
  "col.end": "Finished",
  "col.forecast": "Forecast",
  "col.spent": "Spent",
  "col.state": "State",
  "col.finish": "Finish (P80)",
  "col.actions": "Actions",

  "priority.high": "High",
  "priority.normal": "Normal",
  "priority.low": "Low",

  "state.notStarted": "Not started",
  "state.inProgress": "In progress",
  "state.done": "Done",

  "cal.heading": "Working calendar",
  "cal.basics": "Basics",
  "cal.start": "Start date",
  "cal.today": "Reference date (today)",
  "cal.horizon": "Days to project",
  "cal.workdays": "Working days",
  "cal.hoursPerDay": "Hours per day",
  "cal.hoursPerPersonDay": "Hours per person-day",
  "cal.teamSize": "Team size",
  "cal.useHolidays": "Treat Japanese public holidays as days off",
  "cal.capacityPerDay": "{value} person-days per working day",
  "cal.totalCapacity": "{value} person-days over the whole range",
  "cal.events": "Events",
  "cal.addEvent": "Add event",
  "cal.eventName": "Description",
  "cal.eventFrom": "From",
  "cal.eventTo": "To",
  "cal.eventHours": "Hours lost",
  "cal.allDay": "All day",
  "cal.hoursUnit": "h/day",
  "cal.removeEvent": "Remove this event",
  "cal.noEvents":
    "No events yet. Meetings and time off push the schedule out by exactly that much.",
  "cal.monthView": "Month view",
  "cal.prevMonth": "Previous month",
  "cal.nextMonth": "Next month",
  "cal.thisMonth": "This month",
  "cal.legendWorkday": "Working day",
  "cal.legendWeekend": "Weekend",
  "cal.legendHoliday": "Holiday",
  "cal.legendEvent": "Has an event",
  "cal.legendForced": "Working anyway",
  "cal.clickHint": "Click a date to toggle whether the team works on it.",
  "cal.dayCapacity": "{date}: {value} person-days",

  "results.heading": "Distribution of total effort",
  "results.mean": "Mean",
  "results.p50": "P50 (median)",
  "results.p80": "P80",
  "results.p90": "P90",
  "results.sd": "Std. deviation",
  "results.buffer": "P80 headroom",
  "results.bufferHint":
    "P80 minus the sum of the most-likely estimates — the buffer you are implicitly asking for.",
  "results.engine": "Engine",
  "results.settings": "Settings",

  "settings.dist": "Distribution",
  "settings.dist.pert": "PERT (beta)",
  "settings.dist.tri": "Triangular",
  "settings.lambda": "PERT shape λ",
  "settings.engine": "Engine",
  "settings.engine.mc": "Monte Carlo",
  "settings.engine.conv": "Numeric convolution",
  "settings.iterations": "Iterations",
  "settings.seed": "Random seed",
  "settings.bins": "Bins",
  "settings.grid": "Grid points",
  "settings.hint.mc":
    "Estimates the total by random sampling. The same seed always gives the same answer.",
  "settings.hint.conv":
    "Convolves the task distributions directly. No randomness at all, so it doubles as a check on the Monte Carlo result.",

  "chart.histTitle": "Distribution of total effort",
  "chart.histNote": "Bar height is the probability of landing in that range",
  "chart.cdfTitle": "Cumulative probability (S-curve)",
  "chart.cdfNote": "Read off the chance of finishing within a given effort",
  "chart.xAxis": "Total effort ({unit})",
  "chart.tooltipRange": "{from} – {to} {unit}",
  "chart.tooltipProb": "Probability in this range",
  "chart.tooltipCum": "Probability of finishing within",
  "chart.p80Marker": "P80",
  "chart.noData": "Nothing to plot yet",
  "chart.altHist":
    "Histogram and cumulative probability of total effort. The same numbers are in the table below.",

  "probe.label": "Pick an effort and read off the probability",
  "probe.result": "The chance of finishing within <b>{days}</b> {unit} is <b>{prob}%</b>",

  "pct.heading": "Percentiles",
  "pct.level": "Level",
  "pct.value": "Total effort ({unit})",
  "pct.date": "Finish date",
  "pct.meaning": "Reading",
  "pct.meaningText": "{pct}% chance of finishing within this",

  "dataview.summary": "View as table",
  "dataview.range": "Range ({unit})",
  "dataview.prob": "Probability",
  "dataview.cum": "Cumulative",

  "sens.heading": "Contribution to uncertainty",
  "sens.note": "Which tasks drive the spread of the total",
  "sens.task": "Task",
  "sens.share": "Share",

  "sched.heading": "Finish dates",
  "sched.ganttTitle": "Forecast completion per task",
  "sched.ganttNote": "The band spans P10–P90, the darker part P25–P75, the line marks P50",
  "sched.taskCol": "Task",
  "sched.overall": "Everything",
  "sched.notFinishing": "Does not finish in range",
  "sched.extendHorizon": "Increase “Days to project” on the Calendar tab to look further ahead.",
  "sched.pickDate": "Probability of being finished by",
  "sched.probability": "Probability",
  "sched.curveTitle": "Probability that everything is done",
  "sched.curveNote": "Chance that all tasks are complete by the given date",
  "sched.xAxis": "Date",
  "sched.tooltip": "By {date}: <b>{prob}</b>",
  "sched.noResult": "Nothing to show yet",
  "sched.legendBand": "P10–P90",
  "sched.legendCore": "P25–P75",
  "sched.legendMedian": "P50",
  "sched.today": "Reference date",

  "status.loading": "Loading the engine…",
  "status.computing": "Computing…",
  "status.done": "Computed with {engine} ({ms} ms)",
  "status.noTasks": "Nothing to compute. Tick “Use” on at least one task.",

  "error.title": "Could not compute",
  "error.1": "The request buffer is malformed (possible ABI version mismatch).",
  "error.2": "Invalid task count — it must be between 1 and 500.",
  "error.3": "Iterations, bins or grid points are out of range, or the workload is too large.",
  "error.4":
    "Task {index} has an invalid estimate. Use non-negative numbers with min ≤ likely ≤ max.",
  "error.5": "Unknown engine.",
  "error.6": "Correlated tasks are not implemented yet.",
  "error.7": "The calendar settings are invalid. Check the working hours and the range.",
  "error.invalidRows": "{count} task(s) have estimates that cannot be read.",
  "error.unknown": "Unexpected error (code {code}).",
  "error.boot": "Failed to load the WASM module: {message}",

  "footer.offline":
    "This page is a single self-contained HTML file. It makes no network requests and works offline.",
  "footer.engine": "The computation core is Rust compiled to WebAssembly.",

  "unit.days": "person-days",
  "unit.hours": "hours",
};

export type MessageKey = keyof typeof ja;

const TABLES: Record<Lang, Dictionary> = { ja, en };

const STORAGE_KEY = "mhc.lang.v1";

let current: Lang = detect();

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "ja" || saved === "en") return saved;
  } catch {
    /* プライベートモードなどで読めなくても既定にフォールバックする */
  }
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function lang(): Lang {
  return current;
}

export function setLang(next: Lang): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 保存できなくても切り替え自体は効く */
  }
}

/** 文言を引く。`{name}` は `params` で置き換える。 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text: string = TABLES[current][key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** 単位 (人日) を含む共通の差し込み。静的なマークアップ用。 */
export function commonParams(): Record<string, string> {
  return { unit: t("unit.days") };
}
