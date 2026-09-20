/**
 * プロジェクトの状態の見せ方。
 *
 * 判定そのものは `crates/api/src/health.rs` の 1 か所にあり、画面は
 * 返ってきた値を並べるだけ。ここにあるのは**見せ方**だけ。
 *
 * 色は状態専用の 4 色で、系列の色とは別に取ってある。そして
 * **色だけに意味を持たせない** — かならず記号と言葉を添える。
 * 色が見分けられない人にも、白黒で印刷しても、同じことが伝わるように。
 */

import type { ProjectHealth } from "../api/types.ts";
import { t } from "../i18n.ts";
import { h } from "./dom.ts";

export type HealthTone = "critical" | "serious" | "warning" | "good" | "neutral" | "muted";

interface Look {
  tone: HealthTone;
  /** 記号。色を使わずに種類が分かるよう、重さの順に形を変えてある。 */
  icon: string;
}

const LOOK: Record<ProjectHealth, Look> = {
  late: { tone: "critical", icon: "▲" },
  behindPace: { tone: "serious", icon: "▼" },
  atRisk: { tone: "warning", icon: "!" },
  unknown: { tone: "muted", icon: "?" },
  inProgress: { tone: "neutral", icon: "▸" },
  onTrack: { tone: "good", icon: "✓" },
  done: { tone: "good", icon: "✔" },
  noTasks: { tone: "muted", icon: "–" },
};

export function healthLook(health: ProjectHealth): Look {
  return LOOK[health];
}

export function healthLabel(health: ProjectHealth): string {
  return t(`health.${health}`);
}

/** 手当てが要るか。並び順と行の強調に使う。 */
export function needsAttention(health: ProjectHealth): boolean {
  return health === "late" || health === "behindPace" || health === "atRisk";
}

/** 重い順。小さいほど先に出す。 */
export function healthSeverity(health: ProjectHealth): number {
  const order: ProjectHealth[] = [
    "late",
    "behindPace",
    "atRisk",
    "unknown",
    "inProgress",
    "onTrack",
    "noTasks",
    "done",
  ];
  const at = order.indexOf(health);
  return at === -1 ? order.length : at;
}

/** 状態のバッジ。記号・言葉・色の 3 つで表す。 */
export function healthBadge(health: ProjectHealth): HTMLElement {
  const look = LOOK[health];
  return h("span", { class: `badge badge-${look.tone}`, dataset: { health } }, [
    // 記号は飾りではなく意味を持つが、読み上げでは言葉だけで足りる。
    h("span", { class: "badge-icon", text: look.icon, attrs: { "aria-hidden": "true" } }),
    h("span", { class: "badge-label", text: healthLabel(health) }),
  ]);
}
