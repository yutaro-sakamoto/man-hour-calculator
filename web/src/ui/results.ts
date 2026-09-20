/** 工数の分布タブ。KPI・グラフ・分位点・感度・計算設定。 */

import { P50_INDEX, P80_INDEX, P90_INDEX, PCT_LEVELS } from "../abi.ts";
import type { AppActions, AppState, AppWidgets } from "../app.ts";
import { formatDayShort, formatNumber, formatPercent } from "../format.ts";
import { lang, t } from "../i18n.ts";
import { firstDayAtLeast, type ScheduleModel } from "../model/schedule.ts";
import type { ComputeResult } from "../wasm.ts";
import { card, field, h, numberInput, select } from "./dom.ts";

function tile(key: string, label: string, value: string, accent = false): HTMLElement {
  return h("div", { class: `tile${accent ? " accent" : ""}`, dataset: { key, value } }, [
    h("dt", { text: label }),
    h("dd", {}, [value, h("span", { class: "unit", text: t("unit.days") })]),
  ]);
}

function renderTiles(result: ComputeResult): HTMLElement {
  const l = lang();
  const p80 = result.percentiles[P80_INDEX] ?? 0;
  return h("dl", { class: "tiles" }, [
    tile("mean", t("results.mean"), formatNumber(result.mean, l)),
    tile("p50", t("results.p50"), formatNumber(result.percentiles[P50_INDEX] ?? 0, l)),
    tile("p80", t("results.p80"), formatNumber(p80, l), true),
    tile("p90", t("results.p90"), formatNumber(result.percentiles[P90_INDEX] ?? 0, l)),
    tile("sd", t("results.sd"), formatNumber(result.sd, l)),
    tile(
      "buffer",
      t("results.buffer"),
      `${p80 - result.totalLikely >= 0 ? "+" : ""}${formatNumber(p80 - result.totalLikely, l)}`,
    ),
  ]);
}

function renderPercentileTable(result: ComputeResult, schedule: ScheduleModel | null): HTMLElement {
  const l = lang();
  return h("div", { class: "pct-table" }, [
    h("h3", { class: "section-title", text: t("pct.heading") }),
    h("table", {}, [
      h("thead", {}, [
        h("tr", {}, [
          h("th", { text: t("pct.level") }),
          h("th", { class: "num", text: t("pct.value", { unit: t("unit.days") }) }),
          h("th", { text: t("pct.date") }),
          h("th", { text: t("pct.meaning") }),
        ]),
      ]),
      h(
        "tbody",
        { id: "pct-body" },
        PCT_LEVELS.map((level, index) => {
          const value = result.percentiles[index] ?? 0;
          // 完了日は「その確率で全員が終わっている日」。工数を 1 本のカレンダーに
          // 当てるのではなく、人ごとの進み方を踏まえた確率から引く。
          const day = schedule === null ? null : firstDayAtLeast(schedule.overall, level);
          const pct = Math.round(level * 100);
          return h("tr", { dataset: { highlight: String(pct === 80) } }, [
            h("th", { text: `P${String(pct)}`, attrs: { scope: "row" } }),
            h("td", { class: "num", text: formatNumber(value, l) }),
            h("td", {
              text:
                day === null || schedule === null
                  ? t("sched.notFinishing")
                  : formatDayShort(schedule.startDay + day, l),
              class: day === null ? "warn" : "",
            }),
            h("td", { text: t("pct.meaningText", { pct }) }),
          ]);
        }),
      ),
    ]),
  ]);
}

function renderDataView(result: ComputeResult): HTMLElement {
  const l = lang();
  const step = (result.hi - result.lo) / result.probs.length;
  return h("details", { class: "data-view" }, [
    h("summary", { text: t("dataview.summary") }),
    h("div", { class: "scroll" }, [
      h("table", {}, [
        h("thead", {}, [
          h("tr", {}, [
            h("th", { class: "num", text: t("dataview.range", { unit: t("unit.days") }) }),
            h("th", { class: "num", text: t("dataview.prob") }),
            h("th", { class: "num", text: t("dataview.cum") }),
          ]),
        ]),
        h(
          "tbody",
          { id: "data-body" },
          Array.from(result.probs, (probability, index) => {
            const from = result.lo + index * step;
            return h("tr", {}, [
              h("td", {
                class: "num",
                text: `${formatNumber(from, l)} – ${formatNumber(from + step, l)}`,
              }),
              h("td", { class: "num", text: formatPercent(probability, l, 2) }),
              h("td", { class: "num", text: formatPercent(result.cdf[index + 1] ?? 0, l, 1) }),
            ]);
          }),
        ),
      ]),
    ]),
  ]);
}

/** 累積確率を線形補間で読む。グラフの目視とスライダの数字を一致させる。 */
function cumulativeAt(result: ComputeResult, value: number): number {
  const bins = result.probs.length;
  const step = (result.hi - result.lo) / bins;
  if (value <= result.lo) return result.cdf[0] ?? 0;
  if (value >= result.hi) return result.cdf[bins] ?? 1;
  const position = (value - result.lo) / step;
  const index = Math.min(bins - 1, Math.floor(position));
  const frac = position - index;
  const low = result.cdf[index] ?? 0;
  const high = result.cdf[index + 1] ?? low;
  return low + frac * (high - low);
}

const PROBE_STEPS = 1000;

