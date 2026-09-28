/**
 * 保存と読み込み。
 *
 * 正本はユーザーが手元に持つ **ファイル** (`.mhc.json`)。
 * localStorage には「閉じてしまったときに戻れる」ための控えを置くだけで、
 * ここが消えてもファイルがあれば復元できる。
 *
 * ファイルのやり取りに File System Access API は使わない。`file://` から
 * 開いたページでは使えないブラウザがあるため、どこでも確実に動く
 * ダウンロードとファイル選択で通している。
 */

import type { ProjectDocument } from "../api/types.ts";
import { parseEffort } from "../format.ts";
import type { Member, Task } from "../types.ts";
import {
  createTask,
  readBundle,
  readProjectFile,
  toBundle,
  toFile,
  type LoadedFile,
} from "./project.ts";
import type { TreeRow } from "./tree.ts";

/**
 * ワークスペース (アカウント・プロジェクト・権限) の保存は
 * `api/local.ts` が受け持つ。ここにあるのは**ファイルとのやり取り**だけ。
 */

/** ファイル名に使えない文字を落とす。 */
function safeFileName(name: string): string {
  const trimmed = name.trim().replace(/[\\/:*?"<>|]/g, "_");
  return trimmed === "" ? "project" : trimmed;
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // すぐ revoke するとダウンロードが始まらないブラウザがあるので少し待つ。
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export function downloadProject(
  name: string,
  document: ProjectDocument,
  dueDate: string | null = null,
): void {
  downloadText(
    `${safeFileName(name)}.mhc.json`,
    JSON.stringify(toFile(name, document, dueDate), null, 2),
    "application/json",
  );
}

/** まとめて書き出す。拡張子を分けて、開くときに取り違えにくくする。 */
export function downloadBundle(projects: readonly LoadedFile[]): void {
  downloadText(
    "projects.mhcall.json",
    JSON.stringify(toBundle(projects), null, 2),
    "application/json",
  );
}

export async function readFile(file: File): Promise<LoadedFile | null> {
  try {
    return readProjectFile(JSON.parse(await file.text()));
  } catch {
    return null;
  }
}

/**
 * 1 件ぶんでも、まとめたものでも読む。
 *
 * どちらかはファイルの `schema` で決める。読めたものは**足すだけ**で、
 * 手元にあるプロジェクトは消さない。
 */
export async function readAnyFile(file: File): Promise<LoadedFile[] | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return null;
  }
  const bundle = readBundle(raw);
  if (bundle !== null) return bundle;
  const single = readProjectFile(raw);
  return single === null ? null : [single];
}

/* ===== CSV ===================================================
   階層は「level 列」で表す (0 がトップ)。表計算ソフトで開いて
   編集しやすいよう、1 行 1 タスクの素直な形にしてある。        */

const CSV_HEADER = [
  "level",
  "name",
  "group",
  "priority",
  "enabled",
  "min",
  "likely",
  "max",
  "startDate",
  "progress",
  "endDate",
  // 後ろに足す。見出しの無い古い CSV は、先頭から 11 列の並びで読めるように。
  "assignee",
  "spent",
  // 前提はタスク名を `;` で区切って書く (id は表計算ソフトの上で意味を持たない)。
  "after",
] as const;

/**
 * 見出しの別名。Excel で作った表は、見出しが日本語のことが多い。
 *
 * 英語の見出しに寄せてから読む。知らない見出しの列は読み飛ばす。
 */
const HEADER_ALIASES: Record<string, (typeof CSV_HEADER)[number]> = {
  階層: "level",
  レベル: "level",
  名前: "name",
  タスク: "name",
  タスク名: "name",
  グループ: "group",
  優先度: "priority",
  使用: "enabled",
  最小: "min",
  最小値: "min",
  楽観: "min",
  最可能: "likely",
  最可能値: "likely",
  最頻: "likely",
  最頻値: "likely",
  見積もり: "likely",
  見積: "likely",
  最大: "max",
  最大値: "max",
  悲観: "max",
  着手日: "startDate",
  開始日: "startDate",
  進捗: "progress",
  "進捗%": "progress",
  進捗率: "progress",
  完了日: "endDate",
  終了日: "endDate",
  担当: "assignee",
  担当者: "assignee",
  実績: "spent",
  実績工数: "spent",
  前提: "after",
};

function canonicalHeader(cell: string): string {
  const trimmed = cell.normalize("NFKC").trim();
  const bare = trimmed.replace(/\s*[(（].*[)）]\s*$/, "");
  return HEADER_ALIASES[bare] ?? HEADER_ALIASES[trimmed] ?? bare;
}

/**
 * 表計算ソフトで式として読まれる書き出し。`=`・`+`・`-`・`@` と、その前に
 * 置かれて読み飛ばされるタブ・CR。
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * 利用者が書いた文字の欄 (名前・グループ) を、式にならない形にする。
 *
 * CSV を表計算ソフトで開くと、`=HYPERLINK("https://…?"&A1)` のようなセルは
 * **開いた瞬間に式として実行される** (CSV インジェクション)。先頭に `'` を
 * 足すと文字として扱われる (OWASP の勧める形)。読み戻すときは
 * [`unquoteFormula`] で外す。数値の欄には使わない — 負の数を潰してしまう。
 */
function quoteFormula(value: string): string {
  // もともと `'` で始まる名前にも足す。足さないと、`'+1` という名前が
  // 読み戻しで `+1` に化ける (印と見分けがつかない。ファジングで見つかった)。
  return FORMULA_START.test(value) || value.startsWith("'") ? `'${value}` : value;
}

/**
 * [`quoteFormula`] で足した `'` を外してから、前後の空白を落とす。
 *
 * **順番が大事。** 先に空白を落とすと、`'\t` (タブだけの名前を書き出したもの)
 * が `'` だけになり、外すべき印が名前として残る (ファジングで見つかった)。
 */
function unquoteFormula(value: string): string {
  const unquoted =
    value.startsWith("'") && (FORMULA_START.test(value.slice(1)) || value[1] === "'")
      ? value.slice(1)
      : value;
  return unquoted.trim();
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 表を CSV にする。`members` を渡すと担当者を名前で書く (読み戻すときも名前で照らす)。
 */
export function projectToCsv(rows: readonly TreeRow[], members: readonly Member[] = []): string {
  const lines = [CSV_HEADER.join(",")];
  const names = new Map(members.map((member) => [member.id, member.name]));
  const taskNames = new Map(rows.map((row) => [row.task.id, row.task.name]));
  for (const row of rows) {
    const t = row.task;
    lines.push(
      [
        String(row.depth),
        quoteFormula(t.name),
        quoteFormula(t.group),
        t.priority,
        t.enabled ? "1" : "0",
        row.hasChildren ? "" : t.min,
        row.hasChildren ? "" : t.likely,
        row.hasChildren ? "" : t.max,
        t.startDate ?? "",
        // 完了日があれば画面では完了 (100%)。CSV でも同じに見せる。
        String(t.endDate !== null && !row.hasChildren ? 100 : t.progress),
        t.endDate ?? "",
        quoteFormula(t.assigneeId === null ? "" : (names.get(t.assigneeId) ?? "")),
        row.hasChildren ? "" : quoteFormula(t.spent),
        quoteFormula(
          t.after
            .map((id) => taskNames.get(id) ?? "")
            .filter((name) => name !== "")
            .join("; "),
        ),
      ]
        .map(escapeCsv)
        .join(","),
    );
  }
  return lines.join("\n");
}

/** 引用符と改行を含む CSV を 1 行ずつセルに割る。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

/** CSV を読んだ結果。 */
export interface CsvImport {
  tasks: Task[];
  /** 担当者の列に書かれていたが、人員にいない名前 (出てきた順)。 */
  unknownAssignees: string[];
  /** 3 点のうち足りない値を補った行の数。 */
  filledEstimates: number;
  /** 見積もりが読めなかった行の数。 */
  unreadable: number;
  /**
   * 子を持つ行に書かれていた見積もりの数。親は配下の合計なので使わない。
   * 黙って捨てると、Excel で小計行に書いた値がどこへ行ったか分からない。
   */
  parentEstimates: number;
}

/** CSV からタスク一覧を復元する。level 列から親子関係を組み直す。 */
export function csvToTasks(text: string): Task[] {
  return readCsv(text).tasks;
}

/**
 * 見積もりの 3 つの欄を読む。
 *
 * Excel の見積もり表は 1 点 (最可能値) しか無いことがよくある。そこで
 * **足りない値は、ある値から補う**: 1 点だけなら 3 つとも同じ値、最小と
 * 最大だけなら最可能はその中間。全角数字や `4h` も読む (`parseEffort`)。
 */
function readEstimate(
  cells: { min: string; likely: string; max: string },
  hoursPerDay: number,
): { min: string; likely: string; max: string; filled: boolean; unreadable: boolean } {
  const parse = (text: string): number | null => parseEffort(text, hoursPerDay);
  const values = [parse(cells.min), parse(cells.likely), parse(cells.max)];
  if (values.some((value) => value !== null && Number.isNaN(value))) {
    // 読めない値は、そのまま残して利用者に直してもらう (0 で埋めると、
    // 入れていない 0 が入っているように見える)。
    return { ...cells, filled: false, unreadable: true };
  }
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0)
    return { min: "0", likely: "0", max: "0", filled: false, unreadable: false };
  const [min, likely, max] = values;
  const lo = min ?? Math.min(...known);
  const hi = max ?? Math.max(...known);
  const mid = likely ?? (lo + hi) / 2;
  const text = (value: number): string => String(Math.round(value * 1000) / 1000);
  return {
    min: text(lo),
    likely: text(mid),
    max: text(hi),
    filled: known.length < 3,
    unreadable: false,
  };
}

/**
 * CSV を読む。担当者は `members` の名前と照らす。
 *
 * 見出しは英語でも日本語でもよい (`HEADER_ALIASES`)。
 */
export function readCsv(
  text: string,
  options: { members?: readonly Member[]; hoursPerDay?: number } = {},
): CsvImport {
  const members = options.members ?? [];
  const hoursPerDay = options.hoursPerDay ?? 8;
  const result: CsvImport = {
    tasks: [],
    unknownAssignees: [],
    filledEstimates: 0,
    unreadable: 0,
    parentEstimates: 0,
  };
  const written = new Set<string>();
  const rows = parseCsv(text);
  const first = rows[0];
  if (!first) return result;

  // ヘッダ行があればそれに従い、無ければ既定の並びとみなす。
  const header = first.map(canonicalHeader);
  const hasHeader = header.includes("name") || header.includes("likely");
  const columns = hasHeader ? header : [...CSV_HEADER];
  const body = hasHeader ? rows.slice(1) : rows;
  const raw = (cells: string[], key: string): string => {
    const index = columns.indexOf(key);
    return index < 0 ? "" : (cells[index] ?? "");
  };
  const at = (cells: string[], key: string): string => raw(cells, key).trim();

  const tasks = result.tasks;
  // 深さごとの「直近の親候補」。
  const parents: (string | null)[] = [];
  const byName = new Map(members.map((member) => [member.name.normalize("NFKC").trim(), member]));
  const unknown = new Set<string>();

  for (const cells of body) {
    const depth = Math.max(0, Math.round(Number(at(cells, "level")) || 0));
    const parentId = depth === 0 ? null : (parents[depth - 1] ?? null);
    const priority = normalizePriority(at(cells, "priority"));
    const enabled = at(cells, "enabled");
    const estimate = readEstimate(
      { min: at(cells, "min"), likely: at(cells, "likely"), max: at(cells, "max") },
      hoursPerDay,
    );
    if ([at(cells, "min"), at(cells, "likely"), at(cells, "max")].some((v) => v !== "")) {
      written.add(String(tasks.length));
    }
    if (estimate.filled) result.filledEstimates += 1;
    if (estimate.unreadable) result.unreadable += 1;
    const assigneeName = unquoteFormula(raw(cells, "assignee")).normalize("NFKC").trim();
    const assignee = assigneeName === "" ? undefined : byName.get(assigneeName);
    if (assigneeName !== "" && assignee === undefined) unknown.add(assigneeName);
    const endDate = isoDateCell(at(cells, "endDate"));
    const task = createTask({
      name: unquoteFormula(raw(cells, "name")),
      parentId,
      group: unquoteFormula(raw(cells, "group")),
      priority,
      enabled: enabled !== "0" && enabled.toLowerCase() !== "false",
      min: estimate.min,
      likely: estimate.likely,
      max: estimate.max,
      startDate: isoDateCell(at(cells, "startDate")),
      progress: Math.min(
        100,
        Math.max(0, Number(at(cells, "progress").normalize("NFKC").replace("%", "")) || 0),
      ),
      endDate,
      assigneeId: assignee?.id ?? null,
      spent: unquoteFormula(raw(cells, "spent")),
    });
    tasks.push(task);
    parents[depth] = task.id;
    parents.length = depth + 1;
  }
  // 前提は名前で照らす。自分より上の行だけ (下を待つ前提は効かないため)。
  const afterCells = body.map((cells) => unquoteFormula(raw(cells, "after")));
  tasks.forEach((task, index) => {
    const wanted = (afterCells[index] ?? "")
      .split(";")
      .map((name) => name.normalize("NFKC").trim())
      .filter((name) => name !== "");
    task.after = wanted
      .map(
        (name) =>
          tasks.slice(0, index).find((other) => other.name.normalize("NFKC").trim() === name)?.id,
      )
      .filter((id): id is string => id !== undefined);
  });
  result.unknownAssignees = [...unknown];
  const parentIds = new Set(tasks.map((task) => task.parentId).filter((id) => id !== null));
  result.parentEstimates = tasks.filter(
    (task, index) => parentIds.has(task.id) && written.has(String(index)),
  ).length;
  return result;
}

/** `high` / `高` のどちらでも読む。 */
function normalizePriority(value: string): Task["priority"] {
  const v = value.normalize("NFKC").trim().toLowerCase();
  if (v === "high" || v === "高") return "high";
  if (v === "low" || v === "低") return "low";
  return "normal";
}

/**
 * 日付の欄。`2026-10-05` のほか、Excel が書きがちな `2026/10/5` も読む。
 * 読めなければ `null`。
 */
function isoDateCell(value: string): string | null {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value.normalize("NFKC").trim());
  if (!match) return null;
  const iso = `${match[1] ?? ""}-${(match[2] ?? "").padStart(2, "0")}-${(match[3] ?? "").padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

/**
 * CSV ファイルを文字にする。**UTF-8 として読めなければ Shift_JIS で読む。**
 *
 * 日本語版の Excel が「CSV (コンマ区切り)」で保存すると Shift_JIS になる。
 * UTF-8 のつもりで読むと、全部の文字が化けたまま黙って取り込まれていた。
 * BOM は落とす。
 */
export async function readCsvText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("shift_jis").decode(bytes);
  }
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** Excel が UTF-8 と判別できるようにする byte order mark。 */
const BOM = String.fromCharCode(0xfeff);

export function downloadCsv(name: string, csv: string): void {
  downloadText(`${safeFileName(name)}.csv`, `${BOM}${csv}`, "text/csv");
}
