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
import type { Task } from "../types.ts";
import { createTask, readProjectFile, toFile, type LoadedFile } from "./project.ts";
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

export function downloadProject(name: string, document: ProjectDocument): void {
  downloadText(
    `${safeFileName(name)}.mhc.json`,
    JSON.stringify(toFile(name, document), null, 2),
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
] as const;

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function projectToCsv(rows: readonly TreeRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) {
    const t = row.task;
    lines.push(
      [
        String(row.depth),
        t.name,
        t.group,
        t.priority,
        t.enabled ? "1" : "0",
        row.hasChildren ? "" : t.min,
        row.hasChildren ? "" : t.likely,
        row.hasChildren ? "" : t.max,
        t.startDate ?? "",
        String(t.progress),
        t.endDate ?? "",
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

/** CSV からタスク一覧を復元する。level 列から親子関係を組み直す。 */
export function csvToTasks(text: string): Task[] {
  const rows = parseCsv(text);
  const first = rows[0];
  if (!first) return [];

  // ヘッダ行があればそれに従い、無ければ既定の並びとみなす。
  const header = first.map((cell) => cell.trim());
  const hasHeader = header.includes("name") || header.includes("likely");
  const columns = hasHeader ? header : [...CSV_HEADER];
  const body = hasHeader ? rows.slice(1) : rows;
  const at = (cells: string[], key: string): string => {
    const index = columns.indexOf(key);
    return index < 0 ? "" : (cells[index] ?? "").trim();
  };

  const tasks: Task[] = [];
  // 深さごとの「直近の親候補」。
  const parents: (string | null)[] = [];

  for (const cells of body) {
    const depth = Math.max(0, Math.round(Number(at(cells, "level")) || 0));
    const parentId = depth === 0 ? null : (parents[depth - 1] ?? null);
    const priority = at(cells, "priority");
    const enabled = at(cells, "enabled");
    const task = createTask({
      name: at(cells, "name"),
      parentId,
      group: at(cells, "group"),
      priority: priority === "high" || priority === "low" ? priority : "normal",
      enabled: enabled !== "0" && enabled.toLowerCase() !== "false",
      min: at(cells, "min") || "0",
      likely: at(cells, "likely") || "0",
      max: at(cells, "max") || "0",
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(at(cells, "startDate")) ? at(cells, "startDate") : null,
      progress: Math.min(100, Math.max(0, Number(at(cells, "progress")) || 0)),
      endDate: /^\d{4}-\d{2}-\d{2}$/.test(at(cells, "endDate")) ? at(cells, "endDate") : null,
    });
    tasks.push(task);
    parents[depth] = task.id;
    parents.length = depth + 1;
  }
  return tasks;
}

/** Excel が UTF-8 と判別できるようにする byte order mark。 */
const BOM = String.fromCharCode(0xfeff);

export function downloadCsv(name: string, csv: string): void {
  downloadText(`${safeFileName(name)}.csv`, `${BOM}${csv}`, "text/csv");
}
