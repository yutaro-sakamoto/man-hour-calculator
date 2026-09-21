/**
 * 見通しタブ。並べるだけの薄い組み立て役。
 *
 * ```text
 * ① 進捗          どこまで来たか
 * ② 完了日の見通し いつ終わるか      (帯グラフ + 行ごとの表)
 * ③ 総工数の分布   どれだけぶれるか  (ヒストグラム + 分位点)
 * ④ 人員ごと       誰が             (2 人以上のときだけ)
 * ▸ ⑤ 感度分析     なぜぶれるか      (畳んである)
 * ▸ ⑥ 計算の設定   どう計算したか    (畳んである)
 * ```
 *
 * summary バーが既に P80 工数と完了日を出しているので、ここではそれを
 * 繰り返さず、**タスクごと**という summary バーに出せないものを出す。
 *
 * 空のときの扱いは**カードごと**。計算できていなければ設定だけが残る
 * (壊れたまま設定を直せないと、直しようがなくなる)。スケジュールだけが
 * 欠けるときは ② だけが落ちる。タブ全体が真っ白になることはない。
 */

import type { AppActions, AppState, AppWidgets } from "../app.ts";
import { t } from "../i18n.ts";
import { card, h, type Child } from "./dom.ts";
import { renderProgressCard } from "./progress.ts";
import { renderDistributionCard, renderSensitivityCard, renderSettingsCard } from "./results.ts";
import { renderMemberCard, renderScheduleCard } from "./schedule.ts";

/** カードに印をつける。E2E とスタイルが「どの区画か」で引けるように。 */
function tagged(name: string, element: HTMLElement | null): HTMLElement | null {
  if (element === null) return null;
  element.dataset.card = name;
  return element;
}

export function renderForecastTab(
  state: AppState,
  actions: AppActions,
  widgets: AppWidgets,
): HTMLElement {
  const sections: Child[] = [
    tagged("progress", renderProgressCard(state)),
    tagged("schedule", renderScheduleCard(state, actions, widgets)),
    tagged("distribution", renderDistributionCard(state, widgets)),
    tagged("members", renderMemberCard(state)),
    tagged("sensitivity", renderSensitivityCard(state, actions)),
    tagged("settings", renderSettingsCard(state, actions)),
  ];

  // 1 枚も出せないことはない (設定は常に出る) が、数字が 1 つも無いときは
  // 理由を書いておく。空のカードが並ぶだけでは何が起きたのか分からない。
  if (state.result === null) {
    sections.unshift(
      tagged(
        "empty",
        card(t("results.heading"), [h("p", { class: "empty", text: t("chart.noData") })]),
      ),
    );
  } else if (state.schedule === null || state.schedule.days === 0) {
    sections.splice(
      1,
      0,
      tagged(
        "empty",
        card(t("sched.heading"), [h("p", { class: "empty", text: t("sched.noResult") })]),
      ),
    );
  }

  return h("div", { class: "forecast" }, sections);
}
