/**
 * 完了日の見通しを描く。
 *
 * 上段はタスクごとの完了予測。帯は「いつ終わりそうか」の幅そのもので、
 * 外側が P10〜P90、内側の濃い部分が P25〜P75、縦線が P50。
 * 下段は全体が完了している確率のカーブで、x 軸 (日付) を上段と共有する。
 *
 * 帯の下の細い線は**実績**。着手日から完了日 (まだなら基準日) まで引く。
 * 予測の帯と同じ行に置くのは、「予定より遅れているか」を 1 行で読めるように
 * するため。名前の右には進捗率を添える。
 *
 * 行を押すと、そのタスクの詳細が開く (`onSelect`)。キーボードでは
 * ↑↓ で行を選び、Enter で開く。
 *
 * 帯の濃淡は同一色相の順序ランプ。値の大小ではなく「確からしさの段階」を
 * 表しているので、カテゴリ色ではなくランプを使う。
 */

import {
  formatDayShort,
  formatMonthShort,
  formatNumber,
  formatPercent,
  type Lang,
} from "../format.ts";
import { t } from "../i18n.ts";
import type { Progress } from "../model/progress.ts";
import {
  isNonWorkingDay,
  type ActualSpan,
  type ScheduleMarks,
  type ScheduleModel,
} from "../model/schedule.ts";
import {
  Tooltip,
  ellipsize,
  readPalette,
  roundedRect,
  setupCanvas,
  watchRedraw,
  type TooltipRow,
} from "./common.ts";

const PAD = { top: 30, right: 16, bottom: 44 };
const NAME_MIN = 150;
const NAME_MAX = 260;
const DATE_WIDTH = 78;
/** 進捗率の欄。小さな棒と「100%」が収まる幅。 */
const PROGRESS_WIDTH = 72;
const PROGRESS_BAR = 30;
export const ROW_HEIGHT = 26;
const BAND_HEIGHT = 12;
const CURVE_HEIGHT = 118;
const PANEL_GAP = 46;

/** 行数から canvas の高さを求める。軸の帯まで含めた高さにする。 */
export function scheduleHeight(rowCount: number): number {
  return PAD.top + Math.max(1, rowCount + 1) * ROW_HEIGHT + PANEL_GAP + CURVE_HEIGHT + PAD.bottom;
}

