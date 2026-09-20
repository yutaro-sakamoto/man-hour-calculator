/**
 * タスクの親子関係の解決。
 *
 * タスクは配列に **深さ優先の並び** で保持する。つまり、あるタスクの
 * 直後にはその子孫が連続して並ぶ。この不変条件を保っておくと、
 *
 * - 部分木は配列の連続した区間として切り出せる
 * - 一覧順＝着手順なので、親タスクが終わるのは「配下の最後の葉」が終わるとき
 *
 * の 2 つが成り立ち、並べ替えも完了時期の判定も添字の操作だけで済む。
 *
 * 見積もりを持つのは**葉だけ**で、親は配下の合計を表示する (WBS の考え方)。
 */

import type { Task } from "../types.ts";

export interface Rollup {
  min: number;
  likely: number;
  max: number;
}

export interface TreeRow {
  task: Task;
  /** 配列上の位置。 */
  index: number;
  depth: number;
  hasChildren: boolean;
  /** 祖先もすべて有効で、計算に含まれるか。 */
  active: boolean;
  /** 見積もりの値として妥当か (葉のみ判定)。 */
  valid: boolean;
  /** 計算に渡した葉の並びでの位置。葉でなければ `null`。 */
  leafIndex: number | null;
  /** 配下の葉のうち最後のものの `leafIndex`。完了時期はこれで決まる。 */
  lastLeafIndex: number | null;
  /** 葉なら自身の見積もり、親なら配下の合計。 */
  rollup: Rollup;
}

/** 3 点見積もりとして読める値か。 */
export function parseEstimate(task: Task): Rollup | null {
  const min = Number(task.min);
  const likely = Number(task.likely);
  const max = Number(task.max);
  const filled = task.min.trim() !== "" && task.likely.trim() !== "" && task.max.trim() !== "";
  const ok =
    filled &&
    Number.isFinite(min) &&
    Number.isFinite(likely) &&
    Number.isFinite(max) &&
    min >= 0 &&
    min <= likely &&
    likely <= max;
  return ok ? { min, likely, max } : null;
}

/** id から添字を引く表。 */
function indexById(tasks: readonly Task[]): Map<string, number> {
  const map = new Map<string, number>();
  tasks.forEach((task, index) => map.set(task.id, index));
  return map;
}

/** 親をたどって深さを求める。循環していたら 0 に倒す。 */
function depthOf(task: Task, tasks: readonly Task[], byId: Map<string, number>): number {
  let depth = 0;
  let current = task;
  const seen = new Set<string>([task.id]);
  while (current.parentId !== null) {
    const parentIndex = byId.get(current.parentId);
    if (parentIndex === undefined) break;
    const parent = tasks[parentIndex];
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
    depth += 1;
    if (depth > 50) break;
  }
  return depth;
}

/**
 * 一覧を描くのに必要な情報をまとめて求める。
 *
 * 葉の並び (`leafIndex`) が、そのまま計算に渡すタスクの順番になる。
 */
export function buildRows(tasks: readonly Task[]): TreeRow[] {
  const byId = indexById(tasks);
  const childCount = new Map<string, number>();
  for (const task of tasks) {
    if (task.parentId !== null && byId.has(task.parentId)) {
      childCount.set(task.parentId, (childCount.get(task.parentId) ?? 0) + 1);
    }
  }

  // 祖先がひとつでも無効なら、その配下は計算に含めない。
  const activeById = new Map<string, boolean>();
  const isActive = (task: Task): boolean => {
    const cached = activeById.get(task.id);
    if (cached !== undefined) return cached;
    // 親子が循環していても止まるよう、たどり始める前に暫定値を入れておく。
    activeById.set(task.id, task.enabled);
    let active = task.enabled;
    if (active && task.parentId !== null) {
      const parentIndex = byId.get(task.parentId);
      const parent = parentIndex === undefined ? undefined : tasks[parentIndex];
      active = parent ? isActive(parent) : true;
    }
    activeById.set(task.id, active);
    return active;
  };

  const rows: TreeRow[] = tasks.map((task, index) => ({
    task,
    index,
    depth: depthOf(task, tasks, byId),
    hasChildren: (childCount.get(task.id) ?? 0) > 0,
    active: isActive(task),
    valid: true,
    leafIndex: null,
    lastLeafIndex: null,
    rollup: { min: 0, likely: 0, max: 0 },
  }));

  // 葉に通し番号を振る (有効なものだけが計算に渡る)。
  let leafCounter = 0;
  for (const row of rows) {
    if (row.hasChildren) continue;
    const parsed = parseEstimate(row.task);
    row.valid = parsed !== null;
    row.rollup = parsed ?? { min: 0, likely: 0, max: 0 };
    if (row.active && parsed) {
      row.leafIndex = leafCounter++;
      row.lastLeafIndex = row.leafIndex;
    }
  }

  // 親の集計は後ろから前に一度なめれば済む (部分木が連続しているため)。
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row?.hasChildren) continue;
    const [start, end] = subtreeRange(tasks, i);
    let last: number | null = null;
    let valid = false;
    const rollup: Rollup = { min: 0, likely: 0, max: 0 };
    for (let j = start + 1; j < end; j++) {
      const child = rows[j];
      if (!child || child.hasChildren) continue;
      if (child.leafIndex !== null) {
        last = child.leafIndex;
        rollup.min += child.rollup.min;
        rollup.likely += child.rollup.likely;
        rollup.max += child.rollup.max;
        valid = true;
      }
    }
    row.lastLeafIndex = last;
    row.rollup = rollup;
    row.valid = valid || !row.active;
  }

  return rows;
}

