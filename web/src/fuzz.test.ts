/**
 * 利用者の手から入ってくるものを、でたらめに当てる。
 *
 * 画面が受け取る外の入力は 3 つある。コメントの本文 (Markdown)、読み込む
 * ファイル (JSON)、取り込む CSV。どれも「変なものが来たら例外で落ちる」と
 * 画面ごと止まるので、ここで**落ちないこと**と、**守るべき形**を確かめる。
 *
 * 乱数は種で決まるので、落ちたら同じ入力で必ず再現する。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isSafeHref, parseMarkdown } from "./model/markdown.ts";
import type { Block, Inline } from "./model/markdown.ts";
import {
  createTask,
  normalizeDocument,
  readBundle,
  readProjectFile,
  SCHEMA,
} from "./model/project.ts";
import { csvToTasks, projectToCsv } from "./model/storage.ts";
import { buildRows } from "./model/tree.ts";
import { fuzzIterations, seeded } from "./testing.ts";
import type { Task } from "./types.ts";

type Random = () => number;

const pick = <T>(random: Random, items: readonly T[]): T => {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("空の候補");
  return item;
};

/* ===== Markdown ===== */

/**
 * 文法の断片をつなげて作る。まったくのでたらめは段落 1 つになるだけで、
 * 奥の分岐 (入れ子の強調、リンク、画像、引用) に届かない。
 */
const MARKDOWN_PIECES = [
  "文字",
  "text ",
  " ",
  "\n",
  "\n\n",
  "\r\n",
  "*",
  "**",
  "***",
  "~~",
  "`",
  "```",
  "[",
  "]",
  "(",
  ")",
  "](",
  "![",
  "attachment:",
  "https://example.com/a?b=c",
  "javascript:alert(1)",
  " JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:x",
  "mailto:a@example.com",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "# ",
  "### ",
  "> ",
  "- ",
  "1. ",
  "---",
  "\u0000",
  "\u202e",
  "😀",
] as const;

function markdown(random: Random, pieces: number): string {
  let out = "";
  for (let i = 0; i < pieces; i++) out += pick(random, MARKDOWN_PIECES);
  return out;
}

/** 木を歩いて、リンクと画像を全部集める。 */
function inlines(blocks: readonly Block[]): Inline[] {
  const out: Inline[] = [];
  const walk = (items: readonly Inline[]): void => {
    for (const item of items) {
      out.push(item);
      if ("children" in item) walk(item.children);
    }
  };
  for (const block of blocks) {
    if (block.kind === "paragraph" || block.kind === "heading") walk(block.children);
    else if (block.kind === "list") block.items.forEach(walk);
    else if (block.kind === "quote") out.push(...inlines(block.blocks));
  }
  return out;
}

test("Markdown: どんな本文でも落ちず、危ない綴りをリンクにしない", () => {
  const random = seeded(0x3d);
  for (let i = 0; i < fuzzIterations(2000); i++) {
    const source = markdown(random, 1 + Math.floor(random() * 40));
    const blocks = parseMarkdown(source);
    for (const token of inlines(blocks)) {
      if (token.kind === "link") {
        // `javascript:` などを href に置くと、押しただけでスクリプトが走る。
        assert.ok(
          isSafeHref(token.href),
          `危ない href: ${token.href}\n本文: ${JSON.stringify(source)}`,
        );
      }
      if (token.kind === "image") {
        // 画像の id は添付の表を引くためだけに使う (URL にはしない)。
        // 表に無ければ出さないので、id そのものの中身は問わない。
        assert.ok(!/[\s)]/.test(token.id), `画像の id が切れていない: ${token.id}`);
      }
    }
  }
});

/**
 * 正規表現の組み合わせは、特定の形で**指数的に遅くなる**ことがある。
 * コメント 1 つで画面が固まるので、長い本文でも一定の時間で終わること。
 */
test("Markdown: 長い本文でも固まらない", () => {
  const random = seeded(0x10ad);
  const nasty = [
    "*".repeat(5000),
    "**a".repeat(3000),
    "[".repeat(5000) + "](",
    "![a](attachment:" + "x".repeat(5000),
    "~~" + "a~".repeat(3000),
    "> ".repeat(2000) + "a",
    "`".repeat(5000),
  ];
  for (let i = 0; i < 20; i++) nasty.push(markdown(random, 3000));
  for (const source of nasty) {
    const started = performance.now();
    parseMarkdown(source);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `${String(Math.round(elapsed))}ms かかった: ${source.slice(0, 40)}…`);
  }
});

/* ===== 読み込むファイル ===== */

