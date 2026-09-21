/**
 * 総工数の分布を描く。
 *
 * ヒストグラムと累積確率カーブを、x 軸を共有する上下 2 枚のパネルとして
 * 1 つの canvas に描く。y 軸をふたつ重ねた二重軸グラフにはしない。
 * 棒の高さ (確率) と累積確率はスケールが無関係で、重ねると存在しない
 * 対応関係が生まれてしまうため。
 */

import { formatNumber, formatPercent, type Lang } from "../format.ts";
import { t } from "../i18n.ts";
import {
  type Palette,
  Tooltip,
  ellipsize,
  niceScale,
  readPalette,
  roundedTopRect,
  setupCanvas,
  watchRedraw,
} from "./common.ts";

export interface DistributionModel {
  lo: number;
  hi: number;
  probs: Float64Array;
  cdf: Float64Array;
  p80: number;
}

const PAD = { left: 58, right: 18, top: 34, bottom: 42 };
const PANEL_GAP = 48;
const BAR_GAP = 2;
const BAR_RADIUS = 4;

interface Layout {
  width: number;
  height: number;
  left: number;
  right: number;
  plotW: number;
  histTop: number;
  histBottom: number;
  histH: number;
  cdfTop: number;
  cdfBottom: number;
  cdfH: number;
}

export interface DistributionChart {
  setData: (model: DistributionModel | null) => void;
  redraw: () => void;
}