/**
 * 添字 `index` のタスクとその子孫が占める区間 `[start, end)`。
 *
 * 深さ優先の並びを保っているので、自分より深い行が続く限りが部分木になる。
 */
export function subtreeRange(tasks: readonly Task[], index: number): [number, number] {
  const byId = indexById(tasks);
  const start = tasks[index];
  if (!start) return [index, index];
  const baseDepth = depthOf(start, tasks, byId);
  let end = index + 1;
  while (end < tasks.length) {
    const candidate = tasks[end];
    if (!candidate || depthOf(candidate, tasks, byId) <= baseDepth) break;
    end += 1;
  }
  return [index, end];
}

/** 計算に渡す葉だけを、並び順どおりに取り出す。 */
export function activeLeaves(rows: readonly TreeRow[]): TreeRow[] {
  return rows.filter((row) => row.leafIndex !== null);
}

/** 見積もりが読めない有効な葉。エラー表示に使う。 */
export function invalidRows(rows: readonly TreeRow[]): TreeRow[] {
  return rows.filter((row) => row.active && !row.hasChildren && !row.valid);
}

/** 部分木ごと移動する。`direction` は -1 で上、+1 で下。 */
export function moveSubtree(tasks: Task[], index: number, direction: -1 | 1): Task[] {
  const [start, end] = subtreeRange(tasks, index);
  const moving = tasks.slice(start, end);
  const rest = [...tasks.slice(0, start), ...tasks.slice(end)];
  const target = tasks[index];
  if (!target) return tasks;

  // 同じ親を持つ兄弟のうち、移動先になるものを探す。
  // `rest` は自分を抜いたあとの配列なので、自分がいた位置以降に現れる最初の
  // 兄弟が「ひとつ下の兄弟」になる。末尾にいた場合は誰も見つからないので、
  // 兄弟列の末尾にいたものとして扱う。
  const siblings = rest
    .map((task, i) => ({ task, i }))
    .filter(({ task }) => task.parentId === target.parentId);
  const found = siblings.findIndex(({ i }) => i >= start);
  const slot = found === -1 ? siblings.length : found;
  const neighbour = siblings[direction < 0 ? slot - 1 : slot];
  if (!neighbour) return tasks;

  const insertAt = direction < 0 ? neighbour.i : subtreeRange(rest, neighbour.i)[1];
  return [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
}

/** ひとつ上の兄弟の子にする。 */
export function indentTask(tasks: Task[], index: number): Task[] {
  const target = tasks[index];
  if (!target) return tasks;
  let previousSibling: Task | undefined;
  for (let i = index - 1; i >= 0; i--) {
    const candidate = tasks[i];
    if (candidate?.parentId === target.parentId) {
      previousSibling = candidate;
      break;
    }
  }
  if (!previousSibling) return tasks;
  const next = [...tasks];
  next[index] = { ...target, parentId: previousSibling.id };
  return next;
}

/** 親と同じ階層に上げ、親の部分木の直後に置く。 */
export function outdentTask(tasks: Task[], index: number): Task[] {
  const target = tasks[index];
  if (target?.parentId == null) return tasks;
  const byId = indexById(tasks);
  const parentIndex = byId.get(target.parentId);
  if (parentIndex === undefined) return tasks;
  const parent = tasks[parentIndex];
  if (!parent) return tasks;

  const [start, end] = subtreeRange(tasks, index);
  const moving = tasks
    .slice(start, end)
    .map((task, offset) => (offset === 0 ? { ...task, parentId: parent.parentId } : task));
  const rest = [...tasks.slice(0, start), ...tasks.slice(end)];
  const newParentIndex = rest.findIndex((task) => task.id === parent.id);
  const insertAt = newParentIndex < 0 ? rest.length : subtreeRange(rest, newParentIndex)[1];
  return [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
}

/** 部分木ごと削除する。 */
export function removeSubtree(tasks: Task[], index: number): Task[] {
  const [start, end] = subtreeRange(tasks, index);
  return [...tasks.slice(0, start), ...tasks.slice(end)];
}

/** 部分木の直後に新しいタスクを差し込む。 */
export function insertAfterSubtree(tasks: Task[], index: number, task: Task): Task[] {
  const [, end] = subtreeRange(tasks, index);
  return [...tasks.slice(0, end), task, ...tasks.slice(end)];
}

/** 使われているグループ名を重複なく集める。 */
export function collectGroups(tasks: readonly Task[]): string[] {
  const groups = new Set<string>();
  for (const task of tasks) {
    const name = task.group.trim();
    if (name !== "") groups.add(name);
  }
  return [...groups].sort((a, b) => a.localeCompare(b));
}