/** JSON として読みうる、でたらめな値。 */
function value(random: Random, depth = 0): unknown {
  const roll = random();
  if (depth > 3 || roll < 0.35) {
    return pick(random, [
      null,
      true,
      false,
      0,
      -1,
      1.5,
      1e308,
      -1e308,
      "",
      "文字",
      "2026-09-20",
      "2026-02-30",
      "09:00",
      "25:99",
      "__proto__",
      "constructor",
      SCHEMA,
      "man-hour-calculator-bundle",
      "p1",
      "t1",
      "high",
    ]);
  }
  if (roll < 0.6) {
    return Array.from({ length: Math.floor(random() * 4) }, () => value(random, depth + 1));
  }
  const keys = [
    "schema",
    "name",
    "document",
    "projects",
    "tasks",
    "calendar",
    "settings",
    "members",
    "events",
    "id",
    "parentId",
    "min",
    "likely",
    "max",
    "progress",
    "startDate",
    "endDate",
    "assigneeId",
    "iterations",
    "bins",
    "gridPoints",
    "seed",
    "__proto__",
  ];
  const record: Record<string, unknown> = {};
  for (let i = 0; i < 1 + Math.floor(random() * 6); i++) {
    // `__proto__` は代入ではなく定義で入れる (JSON.parse と同じ振る舞い)。
    Object.defineProperty(record, pick(random, keys), {
      value: value(random, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return record;
}

/**
 * 並びが深さ優先 (部分木が連続する) になっているか。一覧・集計・CSV の前提。
 * 祖先の列を持ちながら頭からなめ、親が「直前の祖先の列」に無ければ崩れている。
 */
function isPreorder(tasks: readonly Task[]): boolean {
  const ancestors: string[] = [];
  for (const task of tasks) {
    if (task.parentId === null) {
      ancestors.length = 0;
    } else {
      const at = ancestors.lastIndexOf(task.parentId);
      if (at < 0) return false;
      ancestors.length = at + 1;
    }
    ancestors.push(task.id);
  }
  return true;
}

/** 親子の絡まった (順不同・循環・id の重複) タスクの列。 */
function tangledTasks(random: Random): unknown[] {
  const ids = ["a", "b", "c", "d", "e"];
  return Array.from({ length: Math.floor(random() * 8) }, () => ({
    id: pick(random, ids),
    name: pick(random, ["x", ""]),
    parentId: random() < 0.3 ? null : pick(random, [...ids, "ghost"]),
    min: "1",
    likely: "2",
    max: "3",
  }));
}

function checkDocument(raw: unknown): void {
  const context = JSON.stringify(raw);
  const document = normalizeDocument(raw);

  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const given = Array.isArray(record.tasks) ? record.tasks.length : 0;
  assert.equal(document.tasks.length, given, `タスクが増えた・減った: ${context}`);
  assert.ok(isPreorder(document.tasks), `深さ優先の並びでない: ${context}`);
  for (const task of document.tasks) {
    assert.ok(task.id !== "", `空の id: ${context}`);
    assert.ok(task.progress >= 0 && task.progress <= 100, `進捗が範囲外: ${context}`);
  }
  const { settings } = document;
  assert.ok(settings.bins >= 4 && settings.bins <= 512, `bins: ${context}`);
  assert.ok(settings.iterations >= 1 && settings.iterations <= 2_000_000, `iterations: ${context}`);

  // もう一度整えても変わらない (整えたものは、すでに整っている)。
  assert.deepEqual(normalizeDocument(document), document, `冪等でない: ${context}`);

  // 木に組んでも止まり、どのタスクも 1 度だけ現れる。
  assert.equal(buildRows(document.tasks).length, document.tasks.length, `行の数: ${context}`);

  readProjectFile(raw);
  readBundle(raw);
}

test("読み込み: どんな JSON でも落ちず、整った内容を返す", () => {
  const random = seeded(0xf11e);
  for (let i = 0; i < fuzzIterations(2000); i++) {
    checkDocument(value(random));
    checkDocument({ tasks: tangledTasks(random) });
  }
});

/* ===== CSV ===== */

const CELL_PIECES = ["名前", "a", ",", '"', '""', "\n", "\r\n", " ", "=1+1", "\t", "😀"] as const;

test("CSV: でたらめな文字列でも落ちない", () => {
  const random = seeded(0xc5f);
  for (let i = 0; i < fuzzIterations(2000); i++) {
    let text = "";
    for (let j = 0; j < Math.floor(random() * 60); j++) {
      text += pick(random, [...CELL_PIECES, "0", "1", "2", "-1", "level,name\n"]);
    }
    const tasks = csvToTasks(text);
    const ids = new Set(tasks.map((task) => task.id));
    for (const task of tasks) {
      assert.ok(task.parentId === null || ids.has(task.parentId), JSON.stringify(text));
    }
  }
});

/**
 * 書き出して読み戻すと、名前・見積もり・親子の形が戻る。
 * 名前にカンマ・引用符・改行が入っていても崩れないこと。
 *
 * 前後の空白と `\r` は比べない。取り込みはセルの前後の空白を落とし
 * (`csvToTasks` の `trim`)、CR は改行の一部として捨てる。どちらも意図した
 * 振る舞いで、ファジングが最初に「崩れた」と言ってきたのはここだった。
 */
test("CSV: 書き出して読み戻すと同じ形に戻る", () => {
  const random = seeded(0xc5f2);
  for (let i = 0; i < fuzzIterations(500); i++) {
    const count = 1 + Math.floor(random() * 8);
    const source: Task[] = [];
    for (let j = 0; j < count; j++) {
      let name = "";
      for (let k = 0; k < 1 + Math.floor(random() * 4); k++) name += pick(random, CELL_PIECES);
      const parent = j > 0 && random() < 0.5 ? source[Math.floor(random() * j)] : undefined;
      source.push({
        ...createTask(),
        name,
        parentId: parent?.id ?? null,
        min: String(1 + j),
        likely: String(2 + j),
        max: String(4 + j),
      });
    }
    // 画面が持つのと同じ、深さ優先の並びにしてから書き出す。
    const rows = buildRows(normalizeDocument({ tasks: source }).tasks);
    const back = buildRows(csvToTasks(projectToCsv(rows)));
    const shape = (list: typeof rows) =>
      list.map((row) => ({
        name: row.task.name.replace(/\r/g, "").trim(),
        depth: row.depth,
        estimate: row.hasChildren ? null : [row.task.min, row.task.likely, row.task.max],
      }));
    assert.deepEqual(
      shape(back),
      shape(rows),
      JSON.stringify(source.map((t) => [t.name, source.findIndex((p) => p.id === t.parentId)])),
    );
  }
});