function renderProbe(result: ComputeResult): HTMLElement {
  const l = lang();
  const output = h("output", { id: "probe-output", attrs: { for: "probe-range" } });
  const span = result.hi - result.lo;

  const update = (position: number): void => {
    const value = result.lo + (position / PROBE_STEPS) * span;
    output.innerHTML = t("probe.result", {
      days: formatNumber(value, l),
      unit: t("unit.days"),
      prob: formatNumber(cumulativeAt(result, value) * 100, l, 1),
    });
  };

  const initial =
    span > 0
      ? Math.round(
          (((result.percentiles[P80_INDEX] ?? result.lo) - result.lo) / span) * PROBE_STEPS,
        )
      : PROBE_STEPS / 2;
  const range = h("input", {
    id: "probe-range",
    attrs: {
      type: "range",
      min: 0,
      max: PROBE_STEPS,
      step: 1,
      value: String(Math.max(0, Math.min(PROBE_STEPS, initial))),
    },
    on: {
      input: (event) => {
        update(Number((event.target as HTMLInputElement).value));
      },
    },
  });
  update(Number(range.value));

  return h("div", { class: "probe" }, [
    h("span", { class: "field-label", text: t("probe.label") }),
    h("div", { class: "probe-row" }, [range, output]),
  ]);
}

function renderSensitivity(state: AppState, result: ComputeResult): HTMLElement {
  const l = lang();
  const leaves = state.rows.filter((row) => row.leafIndex !== null);
  const items = leaves
    .map((row) => ({
      label: row.task.name.trim() === "" ? t("tasks.untitled") : row.task.name,
      share: result.sensitivity[row.leafIndex ?? 0] ?? 0,
    }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 10);
  const peak = Math.max(...items.map((item) => item.share), 1e-9);

  return card(t("sens.heading"), [
    h("p", { class: "hint", text: t("sens.note") }),
    h("table", { class: "sens-table" }, [
      h("thead", {}, [
        h("tr", {}, [
          h("th", { text: t("sens.task") }),
          h("th", { class: "num", text: t("sens.share") }),
        ]),
      ]),
      h(
        "tbody",
        {},
        items.map((item) =>
          h("tr", {}, [
            h("td", {}, [
              h("span", { class: "bar-label", text: item.label }),
              h("span", { class: "bar-track" }, [
                h("span", {
                  class: "bar-fill",
                  style: { width: `${String((item.share / peak) * 100)}%` },
                }),
              ]),
            ]),
            h("td", { class: "num", text: formatPercent(item.share, l, 1) }),
          ]),
        ),
      ),
    ]),
  ]);
}

function renderSettings(state: AppState, actions: AppActions): HTMLElement {
  const settings = state.document.settings;
  const isMonteCarlo = settings.engine === 0;
  const setNumber =
    (key: "lambda" | "iterations" | "seed" | "bins" | "gridPoints") => (value: string) => {
      actions.mutate((document) => {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) document.settings[key] = parsed;
      });
    };

  return card(t("results.settings"), [
    h("div", { class: "controls" }, [
      field(
        t("settings.dist"),
        select(
          String(settings.dist),
          [
            { value: "0", label: t("settings.dist.pert") },
            { value: "1", label: t("settings.dist.tri") },
          ],
          (value) => {
            actions.mutate((document) => {
              document.settings.dist = value === "1" ? 1 : 0;
            });
          },
          { id: "dist" },
        ),
      ),
      field(
        t("settings.lambda"),
        numberInput(settings.lambda, setNumber("lambda"), {
          id: "lambda",
          attrs: { min: 0, max: 100, step: 0.5, disabled: settings.dist !== 0 },
        }),
      ),
      field(
        t("settings.engine"),
        select(
          String(settings.engine),
          [
            { value: "0", label: t("settings.engine.mc") },
            { value: "1", label: t("settings.engine.conv") },
          ],
          (value) => {
            actions.mutate((document) => {
              document.settings.engine = value === "1" ? 1 : 0;
            });
          },
          { id: "engine" },
        ),
      ),
      field(
        t("settings.iterations"),
        numberInput(settings.iterations, setNumber("iterations"), {
          id: "iterations",
          attrs: { min: 1, max: 2_000_000, step: 10_000, disabled: !isMonteCarlo },
        }),
      ),
      field(
        t("settings.seed"),
        numberInput(settings.seed, setNumber("seed"), {
          id: "seed",
          attrs: { min: 0, step: 1, disabled: !isMonteCarlo },
        }),
      ),
      field(
        t("settings.bins"),
        numberInput(settings.bins, setNumber("bins"), {
          id: "bins",
          attrs: { min: 4, max: 512, step: 4 },
        }),
      ),
      field(
        t("settings.grid"),
        numberInput(settings.gridPoints, setNumber("gridPoints"), {
          id: "grid",
          attrs: { min: 16, max: 16_384, step: 256, disabled: isMonteCarlo },
        }),
      ),
    ]),
    h("p", {
      class: "status",
      id: "engine-hint",
      text: t(isMonteCarlo ? "settings.hint.mc" : "settings.hint.conv"),
    }),
  ]);
}

export function renderDistributionTab(
  state: AppState,
  actions: AppActions,
  widgets: AppWidgets,
): HTMLElement {
  const result = state.result;
  if (result === null) {
    return card(t("results.heading"), [h("p", { class: "empty", text: t("chart.noData") })]);
  }

  return h("div", {}, [
    card(t("results.heading"), [
      renderTiles(result),
      h("p", { class: "hint", text: t("results.bufferHint") }),
      widgets.distributionFigure,
      h("p", {
        class: "hint",
        text: `${t("chart.histNote")} · ${t("chart.cdfNote")}`,
      }),
      renderDataView(result),
      renderProbe(result),
      renderPercentileTable(result, state.schedule),
    ]),
    renderSensitivity(state, result),
    renderSettings(state, actions),
  ]);
}
