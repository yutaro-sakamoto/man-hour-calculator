/**
 * 完了日の見通しを描く。
 *
 * 上段はタスクごとの完了予測。帯は「いつ終わりそうか」の幅そのもので、
 * 外側が P10〜P90、内側の濃い部分が P25〜P75、縦線が P50。
 * 下段は全体が完了している確率のカーブで、x 軸 (日付) を上段と共有する。
 *
 * 帯の濃淡は同一色相の順序ランプ。値の大小ではなく「確からしさの段階」を
 * 表しているので、カテゴリ色ではなくランプを使う。
 */

import { formatDayShort, formatMonthShort, formatPercent, type Lang } from "../format.ts";
import { t } from "../i18n.ts";
import { isNonWorkingDay, type ScheduleMarks, type ScheduleModel } from "../model/schedule.ts";
import {
  Tooltip,
  ellipsize,
  readPalette,
  roundedRect,
  setupCanvas,
  watchRedraw,
} from "./common.ts";

const PAD = { top: 30, right: 16, bottom: 44 };
const NAME_MIN = 150;
const NAME_MAX = 260;
const DATE_WIDTH = 78;
export const ROW_HEIGHT = 26;
const BAND_HEIGHT = 12;
const CURVE_HEIGHT = 118;
const PANEL_GAP = 46;

/** 行数から canvas の高さを求める。軸の帯まで含めた高さにする。 */
export function scheduleHeight(rowCount: number): number {
  return PAD.top + Math.max(1, rowCount + 1) * ROW_HEIGHT + PANEL_GAP + CURVE_HEIGHT + PAD.bottom;
}

export interface ScheduleChart {
  setData: (model: ScheduleModel | null) => void;
  redraw: () => void;
}

interface Layout {
  width: number;
  plotLeft: number;
  plotRight: number;
  plotW: number;
  rowsTop: number;
  rowsBottom: number;
  curveTop: number;
  curveBottom: number;
  nameWidth: number;
}