/** 押された行を知らせる。全体の行は開く先が無いので知らせない。 */
export type SelectRow = (taskId: string) => void;

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
  onSelect: SelectRow = () => undefined,
): ScheduleChart {
  const tooltip = new Tooltip(tooltipElement);
  let model: ScheduleModel | null = null;
  let layout: Layout | null = null;
  let focusDay = -1;
  /** 指している行 (マウスでもキーボードでも)。-1 なら無し。 */
  let focusRow = -1;

  const layoutFor = (width: number, rowCount: number): Layout => {
    const nameWidth = Math.max(NAME_MIN, Math.min(NAME_MAX, width * 0.26));
    const plotLeft = nameWidth + PROGRESS_WIDTH + DATE_WIDTH + 8;
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

  /** y 座標にあるタスクの行。全体の行や行の外なら -1。 */
  const rowAt = (localY: number): number => {
    if (!model || !layout) return -1;
    if (localY < layout.rowsTop) return -1;
    const index = Math.floor((localY - layout.rowsTop) / ROW_HEIGHT);
    return index < model.rows.length ? index : -1;
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

  /**
   * 実績の線。帯の真下に細く引く。
   *
   * 期間の外に出る部分は端で切る。着手が期間の初日より前でも、線は左端から
   * 始まるだけで消えない (消えると「着手していない」と読めてしまう)。
   */
  function drawActual(
    ctx: CanvasRenderingContext2D,
    colors: ReturnType<typeof readPalette>,
    actual: ActualSpan,
    centerY: number,
  ): void {
    if (!layout || !model || actual.start === null) return;
    const last = visibleDays() - 1;
    const endDay = actual.end ?? model.todayIndex;
    if (endDay === null || endDay < 0 || actual.start > last) return;
    const left = actual.start < 0 ? layout.plotLeft : xOfDay(actual.start) - 1;
    const right = endDay > last ? layout.plotRight : xOfDay(endDay) + 1;
    const y = centerY + BAND_HEIGHT / 2 + 2;
    ctx.fillStyle = colors.ink;
    ctx.fillRect(left, y, Math.max(2, right - left), 3);
    // 着手が図の左端より前なら、線がその先へ続いていることを矢じりで示す。
    // 期間の初日は基準日なので、進行中のタスクはたいていここに当たる。
    if (actual.start < 0) {
      ctx.beginPath();
      ctx.moveTo(left - 5, y + 1.5);
      ctx.lineTo(left, y - 2);
      ctx.lineTo(left, y + 5);
      ctx.closePath();
      ctx.fill();
    }
    // 終わっているものだけ端を立てる。まだ続いている線と見分けるため。
    if (actual.end !== null && actual.end <= last) {
      ctx.fillRect(Math.round(right) - 2, y - 3, 2, 6);
    }
  }

  /** 名前の右の進捗率。小さな棒と数字。 */
  function drawProgress(
    ctx: CanvasRenderingContext2D,
    colors: ReturnType<typeof readPalette>,
    progress: Progress,
    centerY: number,
    lang: Lang,
  ): void {
    if (!layout) return;
    const left = layout.nameWidth + 4;
    ctx.fillStyle = colors.grid;
    ctx.fillRect(left, centerY - 2, PROGRESS_BAR, 4);
    ctx.fillStyle = colors.series;
    ctx.fillRect(left, centerY - 2, PROGRESS_BAR * Math.min(1, Math.max(0, progress.ratio)), 4);
    ctx.font = `11px ${colors.font}`;
    ctx.fillStyle = colors.secondary;
    ctx.textAlign = "right";
    ctx.fillText(
      formatPercent(progress.ratio, lang, 0),
      layout.nameWidth + PROGRESS_WIDTH,
      centerY,
    );
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

    // --- 指している行。押せば開くことが分かるように、行ごと薄く塗る。
    if (focusRow >= 0 && focusRow < data.rows.length) {
      ctx.save();
      ctx.fillStyle = colors.series;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(0, plot.rowsTop + focusRow * ROW_HEIGHT, plot.plotRight, ROW_HEIGHT);
      ctx.restore();
    }

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
        plot.nameWidth + PROGRESS_WIDTH + DATE_WIDTH,
        centerY,
      );

      drawProgress(ctx, colors, row.progress, centerY, lang);
      drawRow(ctx, colors, row.marks, centerY);
      drawActual(ctx, colors, row.actual, centerY);
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
      plot.nameWidth + PROGRESS_WIDTH + DATE_WIDTH,
      overallY,
    );
    drawProgress(ctx, colors, data.overallProgress, overallY, lang);
    drawRow(ctx, colors, data.overallMarks, overallY);
    drawActual(ctx, colors, data.overallActual, overallY);

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

  /** 1 行ぶんの吹き出し。進捗と実績を、予測と並べて読めるように。 */
  function rowTooltip(index: number, day: number): TooltipRow[] {
    if (!model) return [];
    const row = model.rows[index];
    if (!row) return [];
    const lang = getLang();
    const start = model.startDay;
    const date = (value: number | null): string =>
      value === null ? "—" : formatDayShort(start + value, lang);
    const lines: TooltipRow[] = [
      // タスク名は利用者が書いた文字列なので、**組み立てずに部品として渡す**。
      { label: row.label, heading: true },
      { label: t("summary.progress"), value: formatPercent(row.progress.ratio, lang, 0) },
      {
        label: `${t("progress.spent")} / ${t("progress.remaining")}`,
        value: `${formatNumber(row.progress.spent, lang, 1)} / ${formatNumber(
          row.progress.remaining,
          lang,
          1,
        )} ${t("unit.days")}`,
      },
    ];
    if (row.actual.start !== null) {
      lines.push({
        label: t("sched.actual"),
        value: `${date(row.actual.start)} – ${row.actual.end === null ? "" : date(row.actual.end)}`,
      });
    }
    lines.push(
      { label: t("summary.finishP50"), value: date(row.marks.p50), rule: true },
      { label: t("summary.finishP80"), value: date(row.marks.p80) },
    );
    if (day >= 0) {
      lines.push({
        label: `${formatDayShort(start + day, lang)} ${t("sched.probability")}`,
        value: formatPercent(row.probabilities[day] ?? 0, lang, 0),
      });
    }
    lines.push({ label: t("sched.clickToOpen"), rule: true });
    return lines;
  }

  function showTooltip(day: number, clientX: number | null): void {
    if (!model || !layout) return;
    const box = canvas.getBoundingClientRect();
    if (focusRow >= 0) {
      const x = clientX === null ? (day >= 0 ? xOfDay(day) : layout.plotLeft) : clientX - box.left;
      const y = layout.rowsTop + (focusRow + 1) * ROW_HEIGHT;
      tooltip.show(rowTooltip(focusRow, day), x, y, box.width);
      return;
    }
    if (day < 0) {
      tooltip.hide();
      return;
    }
    const lang = getLang();
    const localX = clientX === null ? xOfDay(day) : clientX - box.left;
    // タスク名は利用者が書いた文字列なので、**組み立てずに部品として渡す**。
    const rows: TooltipRow[] = [
      { label: formatDayShort(model.startDay + day, lang), heading: true },
      {
        label: t("sched.overall"),
        value: formatPercent(model.overall[day] ?? 0, lang, 0),
      },
      ...model.rows.slice(0, 8).map((row, index) => ({
        label: row.label,
        value: formatPercent(row.probabilities[day] ?? 0, lang, 0),
        rule: index === 0,
      })),
    ];
    tooltip.show(rows, localX, layout.rowsTop + 4, box.width);
  }

  const onPointer = (event: PointerEvent): void => {
    if (!model) return;
    const box = canvas.getBoundingClientRect();
    const day = dayAt(event.clientX - box.left);
    focusRow = rowAt(event.clientY - box.top);
    focusDay = day;
    canvas.style.cursor = focusRow >= 0 ? "pointer" : "";
    draw();
    if (day < 0 && focusRow < 0) {
      tooltip.hide();
      return;
    }
    showTooltip(day, event.clientX);
  };

  const onLeave = (): void => {
    focusDay = -1;
    focusRow = -1;
    canvas.style.cursor = "";
    tooltip.hide();
    draw();
  };

  const select = (index: number): void => {
    const row = model?.rows[index];
    if (row) onSelect(row.id);
  };

  // `pointerdown` は吹き出しに使っている (指で触ったとき)。開くのは `click`
  // にする。押し下げで開くと、指でなぞって吹き出しを見るだけで窓が開く。
  canvas.addEventListener("click", (event: MouseEvent) => {
    const box = canvas.getBoundingClientRect();
    const index = rowAt(event.clientY - box.top);
    if (index >= 0) select(index);
  });

  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("blur", onLeave);
  canvas.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!model) return;
    const rowCount = model.rows.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rowCount === 0) return;
      event.preventDefault();
      focusRow =
        event.key === "ArrowDown"
          ? Math.min(rowCount - 1, focusRow + 1)
          : focusRow < 0
            ? rowCount - 1
            : Math.max(0, focusRow - 1);
      draw();
      showTooltip(focusDay, null);
      return;
    }
    if (event.key === "Enter" && focusRow >= 0) {
      event.preventDefault();
      select(focusRow);
      return;
    }
    const last = visibleDays() - 1;
    let next: number;
    const step = event.shiftKey ? 7 : 1;
    if (event.key === "ArrowRight") next = focusDay < 0 ? 0 : Math.min(last, focusDay + step);
    else if (event.key === "ArrowLeft") next = focusDay < 0 ? last : Math.max(0, focusDay - step);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") next = -1;
    else return;

    event.preventDefault();
    focusDay = next;
    if (next < 0) focusRow = -1;
    draw();
    if (next < 0) tooltip.hide();
    else showTooltip(next, null);
  });

  watchRedraw(canvas, draw);

  return {
    setData(next) {
      model = next;
      focusDay = -1;
      // 行の数が変わると、指していた行が別のタスクに化ける。
      focusRow = -1;
      tooltip.hide();
      canvas.style.height = `${String(scheduleHeight(next?.rows.length ?? 0))}px`;
      draw();
    },
    redraw: draw,
  };
}
