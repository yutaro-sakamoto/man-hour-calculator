/**
 * ① 進捗カード。
 *
 * 「どこまで来たか」を工数で出す。summary バーは 1 行しか持てないので、
 * 内訳 (消化・残り・全体・件数) と、**期間をどれだけ使ったか**はここに置く。
 * この 2 本を並べると、遅れているかどうかがひと目で分かる。
 */

import type { AppState } from "../app.ts";
import { formatNumber, formatPercent } from "../format.ts";
import { lang, t } from "../i18n.ts";
import { progressOverall } from "../model/progress.ts";
import { card, h } from "./dom.ts";

function meter(value: number, extraClass = ""): HTMLElement {
  return h(
    "div",
    {
      class: `progress-meter ${extraClass}`.trim(),
      dataset: { progress: value.toFixed(4) },
      attrs: {
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": Math.round(value * 100),
      },
    },
    [h("span", { class: "meter-fill", style: { width: `${String(value * 100)}%` } })],
  );
}

function stat(label: string, value: string, key: string): HTMLElement {
  return h("div", { class: "progress-stat", dataset: { key, value } }, [
    h("span", { class: "field-label", text: label }),
    h("strong", { text: value }),
  ]);
}

export function renderProgressCard(state: AppState): HTMLElement | null {
  const result = state.result;
  if (result === null) return null;
  const l = lang();
  const progress = progressOverall(result);

  // 2 本目は「期間をどれだけ使ったか」。基準日か P80 完了日が無いときは
  // 比べる相手がいないので出さない。
  const schedule = state.schedule;
  const finish = schedule?.overallMarks.p80 ?? null;
  const today = schedule?.todayIndex ?? null;
  const elapsed =
    today === null || finish === null || finish <= 0
      ? null
      : Math.min(1, Math.max(0, today / finish));

  return card(
    t("progress.heading"),
    [
      h("div", { class: "progress-head" }, [
        meter(progress.ratio, "wide"),
        h("strong", {
          class: "progress-value",
          text: formatPercent(progress.ratio, l, 0),
        }),
      ]),
      h("div", { class: "progress-stats" }, [
        stat(t("progress.spent"), formatNumber(progress.spent, l, 1), "spent"),
        stat(t("progress.remaining"), formatNumber(progress.remaining, l, 1), "remaining"),
        stat(t("progress.total"), formatNumber(progress.total, l, 1), "total"),
        stat(
          t("progress.done"),
          t("progress.doneOf", { done: progress.doneCount, count: progress.leafCount }),
          "done",
        ),
      ]),
      elapsed === null
        ? null
        : h("div", { class: "progress-elapsed" }, [
            h("span", { class: "field-label", text: t("progress.elapsed") }),
            meter(elapsed, "thin"),
            h("span", { class: "muted", text: formatPercent(elapsed, l, 0) }),
          ]),
      h("p", { class: "hint", text: t("progress.note") }),
    ],
    "card-progress",
  );
}