export function createScheduleChart(
  canvas: HTMLCanvasElement,
  tooltipElement: HTMLElement,
  getLang: () => Lang,
): ScheduleChart {
  const tooltip = new Tooltip(tooltipElement);
  let model: ScheduleModel | null = null;
  let layout: Layout | null = null;
  let focusDay = -1;

  const layoutFor = (width: number, rowCount: number): Layout => {
    const nameWidth = Math.max(NAME_MIN, Math.min(NAME_MAX, width * 0.26));
    const plotLeft = nameWidth + DATE_WIDTH + 8;
    const rowsTop = PAD.top;
    const rowsBottom = rowsTop + Math.max(1, rowCount + 1) * ROW_HEIGHT;
    return {
      width,
      plotLeft,
      plotRight: width - PAD.right,
      plotW: width - PAD.right - plotLeft,
      rowsTop,
      rowsBottom,
      curveTop: rowsBottom + PANEL_GAP,
      curveBottom: rowsBottom + PANEL_GAP + CURVE_HEIGHT,
      nameWidth,
    };
  };

  /** 横軸に描く日数。ほぼ確実に完了する日までに絞ってある。 */
  const visibleDays = (): number => Math.max(1, model?.displayDays ?? 1);

  const xOfDay = (day: number): number => {
    if (!layout) return 0;
    return layout.plotLeft + ((day + 0.5) / visibleDays()) * layout.plotW;
  };

  const dayAt = (localX: number): number => {
    if (!model || !layout) return -1;
    const fraction = (localX - layout.plotLeft) / layout.plotW;
    if (fraction < 0 || fraction > 1) return -1;
    return Math.max(0, Math.min(visibleDays() - 1, Math.floor(fraction * visibleDays())));
  };

  /** 帯の左右端。終わらない場合は右端まで伸ばす。 */
  const span = (from: number | null, to: number | null): [number, number] | null => {
    if (!layout || !model) return null;
    if (from === null) return null;
    const left = xOfDay(from);
    const right = to === null ? layout.plotRight : xOfDay(to);
    return [left, Math.max(right, left + 2)];
  };

  function drawRow(
    ctx: CanvasRenderingContext2D,
    colors: ReturnType<typeof readPalette>,
    marks: ScheduleMarks,
    centerY: number,
  ): void {
    const outer = span(marks.p10, marks.p90);
    if (!outer) return;
    const top = centerY - BAND_HEIGHT / 2;

    ctx.fillStyle = colors.band;
    roundedRect(ctx, outer[0], top, outer[1] - outer[0], BAND_HEIGHT, 3);

    const inner = span(marks.p25, marks.p75);
    if (inner) {
      ctx.fillStyle = colors.core;
      roundedRect(ctx, inner[0], top, inner[1] - inner[0], BAND_HEIGHT, 3);
    }

    if (marks.p50 !== null) {
      ctx.fillStyle = colors.marker;
      ctx.fillRect(Math.round(xOfDay(marks.p50)) - 1, top - 2, 2, BAND_HEIGHT + 4);
    }

    // 期間内に終わらない場合は、帯が切れていることを矢印で示す。
    if (marks.p90 === null && layout) {
      ctx.fillStyle = colors.marker;
      ctx.beginPath();
      ctx.moveTo(layout.plotRight - 6, centerY - 5);
      ctx.lineTo(layout.plotRight, centerY);
      ctx.lineTo(layout.plotRight - 6, centerY + 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  function draw(): void {
    const surface = setupCanvas(canvas);
    if (!surface) return;
    const { ctx, width, height } = surface;
    const colors = readPalette();
    const lang = getLang();

    if (!model || model.days === 0) {
      ctx.fillStyle = colors.muted;
      ctx.font = `13px ${colors.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t("sched.noResult"), width / 2, height / 2);
      return;
    }

    const data = model;
    layout = layoutFor(width, data.rows.length);
    const plot = layout;

    // --- 非稼働日の帯。日付の粗密が視覚的に分かるようにする。
    const shown = Math.max(1, data.displayDays);
    const dayWidth = plot.plotW / shown;
    ctx.fillStyle = colors.offday;
    for (let day = 0; day < shown; day++) {
      if (!isNonWorkingDay(data.dayFlags[day] ?? 0)) continue;
      ctx.fillRect(
        plot.plotLeft + (day / shown) * plot.plotW,
        plot.rowsTop,
        Math.max(dayWidth, 0.7),
        plot.curveBottom - plot.rowsTop,
      );
    }

    // --- 月の区切りと見出し
    ctx.font = `11px ${colors.font}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    let labelRight = -Infinity;
    for (let day = 0; day < shown; day++) {
      const date = new Date((data.startDay + day) * 86_400_000);
      if (date.getUTCDate() !== 1 && day !== 0) continue;
      const x = Math.round(plot.plotLeft + (day / shown) * plot.plotW) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plot.rowsTop);
      ctx.lineTo(x, plot.curveBottom);
      ctx.stroke();

      // 重なりそうなラベルは落とす。目盛り線は残すので位置は分かる。
      const label = formatMonthShort(date.getUTCFullYear(), date.getUTCMonth() + 1, lang);
      const width = ctx.measureText(label).width;
      if (x + 4 > labelRight && x + 4 + width < plot.plotRight) {
        ctx.fillStyle = colors.muted;
        ctx.fillText(label, x + 4, plot.curveBottom + 8);
        labelRight = x + 4 + width + 10;
      }
    }

    // --- パネル見出し
    ctx.textBaseline = "alphabetic";
    ctx.font = `600 12px ${colors.font}`;
    ctx.fillStyle = colors.secondary;
    ctx.fillText(t("sched.ganttTitle"), 0, plot.rowsTop - 12);
    ctx.fillText(t("sched.curveTitle"), 0, plot.curveTop - 12);

    // --- 行
    ctx.textBaseline = "middle";
    data.rows.forEach((row, index) => {
      const centerY = plot.rowsTop + index * ROW_HEIGHT + ROW_HEIGHT / 2;
      ctx.font = `${row.isParent ? "600 " : ""}12px ${colors.font}`;
      ctx.fillStyle = row.isParent ? colors.ink : colors.secondary;
      ctx.textAlign = "left";
      const indent = row.depth * 12;
      ctx.fillText(ellipsize(ctx, row.label, plot.nameWidth - indent - 6), indent, centerY);

      ctx.font = `11px ${colors.font}`;
      ctx.fillStyle = colors.muted;
      ctx.textAlign = "right";
      ctx.fillText(
        row.marks.p80 === null ? "—" : formatDayShort(data.startDay + row.marks.p80, lang),
        plot.nameWidth + DATE_WIDTH,
        centerY,
      );

      drawRow(ctx, colors, row.marks, centerY);
    });

    // --- 全体の行 (最後に強調して置く)
    const overallY = plot.rowsTop + data.rows.length * ROW_HEIGHT + ROW_HEIGHT / 2;
    ctx.font = `600 12px ${colors.font}`;
    ctx.fillStyle = colors.ink;
    ctx.textAlign = "left";
    ctx.fillText(t("sched.overall"), 0, overallY);
    ctx.font = `11px ${colors.font}`;
    ctx.fillStyle = colors.secondary;
    ctx.textAlign = "right";
    ctx.fillText(
      data.overallMarks.p80 === null
        ? "—"
        : formatDayShort(data.startDay + data.overallMarks.p80, lang),
      plot.nameWidth + DATE_WIDTH,
      overallY,
    );
    drawRow(ctx, colors, data.overallMarks, overallY);

    // --- 全体の完了確率カーブ
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = `11px ${colors.font}`;
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(plot.curveBottom - (CURVE_HEIGHT * i) / 4) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.plotLeft, y);
      ctx.lineTo(plot.plotRight, y);
      ctx.stroke();
      ctx.fillStyle = colors.muted;
      ctx.fillText(`${String(i * 25)}%`, plot.plotLeft - 8, y);
    }

    const points: [number, number][] = Array.from(data.overall.subarray(0, shown), (value, day) => [
      xOfDay(day),
      plot.curveBottom - value * CURVE_HEIGHT,
    ]);
    const first = points[0];
    const last = points[points.length - 1];
    if (first && last) {
      ctx.fillStyle = colors.seriesSoft;
      ctx.beginPath();
      ctx.moveTo(first[0], plot.curveBottom);
      for (const [x, y] of points) ctx.lineTo(x, y);
      ctx.lineTo(last[0], plot.curveBottom);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = colors.series;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(first[0], first[1]);
      for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
      ctx.stroke();
    }

    ctx.strokeStyle = colors.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.plotLeft - 0.5, plot.curveTop);
    ctx.lineTo(plot.plotLeft - 0.5, plot.curveBottom + 0.5);
    ctx.lineTo(plot.plotRight, plot.curveBottom + 0.5);
    ctx.stroke();

    // --- 基準日
    if (data.todayIndex !== null) {
      const x = Math.round(xOfDay(data.todayIndex)) + 0.5;
      ctx.strokeStyle = colors.secondary;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, plot.rowsTop - 6);
      ctx.lineTo(x, plot.curveBottom);
      ctx.stroke();
      ctx.fillStyle = colors.secondary;
      ctx.font = `10px ${colors.font}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(t("sched.today"), x + 4, plot.rowsTop - 8);
    }

    // --- カーソル
    if (focusDay >= 0) {
      const x = Math.round(xOfDay(focusDay)) + 0.5;
      ctx.save();
      ctx.strokeStyle = colors.ink;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plot.rowsTop);
      ctx.lineTo(x, plot.curveBottom);
      ctx.stroke();
      ctx.restore();
    }
  }

  function showTooltip(day: number, clientX: number | null): void {
    if (!model || !layout) return;
    const lang = getLang();
    const box = canvas.getBoundingClientRect();
    const localX = clientX === null ? xOfDay(day) : clientX - box.left;
    const rows = model.rows
      .slice(0, 8)
      .map(
        (row) =>
          `<div>${row.label}: <b>${formatPercent(row.probabilities[day] ?? 0, lang, 0)}</b></div>`,
      )
      .join("");
    tooltip.show(
      `<div><b>${formatDayShort(model.startDay + day, lang)}</b></div>` +
        `<div>${t("sched.overall")}: <b>${formatPercent(model.overall[day] ?? 0, lang, 0)}</b></div>` +
        (rows === "" ? "" : `<hr>${rows}`),
      localX,
      layout.rowsTop + 4,
      box.width,
    );
  }

  const onPointer = (event: PointerEvent): void => {
    if (!model) return;
    const box = canvas.getBoundingClientRect();
    const day = dayAt(event.clientX - box.left);
    if (day < 0) {
      focusDay = -1;
      tooltip.hide();
      draw();
      return;
    }
    focusDay = day;
    draw();
    showTooltip(day, event.clientX);
  };

  const onLeave = (): void => {
    focusDay = -1;
    tooltip.hide();
    draw();
  };

  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("blur", onLeave);
  canvas.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!model) return;
    const last = visibleDays() - 1;
    let next = focusDay;
    const step = event.shiftKey ? 7 : 1;
    if (event.key === "ArrowRight") next = focusDay < 0 ? 0 : Math.min(last, focusDay + step);
    else if (event.key === "ArrowLeft") next = focusDay < 0 ? last : Math.max(0, focusDay - step);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") next = -1;
    else return;

    event.preventDefault();
    focusDay = next;
    draw();
    if (next < 0) tooltip.hide();
    else showTooltip(next, null);
  });

  watchRedraw(canvas, draw);

  return {
    setData(next) {
      model = next;
      focusDay = -1;
      tooltip.hide();
      canvas.style.height = `${String(scheduleHeight(next?.rows.length ?? 0))}px`;
      draw();
    },
    redraw: draw,
  };
}
