#!/usr/bin/env node
/**
 * シャードごとの `outcomes.json` を突き合わせ、捕捉率を出す。
 *
 * 基準を下回ったら **Issue に詳細を書いて投稿**する。同じ題の open な Issue が
 * あれば新規に立てずにコメントを足す — 毎晩 1 本ずつ増えても読まれない。
 *
 * 捕捉率 = caught / (caught + missed)。unviable (組み立たない変異) と timeout は
 * 分母に入れない。どちらもテストの落ち度ではないため。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ISSUE_TITLE = "ミューテーションテストの捕捉率が基準を下回っています";
const LABEL = "mutation";
/** 一覧に並べる見逃しの上限。これ以上は件数だけ書く。 */
const MAX_LISTED = 50;

const root = process.argv[2] ?? "shards";
/**
 * `MUTANTS_DRY_RUN=1` なら Issue を立てずに本文を出すだけ。
 *
 * 出来上がりを手元で確かめるための道。**これが無いと確かめようが無く、
 * 試すたびに本物の Issue が立つ。**
 */
const dryRun = process.env.MUTANTS_DRY_RUN === "1";
const threshold = Number(process.env.THRESHOLD ?? "70");
const runUrl = process.env.RUN_URL ?? "";

/** `shards/mutants-1/outcomes.json` のような並びを全部読む。 */
function collect(dir) {
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === "outcomes.json") files.push(path);
    }
  };
  walk(dir);
  return files;
}

const shards = [];
const missed = [];
const totals = { caught: 0, missed: 0, timeout: 0, unviable: 0 };

for (const file of collect(root)) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const name = file.split("/").at(-2) ?? file;
  for (const key of Object.keys(totals)) totals[key] += data[key] ?? 0;

  for (const outcome of data.outcomes ?? []) {
    const mutant = outcome.scenario?.Mutant;
    if (mutant === undefined || outcome.summary !== "MissedMutant") continue;
    // `name` は「何を何に置き換えたか」がそのまま書いてある。先頭の
    // `file:line:col:` は列で持つので落とす。
    const name = String(mutant.name ?? "");
    missed.push({
      file: mutant.file,
      line: mutant.span?.start?.line ?? 0,
      what: name.replace(/^.*?:\d+:\d+:\s*/, ""),
    });
  }

  const started = Date.parse(data.start_time ?? "");
  const ended = Date.parse(data.end_time ?? "");
  shards.push({
    name,
    minutes:
      Number.isFinite(started) && Number.isFinite(ended)
        ? Math.round((ended - started) / 60000)
        : null,
    counted: (data.caught ?? 0) + (data.missed ?? 0),
  });
}

if (shards.length === 0) {
  console.error(
    `${root} の下に outcomes.json がありません。シャードが全部落ちた可能性があります。`,
  );
  process.exit(1);
}

const counted = totals.caught + totals.missed;
const rate = counted === 0 ? 0 : (totals.caught / counted) * 100;

console.log(`シャード: ${String(shards.length)}`);
console.log(`捕捉 ${String(totals.caught)} / 見逃し ${String(totals.missed)}`);
console.log(
  `打ち切り ${String(totals.timeout)} / 組み立たない ${String(totals.unviable)}`,
);
console.log(`捕捉率: ${rate.toFixed(1)}% (基準 ${String(threshold)}%)`);

if (rate >= threshold) {
  console.log("基準を満たしています。");
  process.exit(0);
}

/* ===== 下回ったので Issue に書く ===== */

missed.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const listed = missed.slice(0, MAX_LISTED);
const rest = missed.length - listed.length;

const body = [
  `捕捉率が **${rate.toFixed(1)}%** で、基準の ${String(threshold)}% を下回りました。`,
  "",
  "| | 件数 |",
  "|---|---:|",
  `| 捕捉 (caught) | ${String(totals.caught)} |`,
  `| **見逃し (missed)** | **${String(totals.missed)}** |`,
  `| 打ち切り (timeout) | ${String(totals.timeout)} |`,
  `| 組み立たない (unviable) | ${String(totals.unviable)} |`,
  "",
  "捕捉率は `caught / (caught + missed)`。unviable と timeout は分母に入れていません",
  "(どちらもテストの落ち度ではないため)。",
  "",
  `## 見逃した変異 (${String(listed.length)}${rest > 0 ? ` / ${String(missed.length)}` : ""} 件)`,
  "",
  "その行を通ってはいるが、**書き換えても落ちない** = 何も確かめていない箇所です。",
  "",
  "```",
  ...listed.map((item) => `${item.file}:${String(item.line)}: ${item.what}`),
  ...(rest > 0 ? [`… ほか ${String(rest)} 件`] : []),
  "```",
  "",
  "## シャードごと",
  "",
  "| シャード | 所要 (分) | 数えた変異 |",
  "|---|---:|---:|",
  ...shards.map(
    (shard) =>
      `| ${shard.name} | ${shard.minutes === null ? "—" : String(shard.minutes)} | ${String(shard.counted)} |`,
  ),
  "",
  runUrl === "" ? "" : `実行: ${runUrl}`,
].join("\n");

if (dryRun) {
  console.log("--- ここから Issue の本文 (MUTANTS_DRY_RUN) ---");
  console.log(body);
  process.exit(1);
}

function gh(args, input) {
  return execFileSync("gh", args, { input, encoding: "utf8" });
}

// 同じ題の open な Issue があれば、そこにコメントを足す。
const existing = JSON.parse(
  gh([
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    LABEL,
    "--json",
    "number,title",
    "--limit",
    "50",
  ]),
);
const found = existing.find((issue) => issue.title === ISSUE_TITLE);

if (found === undefined) {
  // ラベルは無ければ作る (初回だけ通る道)。
  try {
    gh([
      "label",
      "create",
      LABEL,
      "--description",
      "ミューテーションテストの結果",
      "--color",
      "B60205",
    ]);
  } catch {
    /* すでにあるなら、それでよい */
  }
  const url = gh(
    [
      "issue",
      "create",
      "--title",
      ISSUE_TITLE,
      "--label",
      LABEL,
      "--body-file",
      "-",
    ],
    body,
  );
  console.log(`Issue を立てました: ${url.trim()}`);
} else {
  gh(["issue", "comment", String(found.number), "--body-file", "-"], body);
  console.log(`既存の Issue #${String(found.number)} に書き足しました。`);
}

process.exit(1);
