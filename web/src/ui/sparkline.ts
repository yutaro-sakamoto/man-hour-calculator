/**
 * 小さな折れ線。**SVG で描く。**
 *
 * canvas のグラフはモジュールを読み込んだときに 1 つ作って使い回す作りで、
 * 詳細の窓のように毎回組み直す場所には置けない (大きさ 0 の canvas に
 * `setupCanvas` は `null` を返し、黙って何も描かない)。SVG なら要素を
 * 作るだけで、開いた瞬間から線が出る。
 */

const NS = "http://www.w3.org/2000/svg";

export interface SparklineOptions {
  /** 0〜1 の値の並び。横軸は等間隔。 */
  values: ArrayLike<number>;
  width?: number;
  height?: number;
  /** 縦線を引く位置 (値の添字)。P50 / P80 の目印に使う。 */
  marks?: (number | null)[];
  label: string;
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

export function sparkline(options: SparklineOptions): SVGSVGElement {
  const width = options.width ?? 220;
  const height = options.height ?? 44;
  const count = options.values.length;

  const svg = el("svg", {
    class: "sparkline",
    viewBox: `0 0 ${String(width)} ${String(height)}`,
    width,
    height,
    role: "img",
    "aria-label": options.label,
    preserveAspectRatio: "none",
  });

  if (count < 2) {
    svg.appendChild(
      el("line", { class: "spark-base", x1: 0, y1: height - 1, x2: width, y2: height - 1 }),
    );
    return svg;
  }

  const x = (index: number): number => (index / (count - 1)) * width;
  const y = (value: number): number => height - 1 - Math.min(1, Math.max(0, value)) * (height - 2);

  let path = `M ${x(0).toFixed(2)} ${y(options.values[0] ?? 0).toFixed(2)}`;
  for (let index = 1; index < count; index++) {
    path += ` L ${x(index).toFixed(2)} ${y(options.values[index] ?? 0).toFixed(2)}`;
  }

  // 面 → 線 → 目印の順。線が面に隠れないように。
  svg.appendChild(
    el("path", {
      class: "spark-area",
      d: `${path} L ${width.toFixed(2)} ${String(height)} L 0 ${String(height)} Z`,
    }),
  );
  svg.appendChild(el("path", { class: "spark-line", d: path }));

  for (const mark of options.marks ?? []) {
    if (mark === null || mark < 0 || mark >= count) continue;
    svg.appendChild(
      el("line", {
        class: "spark-mark",
        x1: x(mark).toFixed(2),
        y1: 0,
        x2: x(mark).toFixed(2),
        y2: height,
      }),
    );
  }
  return svg;
}
