/* ===== グラフ描画 ==============================================
   ヒストグラムと累積確率カーブを、x 軸を共有する上下 2 枚のパネルとして
   1 つの canvas に描く。
   y 軸をふたつ重ねた二重軸グラフにはしない。棒の高さ (確率) と累積確率は
   スケールが無関係で、重ねると存在しない対応関係が生まれてしまうため。  */

function createChart(canvas, tooltipEl, deps) {
  const ctx = canvas.getContext("2d");
  /** @type {null | {lo:number, hi:number, probs:number[], cdf:number[], p80:number}} */
  let model = null;
  let layout = null;
  let focusBin = -1;

  const PAD = { left: 58, right: 18, top: 34, bottom: 42 };
  const PANEL_GAP = 48;
  const BAR_GAP = 2; // 隣り合う棒は境界線ではなく地の色の隙間で分ける
  const BAR_RADIUS = 4;

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function computeLayout(width, height) {
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom - PANEL_GAP;
    const histH = Math.round(plotH * 0.58);
    const cdfH = plotH - histH;
    return {
      width,
      height,
      plotW,
      left: PAD.left,
      right: width - PAD.right,
      histTop: PAD.top,
      histBottom: PAD.top + histH,
      histH,
      cdfTop: PAD.top + histH + PANEL_GAP,
      cdfBottom: PAD.top + histH + PANEL_GAP + cdfH,
      cdfH,
    };
  }

  const xOf = (value) =>
    layout.left + ((value - model.lo) / (model.hi - model.lo)) * layout.plotW;

  function binCenter(i) {
    const step = (model.hi - model.lo) / model.probs.length;
    return model.lo + (i + 0.5) * step;
  }

  function binRange(i) {
    const step = (model.hi - model.lo) / model.probs.length;
    return [model.lo + i * step, model.lo + (i + 1) * step];
  }

  /** canvas の x 座標 (CSS px) から最も近いビンの添字を返す。 */
  function binAt(px) {
    if (!model || !layout) return -1;
    const t = (px - layout.left) / layout.plotW;
    if (t < -0.02 || t > 1.02) return -1;
    const i = Math.floor(t * model.probs.length);
    return Math.max(0, Math.min(model.probs.length - 1, i));
  }

  /** 目盛りが 1.1% / 2.3% のような半端な値にならないようにしつつ、
   *  グラフの高さを使い切る上限を選ぶ。
   *  刻みは 1・2・2.5・5 の倍数に限り、分割数 4 と 5 のうち上限が小さくなる方を採る
   *  (きりのよさと「山が小さく潰れない」ことの両立)。 */
  function niceScale(peak) {
    let best = null;
    for (const ticks of [4, 5]) {
      const rawStep = peak / ticks;
      const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
      const normalized = rawStep / magnitude;
      const step =
        magnitude *
        (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10);
      const max = step * ticks;
      if (!best || max < best.max) best = { max, ticks };
    }
    return best;
  }

  function roundedTopRect(x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h));
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, w, h, [radius, radius, 0, 0]);
    } else {
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
    }
    ctx.fill();
  }

  function drawEmpty(colors) {
    ctx.fillStyle = colors.muted;
    ctx.font = "13px " + token("--font");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(deps.t("chart.noData"), layout.width / 2, layout.height / 2);
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    layout = computeLayout(width, height);
    const colors = {
      surface: token("--surface"),
      series: token("--series"),
      seriesSoft: token("--series-soft"),
      grid: token("--grid"),
      axis: token("--axis"),
      ink: token("--ink"),
      secondary: token("--ink-secondary"),
      muted: token("--ink-muted"),
    };
    const font = token("--font");

    if (!model || model.probs.length === 0) {
      drawEmpty(colors);
      return;
    }

    const scale = niceScale(Math.max(...model.probs, 1e-12));
    const maxProb = scale.max;

    // --- パネル見出し。2 枚は x 軸だけを共有する別々のグラフなので、
    //     それぞれに何のグラフか書いておく (凡例は 1 系列なので不要)。
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (const [key, top] of [
      ["chart.histTitle", layout.histTop],
      ["chart.cdfTitle", layout.cdfTop],
    ]) {
      ctx.fillStyle = colors.secondary;
      ctx.font = "600 12px " + font;
      ctx.fillText(deps.t(key), layout.left, top - 12);
    }

    // --- 目盛りとグリッド (実線のヘアライン。破線は「しきい値」に見えるので使わない)
    ctx.lineWidth = 1;
    ctx.font = "11px " + font;
    ctx.textBaseline = "middle";

    // ヒストグラム側の y 軸: 0 から最大確率まで 4 分割
    ctx.textAlign = "right";
    for (let i = 0; i <= scale.ticks; i++) {
      const v = (maxProb * i) / scale.ticks;
      const y = Math.round(layout.histBottom - (layout.histH * i) / scale.ticks) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(layout.left, y);
      ctx.lineTo(layout.right, y);
      ctx.stroke();
      ctx.fillStyle = colors.muted;
      // 刻みが細かいときだけ小数第 1 位まで出す。
      ctx.fillText(deps.formatPercent(v, maxProb >= 0.05 ? 0 : 1), layout.left - 9, y);
    }

    // 累積側の y 軸: 0〜100% を 4 分割
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(layout.cdfBottom - (layout.cdfH * i) / 4) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(layout.left, y);
      ctx.lineTo(layout.right, y);
      ctx.stroke();
      ctx.fillStyle = colors.muted;
      ctx.fillText(`${i * 25}%`, layout.left - 9, y);
    }

    // --- ヒストグラムの棒
    const slotW = layout.plotW / model.probs.length;
    const gap = slotW > 6 ? BAR_GAP : Math.max(0.5, slotW * 0.18);
    const barW = Math.max(1, slotW - gap);
    ctx.fillStyle = colors.series;
    for (let i = 0; i < model.probs.length; i++) {
      const h = (model.probs[i] / maxProb) * layout.histH;
      if (h <= 0) continue;
      roundedTopRect(
        layout.left + i * slotW + gap / 2,
        layout.histBottom - h,
        barW,
        h,
        Math.min(BAR_RADIUS, barW / 2),
      );
    }

    // --- 累積カーブ (面を薄く敷いてから 2px の線)
    const points = model.cdf.map((c, i) => [
      layout.left + (i * layout.plotW) / (model.cdf.length - 1),
      layout.cdfBottom - c * layout.cdfH,
    ]);
    ctx.fillStyle = colors.seriesSoft;
    ctx.beginPath();
    ctx.moveTo(points[0][0], layout.cdfBottom);
    for (const [x, y] of points) ctx.lineTo(x, y);
    ctx.lineTo(points[points.length - 1][0], layout.cdfBottom);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = colors.series;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();

    // --- 軸線
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.axis;
    for (const [top, bottom] of [
      [layout.histTop, layout.histBottom],
      [layout.cdfTop, layout.cdfBottom],
    ]) {
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
      ctx.fillText(deps.formatNumber(value), xOf(value), layout.cdfBottom + 9);
    }
    ctx.fillStyle = colors.secondary;
    ctx.fillText(
      deps.t("chart.xAxis", { unit: deps.t("unit.days") }),
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
      // 累積 80% の水平ガイド (カーブとの交点が P80)
      const y80 = Math.round(layout.cdfBottom - 0.8 * layout.cdfH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(layout.left, y80);
      ctx.lineTo(x, y80);
      ctx.stroke();

      const label = `${deps.t("chart.p80Marker")} ${deps.formatNumber(model.p80)}`;
      ctx.font = "11px " + font;
      const w = ctx.measureText(label).width + 12;
      const boxX = Math.min(x + 5, layout.right - w);
      ctx.fillStyle = colors.secondary;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(boxX, layout.histTop + 3, w, 17, 4);
      else ctx.rect(boxX, layout.histTop + 3, w, 17);
      ctx.fill();
      ctx.fillStyle = colors.surface;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, boxX + 6, layout.histTop + 12);
    }

    if (focusBin >= 0) drawCrosshair(focusBin, colors, font);
  }

  function drawCrosshair(bin, colors, font) {
    const x = Math.round(xOf(binCenter(bin))) + 0.5;
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

    // 棒を地の色のリングで囲って浮かせる (枠線ではなく 2px の隙間)
    const slotW = layout.plotW / model.probs.length;
    const maxProb = niceScale(Math.max(...model.probs, 1e-12)).max;
    const h = (model.probs[bin] / maxProb) * layout.histH;
    if (h > 0) {
      ctx.strokeStyle = colors.surface;
      ctx.lineWidth = 2;
      ctx.strokeRect(
        layout.left + bin * slotW + BAR_GAP / 2 - 1,
        layout.histBottom - h - 1,
        Math.max(1, slotW - BAR_GAP) + 2,
        h + 1,
      );
    }
    // 累積カーブ上の点
    const cum = model.cdf[bin + 1];
    ctx.fillStyle = colors.series;
    ctx.strokeStyle = colors.surface;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, layout.cdfBottom - cum * layout.cdfH, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    void font;
  }

  function showTooltip(bin, clientX) {
    const [from, to] = binRange(bin);
    tooltipEl.innerHTML =
      `<div>${deps.t("chart.tooltipRange", {
        from: deps.formatNumber(from),
        to: deps.formatNumber(to),
        unit: deps.t("unit.days"),
      })}</div>` +
      `<div>${deps.t("chart.tooltipProb")}: <b>${deps.formatPercent(model.probs[bin], 2)}</b></div>` +
      `<div>${deps.t("chart.tooltipCum")}: <b>${deps.formatPercent(model.cdf[bin + 1], 1)}</b></div>`;
    tooltipEl.dataset.visible = "true";

    const box = canvas.getBoundingClientRect();
    const local = clientX === null ? xOf(binCenter(bin)) : clientX - box.left;
    const w = tooltipEl.offsetWidth;
    tooltipEl.style.left = `${Math.max(4, Math.min(local + 14, box.width - w - 4))}px`;
    tooltipEl.style.top = `${layout.histTop + 26}px`;
  }

  function hideTooltip() {
    tooltipEl.dataset.visible = "false";
  }

  function onPointer(event) {
    if (!model) return;
    const box = canvas.getBoundingClientRect();
    const bin = binAt(event.clientX - box.left);
    if (bin < 0) {
      focusBin = -1;
      hideTooltip();
      draw();
      return;
    }
    focusBin = bin;
    draw();
    showTooltip(bin, event.clientX);
  }

  function onLeave() {
    focusBin = -1;
    hideTooltip();
    draw();
  }

  function onKeyDown(event) {
    if (!model) return;
    const last = model.probs.length - 1;
    let next = focusBin;
    if (event.key === "ArrowRight") next = focusBin < 0 ? 0 : Math.min(last, focusBin + 1);
    else if (event.key === "ArrowLeft") next = focusBin < 0 ? last : Math.max(0, focusBin - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") next = -1;
    else return;

    event.preventDefault();
    focusBin = next;
    draw();
    if (next < 0) hideTooltip();
    else showTooltip(next, null);
  }

  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("blur", onLeave);
  canvas.addEventListener("keydown", onKeyDown);

  if (window.ResizeObserver) {
    new ResizeObserver(() => draw()).observe(canvas);
  } else {
    window.addEventListener("resize", draw);
  }
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  if (scheme.addEventListener) scheme.addEventListener("change", draw);

  return {
    setData(next) {
      model = next;
      focusBin = -1;
      hideTooltip();
      draw();
    },
    redraw: draw,
  };
}