export function createDistributionChart(
  canvas: HTMLCanvasElement,
  tooltipElement: HTMLElement,
  getLang: () => Lang,
): DistributionChart {
  const tooltip = new Tooltip(tooltipElement);
  let model: DistributionModel | null = null;
  let layout: Layout | null = null;
  let focusBin = -1;

  const layoutFor = (width: number, height: number): Layout => {
    const plotH = height - PAD.top - PAD.bottom - PANEL_GAP;
    const histH = Math.round(plotH * 0.58);
    const cdfH = plotH - histH;
    return {
      width,
      height,
      left: PAD.left,
      right: width - PAD.right,
      plotW: width - PAD.left - PAD.right,
      histTop: PAD.top,
      histBottom: PAD.top + histH,
      histH,
      cdfTop: PAD.top + histH + PANEL_GAP,
      cdfBottom: PAD.top + histH + PANEL_GAP + cdfH,
      cdfH,
    };
  };

  const xOf = (value: number): number => {
    if (!model || !layout) return 0;
    return layout.left + ((value - model.lo) / (model.hi - model.lo)) * layout.plotW;
  };

  const binRange = (index: number): [number, number] => {
    if (!model) return [0, 0];
    const step = (model.hi - model.lo) / model.probs.length;
    return [model.lo + index * step, model.lo + (index + 1) * step];
  };

  const binAt = (localX: number): number => {
    if (!model || !layout) return -1;
    const fraction = (localX - layout.left) / layout.plotW;
    if (fraction < -0.02 || fraction > 1.02) return -1;
    const index = Math.floor(fraction * model.probs.length);
    return Math.max(0, Math.min(model.probs.length - 1, index));
  };

  function drawCrosshair(ctx: CanvasRenderingContext2D, colors: Palette, bin: number): void {
    if (!model || !layout) return;
    const [from, to] = binRange(bin);
    const x = Math.round(xOf((from + to) / 2)) + 0.5;

    ctx.save();
    ctx.strokeStyle = colors.ink;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, layout.histTop);
    ctx.lineTo(x, layout.histBottom);
    ctx.moveTo(x, layout.cdfTop);
    ctx.lineTo(x, layout.cdfBottom);
    ctx.stroke();
    ctx.restore();

    const scale = niceScale(Math.max(...model.probs, 1e-12));
    const slot = layout.plotW / model.probs.length;
    const height = ((model.probs[bin] ?? 0) / scale.max) * layout.histH;
    if (height > 0) {
      // 枠線ではなく地の色のリングで浮かせる。
      ctx.strokeStyle = colors.surface;
      ctx.lineWidth = 2;
      ctx.strokeRect(
        layout.left + bin * slot + BAR_GAP / 2 - 1,
        layout.histBottom - height - 1,
        Math.max(1, slot - BAR_GAP) + 2,
        height + 1,
      );
    }

    const cumulative = model.cdf[bin + 1] ?? 0;
    ctx.fillStyle = colors.series;
    ctx.strokeStyle = colors.surface;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, layout.cdfBottom - cumulative * layout.cdfH, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  function draw(): void {
    const surface = setupCanvas(canvas);
    if (!surface) return;
    const { ctx, width, height } = surface;
    const colors = readPalette();
    layout = layoutFor(width, height);
    const lang = getLang();

    if (!model || model.probs.length === 0) {
      ctx.fillStyle = colors.muted;
      ctx.font = `13px ${colors.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t("chart.noData"), width / 2, height / 2);
      return;
    }

    const scale = niceScale(Math.max(...model.probs, 1e-12));

    // --- パネル見出し。2 枚は x 軸だけを共有する別々のグラフ。
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = `600 12px ${colors.font}`;
    ctx.fillStyle = colors.secondary;
    ctx.fillText(t("chart.histTitle"), layout.left, layout.histTop - 12);
    ctx.fillText(t("chart.cdfTitle"), layout.left, layout.cdfTop - 12);

    // --- 目盛りとグリッド (実線のヘアライン)
    ctx.lineWidth = 1;
    ctx.font = `11px ${colors.font}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let i = 0; i <= scale.ticks; i++) {
      const y = Math.round(layout.histBottom - (layout.histH * i) / scale.ticks) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(layout.left, y);
      ctx.lineTo(layout.right, y);
      ctx.stroke();
      ctx.fillStyle = colors.muted;
      const value = (scale.max * i) / scale.ticks;
      ctx.fillText(formatPercent(value, lang, scale.max >= 0.05 ? 0 : 1), layout.left - 9, y);
    }
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(layout.cdfBottom - (layout.cdfH * i) / 4) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(layout.left, y);
      ctx.lineTo(layout.right, y);
      ctx.stroke();
      ctx.fillStyle = colors.muted;
      ctx.fillText(`${String(i * 25)}%`, layout.left - 9, y);
    }

    // --- ヒストグラムの棒
    const slot = layout.plotW / model.probs.length;
    const gap = slot > 6 ? BAR_GAP : Math.max(0.5, slot * 0.18);
    const barWidth = Math.max(1, slot - gap);
    ctx.fillStyle = colors.series;
    for (let i = 0; i < model.probs.length; i++) {
      const barHeight = ((model.probs[i] ?? 0) / scale.max) * layout.histH;
      if (barHeight <= 0) continue;
      roundedTopRect(
        ctx,
        layout.left + i * slot + gap / 2,
        layout.histBottom - barHeight,
        barWidth,
        barHeight,
        Math.min(BAR_RADIUS, barWidth / 2),
      );
    }

    // --- 累積カーブ
    // 以降のクロージャで再判定せずに済むよう、確定した値を束ねておく。
    const plot = layout;
    const cdf = model.cdf;
    const points: [number, number][] = Array.from(cdf, (value, i) => [
      plot.left + (i * plot.plotW) / (cdf.length - 1),
      plot.cdfBottom - value * plot.cdfH,
    ]);
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    if (firstPoint && lastPoint) {
      ctx.fillStyle = colors.seriesSoft;
      ctx.beginPath();
      ctx.moveTo(firstPoint[0], plot.cdfBottom);
      for (const [x, y] of points) ctx.lineTo(x, y);
      ctx.lineTo(lastPoint[0], plot.cdfBottom);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = colors.series;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(firstPoint[0], firstPoint[1]);
      for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
      ctx.stroke();
    }

    // --- 軸線
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.axis;
    for (const [top, bottom] of [
      [layout.histTop, layout.histBottom],
      [layout.cdfTop, layout.cdfBottom],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(layout.left - 0.5, top);
      ctx.lineTo(layout.left - 0.5, bottom + 0.5);
      ctx.lineTo(layout.right, bottom + 0.5);
      ctx.stroke();
    }

    // --- x 軸の目盛り (両パネル共通)
    ctx.fillStyle = colors.muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const ticks = Math.max(2, Math.min(7, Math.floor(layout.plotW / 110)));
    for (let i = 0; i <= ticks; i++) {
      const value = model.lo + ((model.hi - model.lo) * i) / ticks;
      ctx.fillText(formatNumber(value, lang), xOf(value), layout.cdfBottom + 9);
    }
    ctx.fillStyle = colors.secondary;
    ctx.fillText(
      t("chart.xAxis", { unit: t("unit.days") }),
      (layout.left + layout.right) / 2,
      layout.cdfBottom + 26,
    );

    // --- P80 の注記。意思決定に使う 1 本だけを直接ラベルする。
    if (model.p80 >= model.lo && model.p80 <= model.hi) {
      const x = Math.round(xOf(model.p80)) + 0.5;
      ctx.strokeStyle = colors.secondary;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, layout.histTop);
      ctx.lineTo(x, layout.histBottom);
      ctx.moveTo(x, layout.cdfTop);
      ctx.lineTo(x, layout.cdfBottom);
      ctx.stroke();
      const y80 = Math.round(layout.cdfBottom - 0.8 * layout.cdfH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(layout.left, y80);
      ctx.lineTo(x, y80);
      ctx.stroke();

      const label = `${t("chart.p80Marker")} ${formatNumber(model.p80, lang)}`;
      ctx.font = `11px ${colors.font}`;
      const boxWidth = ctx.measureText(label).width + 12;
      const boxX = Math.min(x + 5, layout.right - boxWidth);
      ctx.fillStyle = colors.secondary;
      ctx.beginPath();
      ctx.roundRect(boxX, layout.histTop + 3, boxWidth, 17, 4);
      ctx.fill();
      ctx.fillStyle = colors.surface;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(ellipsize(ctx, label, boxWidth - 12), boxX + 6, layout.histTop + 12);
    }

    if (focusBin >= 0) drawCrosshair(ctx, colors, focusBin);
  }

  function showTooltip(bin: number, clientX: number | null): void {
    if (!model || !layout) return;
    const lang = getLang();
    const [from, to] = binRange(bin);
    const box = canvas.getBoundingClientRect();
    const localX = clientX === null ? xOf((from + to) / 2) : clientX - box.left;
    tooltip.show(
      [
        {
          label: t("chart.tooltipRange", {
            from: formatNumber(from, lang),
            to: formatNumber(to, lang),
            unit: t("unit.days"),
          }),
        },
        {
          label: t("chart.tooltipProb"),
          value: formatPercent(model.probs[bin] ?? 0, lang, 2),
        },
        {
          label: t("chart.tooltipCum"),
          value: formatPercent(model.cdf[bin + 1] ?? 0, lang, 1),
        },
      ],
      localX,
      layout.histTop + 26,
      box.width,
    );
  }

  const onPointer = (event: PointerEvent): void => {
    if (!model) return;
    const box = canvas.getBoundingClientRect();
    const bin = binAt(event.clientX - box.left);
    if (bin < 0) {
      focusBin = -1;
      tooltip.hide();
      draw();
      return;
    }
    focusBin = bin;
    draw();
    showTooltip(bin, event.clientX);
  };

  const onLeave = (): void => {
    focusBin = -1;
    tooltip.hide();
    draw();
  };

  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("blur", onLeave);
  canvas.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!model) return;
    const last = model.probs.length - 1;
    let next: number;
    if (event.key === "ArrowRight") next = focusBin < 0 ? 0 : Math.min(last, focusBin + 1);
    else if (event.key === "ArrowLeft") next = focusBin < 0 ? last : Math.max(0, focusBin - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") next = -1;
    else return;

    event.preventDefault();
    focusBin = next;
    draw();
    if (next < 0) tooltip.hide();
    else showTooltip(next, null);
  });

  watchRedraw(canvas, draw);

  return {
    setData(next) {
      model = next;
      focusBin = -1;
      tooltip.hide();
      draw();
    },
    redraw: draw,
  };
}
