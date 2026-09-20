/* ===== アプリ本体 ==============================================
   WASM の起動、タスク表、設定、計算結果の描画。
   ネットワークアクセスは一切行わない (WASM も base64 で同梱済み)。   */
(function () {
  "use strict";

  /* --- ABI 定数。crates/core/src/abi.rs と一致させること ------- */
  const MAGIC = 20250920;
  const ABI_VERSION = 1;
  const REQ_HEADER = 12;
  const RESP_HEADER = 13;
  const ENGINE = { mc: 0, conv: 1 };
  const DIST = { pert: 0, tri: 1 };

  const STORAGE_LANG = "mhc.lang.v1";

  /* --- 状態 --------------------------------------------------- */
  let wasm = null;
  let lang = detectLanguage();
  let tasks = [];
  let nextId = 1;
  let lastResult = null;
  let computeTimer = null;

  const $ = (sel) => document.querySelector(sel);

  /* ===== i18n ================================================= */
  function detectLanguage() {
    try {
      const saved = localStorage.getItem(STORAGE_LANG);
      if (saved === "ja" || saved === "en") return saved;
    } catch (_) {
      /* プライベートモードなどで localStorage が使えなくても動かす */
    }
    return (navigator.language || "en").toLowerCase().startsWith("ja") ? "ja" : "en";
  }

  function t(key, params) {
    const table = I18N[lang] || I18N.en;
    let text = table[key] !== undefined ? table[key] : key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.split("{" + k + "}").join(String(v));
      }
    }
    return text;
  }

  function applyI18n() {
    document.documentElement.lang = lang;
    document.title = t("app.title");
    // 静的なマークアップでも単位だけは差し込めるようにしておく
    // (「総工数 ({unit})」のような見出しのため)。
    const common = { unit: t("unit.days") };
    for (const el of document.querySelectorAll("[data-i18n]")) {
      el.textContent = t(el.dataset.i18n, common);
    }
    for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    }
    for (const el of document.querySelectorAll("[data-i18n-aria]")) {
      el.setAttribute("aria-label", t(el.dataset.i18nAria));
    }
    for (const btn of document.querySelectorAll(".lang-toggle button")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.lang === lang));
    }
  }

  /* ===== 数値の書式 ============================================ */
  function formatNumber(value, digits) {
    const d = digits === undefined ? (Math.abs(value) >= 100 ? 0 : 1) : digits;
    return new Intl.NumberFormat(lang === "ja" ? "ja-JP" : "en-US", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    }).format(value);
  }

  function formatPercent(fraction, digits) {
    return formatNumber(fraction * 100, digits === undefined ? 1 : digits) + "%";
  }

  /* ===== WASM の起動 =========================================== */
  function decodeBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function boot() {
    // fetch() は使わない。file:// で開いたページからの fetch は CORS で
    // 弾かれるため、WASM は base64 文字列として HTML に埋め込んである。
    const { instance } = await WebAssembly.instantiate(decodeBase64(WASM_BASE64), {});
    const e = instance.exports;
    if (e.abi_version() !== ABI_VERSION) {
      throw new Error(`ABI version mismatch: wasm=${e.abi_version()} js=${ABI_VERSION}`);
    }
    wasm = {
      memory: e.memory,
      alloc: e.alloc,
      dealloc: e.dealloc,
      compute: e.compute,
      lastLen: e.last_response_len,
    };
  }

  /* ===== 計算 ================================================= */
  function buildRequest(rows, settings) {
    const req = new Float64Array(REQ_HEADER + rows.length * 3);
    req[0] = MAGIC;
    req[1] = ABI_VERSION;
    req[2] = settings.engine;
    req[3] = settings.dist;
    req[4] = settings.lambda;
    req[5] = rows.length;
    req[6] = settings.iterations;
    req[7] = settings.seed;
    req[8] = settings.bins;
    req[9] = settings.grid;
    req[10] = 0; // 相関 (M2 で実装)
    req[11] = 0; // 予約
    rows.forEach((row, i) => {
      req[REQ_HEADER + i * 3] = row.min;
      req[REQ_HEADER + i * 3 + 1] = row.likely;
      req[REQ_HEADER + i * 3 + 2] = row.max;
    });
    return req;
  }

  function callWasm(request) {
    const byteLength = request.length * 8;
    const ptr = wasm.alloc(byteLength);
    if (ptr === 0) throw new Error("wasm alloc failed");
    try {
      new Float64Array(wasm.memory.buffer, ptr, request.length).set(request);
      const outPtr = wasm.compute(ptr, request.length);
      const outLen = wasm.lastLen();
      // メモリが伸びた場合に備え、compute のあとで buffer を読み直す。
      return new Float64Array(wasm.memory.buffer, outPtr, outLen).slice();
    } finally {
      wasm.dealloc(ptr, byteLength);
    }
  }

  function parseResponse(resp) {
    const status = resp[0];
    if (status !== 0) return { status, detail: resp[5] };

    const bins = resp[2];
    const pctCount = resp[3];
    const taskCount = resp[4];
    let at = RESP_HEADER;
    const take = (n) => {
      const slice = Array.from(resp.subarray(at, at + n));
      at += n;
      return slice;
    };
    return {
      status,
      mean: resp[6],
      sd: resp[7],
      lo: resp[8],
      hi: resp[9],
      totalMin: resp[10],
      totalLikely: resp[11],
      totalMax: resp[12],
      probs: take(bins),
      cdf: take(bins + 1),
      levels: take(pctCount),
      values: take(pctCount),
      sensitivity: take(taskCount),
    };
  }

  /* ===== タスク表 ============================================== */
  function makeTask(name, min, likely, max) {
    return { id: nextId++, name, min, likely, max, enabled: true };
  }

  function sampleTasks() {
    const names =
      lang === "ja"
        ? ["要件定義", "API 実装", "画面実装"]
        : ["Requirements", "API implementation", "UI implementation"];
    return [
      makeTask(names[0], "5", "8", "20"),
      makeTask(names[1], "2", "3", "5"),
      makeTask(names[2], "10", "15", "40"),
    ];
  }

  /** 行を数値に変換する。妥当でなければ null。 */
  function parseRow(task) {
    const min = Number(task.min);
    const likely = Number(task.likely);
    const max = Number(task.max);
    const ok =
      task.min.trim() !== "" &&
      task.likely.trim() !== "" &&
      task.max.trim() !== "" &&
      Number.isFinite(min) &&
      Number.isFinite(likely) &&
      Number.isFinite(max) &&
      min >= 0 &&
      min <= likely &&
      likely <= max;
    return ok ? { min, likely, max } : null;
  }

  function renderTasks() {
    const body = $("#task-body");
    body.innerHTML = "";
    $("#tasks-empty").hidden = tasks.length > 0;

    for (const task of tasks) {
      const parsed = parseRow(task);
      const tr = document.createElement("tr");
      tr.dataset.invalid = String(task.enabled && parsed === null);
      const label = task.name || t("tasks.untitled");

      const useCell = document.createElement("td");
      const use = document.createElement("input");
      use.type = "checkbox";
      use.checked = task.enabled;
      use.setAttribute("aria-label", t("tasks.useRow", { name: label }));
      use.addEventListener("change", () => {
        task.enabled = use.checked;
        refresh();
      });
      useCell.appendChild(use);
      tr.appendChild(useCell);

      const nameCell = document.createElement("td");
      const name = document.createElement("input");
      name.type = "text";
      name.value = task.name;
      name.placeholder = t("tasks.placeholder");
      name.addEventListener("input", () => {
        task.name = name.value;
        scheduleCompute();
      });
      nameCell.appendChild(name);
      tr.appendChild(nameCell);

      for (const field of ["min", "likely", "max"]) {
        const cell = document.createElement("td");
        cell.className = "num";
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "0.5";
        input.value = task[field];
        input.setAttribute("aria-label", `${label} — ${t("tasks." + field)}`);
        if (task.enabled && parsed === null) input.setAttribute("aria-invalid", "true");
        input.addEventListener("input", () => {
          task[field] = input.value;
          refresh();
        });
        cell.appendChild(input);
        tr.appendChild(cell);
      }

      const removeCell = document.createElement("td");
      const remove = document.createElement("button");
      remove.className = "icon";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", t("tasks.removeRow", { name: label }));
      remove.addEventListener("click", () => {
        tasks = tasks.filter((x) => x.id !== task.id);
        refresh();
      });
      removeCell.appendChild(remove);
      tr.appendChild(removeCell);

      body.appendChild(tr);
    }

    const rows = tasks.filter((x) => x.enabled).map(parseRow).filter(Boolean);
    const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0);
    $("#task-totals").textContent = t("tasks.totals", {
      count: rows.length,
      min: formatNumber(sum("min")),
      likely: formatNumber(sum("likely")),
      max: formatNumber(sum("max")),
      unit: t("unit.days"),
    });
  }

  /* ===== 設定 ================================================= */
  function readSettings() {
    const engine = Number($("#engine").value);
    return {
      engine,
      dist: Number($("#dist").value),
      lambda: Number($("#lambda").value),
      iterations: Number($("#iterations").value),
      seed: Number($("#seed").value),
      bins: Number($("#bins").value),
      grid: Number($("#grid").value),
    };
  }

  function syncSettingsUi() {
    const settings = readSettings();
    const isMonteCarlo = settings.engine === ENGINE.mc;
    // 使わない設定は触れないようにして、どちらのエンジンかを形でも示す。
    for (const [id, active] of [
      ["iterations", isMonteCarlo],
      ["seed", isMonteCarlo],
      ["grid", !isMonteCarlo],
      ["lambda", settings.dist === DIST.pert],
    ]) {
      const input = $("#" + id);
      input.disabled = !active;
      input.closest(".control").dataset.disabled = String(!active);
    }
    $("#engine-hint").textContent = t(isMonteCarlo ? "settings.hint.mc" : "settings.hint.conv");
  }

  /* ===== 結果の描画 ============================================ */
  let runCount = 0;

  function setStatus(message, tone) {
    const el = $("#status");
    el.textContent = message;
    el.dataset.tone = tone || "info";
    // 計算が一巡したことを外から観測できるようにする。E2E がこれを待つ。
    el.dataset.run = String(++runCount);
  }

  function renderTiles(result) {
    const unit = `<span class="unit">${t("unit.days")}</span>`;
    const tiles = [
      ["results.mean", result.mean, false],
      ["results.p50", result.values[2], false],
      ["results.p80", result.values[4], true],
      ["results.p90", result.values[5], false],
      ["results.sd", result.sd, false],
      ["results.buffer", result.values[4] - result.totalLikely, false],
    ];
    $("#tiles").innerHTML = tiles
      .map(([key, raw, accent]) => {
        const shown = (key === "results.buffer" && raw >= 0 ? "+" : "") + formatNumber(raw);
        // data-value は書式に左右されない生の数値。テストと支援技術のための値。
        return (
          `<div class="tile${accent ? " accent" : ""}" data-key="${key}" data-value="${raw}">` +
          `<dt>${t(key)}</dt><dd>${shown}${unit}</dd></div>`
        );
      })
      .join("");
    $("#buffer-hint").textContent = t("results.bufferHint");
  }

  function renderPercentileTable(result) {
    $("#pct-body").innerHTML = result.levels
      .map((level, i) => {
        const pct = Math.round(level * 100);
        return (
          `<tr data-highlight="${pct === 80}">` +
          `<th scope="row">P${pct}</th>` +
          `<td class="num">${formatNumber(result.values[i])}</td>` +
          `<td>${t("pct.meaningText", { pct })}</td>` +
          `</tr>`
        );
      })
      .join("");
  }

  function renderDataTable(result) {
    const step = (result.hi - result.lo) / result.probs.length;
    $("#data-body").innerHTML = result.probs
      .map((p, i) => {
        const from = result.lo + i * step;
        return (
          `<tr><td class="num">${formatNumber(from)} – ${formatNumber(from + step)}</td>` +
          `<td class="num">${formatPercent(p, 2)}</td>` +
          `<td class="num">${formatPercent(result.cdf[i + 1], 1)}</td></tr>`
        );
      })
      .join("");
  }

  /** 累積確率を線形補間で読む。グラフの目視とスライダの数字を一致させる。 */
  function cumulativeAt(result, value) {
    const n = result.probs.length;
    const step = (result.hi - result.lo) / n;
    if (value <= result.lo) return result.cdf[0];
    if (value >= result.hi) return result.cdf[n];
    const pos = (value - result.lo) / step;
    const i = Math.min(n - 1, Math.floor(pos));
    const frac = pos - i;
    return result.cdf[i] + frac * (result.cdf[i + 1] - result.cdf[i]);
  }

  const PROBE_STEPS = 1000;

  /** スライダの位置 (0..PROBE_STEPS の整数) を工数に写像する。
   *  min/max に端数の実数を入れるとブラウザごとに丸めが変わるため、
   *  目盛りは整数に固定して換算は JS 側で行う。 */
  function probeValue() {
    const position = Number($("#probe-range").value) / PROBE_STEPS;
    return lastResult.lo + position * (lastResult.hi - lastResult.lo);
  }

  function renderProbe(result) {
    const probe = $("#probe-range");
    const span = result.hi - result.lo;
    const atP80 = span > 0 ? ((result.values[4] - result.lo) / span) * PROBE_STEPS : PROBE_STEPS / 2;
    probe.value = String(Math.max(0, Math.min(PROBE_STEPS, Math.round(atP80))));
    updateProbe();
  }

  function updateProbe() {
    if (!lastResult) return;
    const value = probeValue();
    $("#probe-range").setAttribute(
      "aria-valuetext",
      `${formatNumber(value)} ${t("unit.days")}`,
    );
    $("#probe-output").innerHTML = t("probe.result", {
      days: formatNumber(value),
      unit: t("unit.days"),
      prob: formatNumber(cumulativeAt(lastResult, value) * 100, 1),
    });
  }

  /* ===== 実行 ================================================= */
  let chart = null;

  function scheduleCompute() {
    clearTimeout(computeTimer);
    computeTimer = setTimeout(compute, 220);
  }

  function refresh() {
    renderTasks();
    syncSettingsUi();
    scheduleCompute();
  }

  function showError(message) {
    setStatus(message, "error");
    $("#results").hidden = true;
    lastResult = null;
    if (chart) chart.setData(null);
  }

  function compute() {
    if (!wasm) return;
    const rows = tasks.filter((x) => x.enabled).map(parseRow);
    if (rows.length === 0 || rows.some((r) => r === null)) {
      const badIndex = rows.findIndex((r) => r === null);
      showError(badIndex >= 0 ? t("error.4", { index: badIndex + 1 }) : t("status.noTasks"));
      return;
    }

    const settings = readSettings();
    const started = performance.now();
    let result;
    try {
      result = parseResponse(callWasm(buildRequest(rows, settings)));
    } catch (error) {
      showError(t("error.boot", { message: String(error) }));
      return;
    }
    const elapsed = Math.round(performance.now() - started);

    if (result.status !== 0) {
      const key = "error." + result.status;
      const message =
        I18N[lang][key] !== undefined
          ? t(key, { index: result.detail + 1 })
          : t("error.unknown", { code: result.status });
      showError(message);
      return;
    }

    lastResult = result;
    $("#results").hidden = false;
    setStatus(
      t("status.done", {
        engine: t(settings.engine === ENGINE.mc ? "settings.engine.mc" : "settings.engine.conv"),
        ms: elapsed,
      }),
    );
    renderTiles(result);
    renderPercentileTable(result);
    renderDataTable(result);
    renderProbe(result);
    chart.setData({
      lo: result.lo,
      hi: result.hi,
      probs: result.probs,
      cdf: result.cdf,
      p80: result.values[4],
    });
  }

  function rerenderEverything() {
    applyI18n();
    renderTasks();
    syncSettingsUi();
    if (lastResult) {
      renderTiles(lastResult);
      renderPercentileTable(lastResult);
      renderDataTable(lastResult);
      updateProbe();
      chart.redraw();
    }
  }

  /* ===== 初期化 =============================================== */
  function wireEvents() {
    $("#add-row").addEventListener("click", () => {
      tasks.push(makeTask("", "1", "2", "4"));
      refresh();
      const inputs = $("#task-body").querySelectorAll('input[type="text"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    $("#load-sample").addEventListener("click", () => {
      tasks = sampleTasks();
      refresh();
    });
    $("#clear-all").addEventListener("click", () => {
      tasks = [];
      refresh();
    });

    for (const id of ["engine", "dist", "lambda", "iterations", "seed", "bins", "grid"]) {
      $("#" + id).addEventListener("change", () => {
        syncSettingsUi();
        compute();
      });
    }

    $("#probe-range").addEventListener("input", updateProbe);

    for (const button of document.querySelectorAll(".lang-toggle button")) {
      button.addEventListener("click", () => {
        lang = button.dataset.lang;
        try {
          localStorage.setItem(STORAGE_LANG, lang);
        } catch (_) {
          /* 保存できなくても言語の切り替え自体は効く */
        }
        rerenderEverything();
      });
    }
  }

  async function main() {
    applyI18n();
    setStatus(t("status.loading"));
    chart = createChart($("#chart"), $("#chart-tooltip"), { t, formatNumber, formatPercent });
    wireEvents();

    try {
      await boot();
    } catch (error) {
      showError(t("error.boot", { message: String(error && error.message ? error.message : error) }));
      return;
    }

    tasks = sampleTasks();
    renderTasks();
    syncSettingsUi();
    compute();
  }

  document.addEventListener("DOMContentLoaded", main);
})();
