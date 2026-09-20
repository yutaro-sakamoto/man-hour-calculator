/** canvas を使うグラフで共通の下ごしらえ。 */

export interface Palette {
  surface: string;
  series: string;
  seriesSoft: string;
  /** 信頼区間の外側 (P10〜P90)。 */
  band: string;
  /** 信頼区間の内側 (P25〜P75)。 */
  core: string;
  /** 中央値の目印。 */
  marker: string;
  grid: string;
  axis: string;
  ink: string;
  secondary: string;
  muted: string;
  offday: string;
  font: string;
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function readPalette(): Palette {
  return {
    surface: token("--surface"),
    series: token("--series"),
    seriesSoft: token("--series-soft"),
    band: token("--band-outer"),
    core: token("--band-inner"),
    marker: token("--band-marker"),
    grid: token("--grid"),
    axis: token("--axis"),
    ink: token("--ink"),
    secondary: token("--ink-secondary"),
    muted: token("--ink-muted"),
    offday: token("--offday"),
    font: token("--font"),
  };
}

export interface Surface {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

/** 解像度を合わせて描画面を用意する。大きさが 0 のときは `null`。 */
export function setupCanvas(canvas: HTMLCanvasElement): Surface | null {
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!ctx || width === 0 || height === 0) return null;

  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/**
 * 目盛りが半端な値にならないようにしつつ、高さを使い切る上限を選ぶ。
 * 刻みは 1・2・2.5・5 の倍数に限り、分割数 4 と 5 のうち上限が小さい方を採る。
 */
export function niceScale(peak: number): { max: number; ticks: number } {
  let best = { max: peak, ticks: 4 };
  for (const ticks of [4, 5]) {
    const rawStep = peak / ticks;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalized = rawStep / magnitude;
    const multiplier =
      normalized <= 1
        ? 1
        : normalized <= 2
          ? 2
          : normalized <= 2.5
            ? 2.5
            : normalized <= 5
              ? 5
              : 10;
    const max = magnitude * multiplier * ticks;
    if (max < best.max || best.max === peak) best = { max, ticks };
  }
  return best;
}

/** 上端だけ角を丸めた棒。データの終端は 4px 丸め、底は軸に接地させる。 */
export function roundedTopRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, [r, r, 0, 0]);
  ctx.fill();
}

/** 角を丸めた帯。 */
export function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(width, 0.5), height, r);
  ctx.fill();
}

/** 幅に収まるよう末尾を省略する。 */
export function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** 大きさの変化とカラースキームの切り替えで再描画する。 */
export function watchRedraw(canvas: HTMLCanvasElement, draw: () => void): void {
  new ResizeObserver(() => {
    draw();
  }).observe(canvas);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    draw();
  });
}

/** canvas に重ねる吹き出し。 */
export class Tooltip {
  constructor(private readonly element: HTMLElement) {}

  show(html: string, localX: number, localY: number, hostWidth: number): void {
    this.element.innerHTML = html;
    this.element.dataset.visible = "true";
    const width = this.element.offsetWidth;
    this.element.style.left = `${String(Math.max(4, Math.min(localX + 14, hostWidth - width - 4)))}px`;
    this.element.style.top = `${String(localY)}px`;
  }

  hide(): void {
    this.element.dataset.visible = "false";
  }
}
