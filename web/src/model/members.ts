/**
 * 人員の解決。
 *
 * タスクには担当者を付けられるが、付け忘れることもある。計算のほうは
 * 「すべてのタスクに担当者がいる」前提で組んであるので、ここで
 * **未割当ぶんの仮の人員**を 1 人足して辻褄を合わせる。
 * 黙って誰かに押し付けると見積もりを誤読させるので、仮の人員は
 * 画面でもそれと分かる名前で出す。
 */

import { t } from "../i18n.ts";
import type { CalendarSettings, Member, Task } from "../types.ts";
import { createMember } from "./project.ts";

export interface ResolvedMembers {
  /** 実在する人員に、必要なら未割当ぶんを足したもの。 */
  all: Member[];
  /** id から添字を引く表。 */
  indexById: Map<string, number>;
  /** 未割当の仮人員の添字。無ければ `null`。 */
  unassignedIndex: number | null;
}

/** 未割当の仮人員に使う id。ファイルには保存されない。 */
export const UNASSIGNED_ID = "\u0000unassigned";

/**
 * 計算に渡す人員一覧を組み立てる。
 *
 * `tasks` に担当者のいないものがあれば、末尾に仮の人員を 1 人足す。
 * 人員が 1 人も登録されていない場合も、既定の稼働予定を持つ 1 人として扱う。
 */
export function resolveMembers(
  members: readonly Member[],
  tasks: readonly Task[],
): ResolvedMembers {
  const known = new Set(members.map((member) => member.id));
  const needsFallback =
    members.length === 0 ||
    tasks.some((task) => task.assigneeId === null || !known.has(task.assigneeId));

  const all = [...members];
  let unassignedIndex: number | null = null;
  if (needsFallback) {
    unassignedIndex = all.length;
    all.push(createMember(t("members.unassigned"), { id: UNASSIGNED_ID }));
  }

  const indexById = new Map(all.map((member, index) => [member.id, index]));
  return { all, indexById, unassignedIndex };
}

/** そのタスクを担当する人員の添字。 */
export function memberIndexOf(resolved: ResolvedMembers, task: Task): number {
  if (task.assigneeId !== null) {
    const index = resolved.indexById.get(task.assigneeId);
    if (index !== undefined) return index;
  }
  return resolved.unassignedIndex ?? 0;
}

/** 表示用の名前。空欄なら「人員 3」のような通し番号を当てる。 */
export function memberLabel(member: Member, index: number): string {
  const name = member.name.trim();
  return name === "" ? t("members.numbered", { index: index + 1 }) : name;
}

/** 予定に参加する人員の添字。参加者が空なら全員が対象。 */
export function participantsOf(resolved: ResolvedMembers, memberIds: readonly string[]): number[] {
  if (memberIds.length === 0) {
    return resolved.all.map((_, index) => index);
  }
  return memberIds
    .map((id) => resolved.indexById.get(id))
    .filter((index): index is number => index !== undefined);
}

/** 人員の稼働予定を、その人が 1 週間に働ける分数にまとめる。 */
export function weeklyMinutes(member: Member): number {
  let total = 0;
  for (const window of member.workdays) {
    const from = timeToMinutes(window.start);
    const to = timeToMinutes(window.end);
    if (to > from) total += Math.max(0, to - from - member.breakMinutes);
  }
  return total;
}

function timeToMinutes(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 稼働予定を持つ人が 1 人もいないか。 */
export function hasNoCapacity(calendar: CalendarSettings): boolean {
  return calendar.members.length > 0 && calendar.members.every((m) => weeklyMinutes(m) === 0);
}
