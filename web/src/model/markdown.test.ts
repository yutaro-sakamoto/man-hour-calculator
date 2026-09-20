import assert from "node:assert/strict";
import { test } from "node:test";

import { isSafeHref, parseMarkdown, type Block, type Inline } from "./markdown.ts";

/** その塊が持っている行のなかの一片。持たない種類なら空。 */
const inlineOf = (block: Block): readonly Inline[] => ("children" in block ? block.children : []);

/** 木を読みやすい文字列にする。中身の確認用。 */
function show(blocks: readonly Block[]): string {
  const inline = (nodes: readonly Inline[]): string =>
    nodes
      .map((node) => {
        switch (node.kind) {
          case "text":
            return node.text;
          case "code":
            return `\`${node.text}\``;
          case "link":
            return `[${node.text}](${node.href})`;
          default:
            return `${node.kind}(${inline(node.children)})`;
        }
      })
      .join("");

  return blocks
    .map((block) => {
      switch (block.kind) {
        case "rule":
          return "hr";
        case "code":
          return `code(${block.text})`;
        case "heading":
          return `h${String(block.level)}(${inline(block.children)})`;
        case "list":
          return `${block.ordered ? "ol" : "ul"}(${block.items.map(inline).join(" | ")})`;
        case "quote":
          return `quote(${show(block.blocks)})`;
        default:
          return `p(${inline(block.children)})`;
      }
    })
    .join("\n");
}

test("段落は空行で切れる", () => {
  assert.equal(
    show(parseMarkdown("ひとつめ\nつづき\n\nふたつめ")),
    "p(ひとつめ\nつづき)\np(ふたつめ)",
  );
});

test("見出しと水平線", () => {
  assert.equal(show(parseMarkdown("# 大きい\n### 小さい")), "h1(大きい)\nh3(小さい)");
  assert.equal(show(parseMarkdown("---")), "hr");
  assert.equal(show(parseMarkdown("#見出しではない")), "p(#見出しではない)", "空白が要る");
});

test("箇条書きと番号付き", () => {
  assert.equal(show(parseMarkdown("- あ\n- い")), "ul(あ | い)");
  assert.equal(show(parseMarkdown("1. あ\n2. い")), "ol(あ | い)");
  // 続きの行で種類が変わったら、別のまとまりになる。
  assert.equal(show(parseMarkdown("- あ\n1. い")), "ul(あ)\nol(い)");
});

test("引用は入れ子になる", () => {
  assert.equal(show(parseMarkdown("> ひとこと\n> - 箇条書き")), "quote(p(ひとこと)\nul(箇条書き))");
});

test("コードブロックの中身は解釈しない", () => {
  const md = "```ts\n**強調ではない**\n```";
  assert.equal(show(parseMarkdown(md)), "code(**強調ではない**)");
});

test("閉じ忘れたコードブロックは残り全部を中身にする", () => {
  assert.equal(show(parseMarkdown("```\nあ\nい")), "code(あ\nい)");
});

test("強調・コード・打ち消し", () => {
  assert.equal(show(parseMarkdown("**太字** と *斜体*")), "p(strong(太字) と em(斜体))");
  assert.equal(show(parseMarkdown("~~消し~~")), "p(strike(消し))");
  assert.equal(show(parseMarkdown("`a * b`")), "p(`a * b`)", "コードのなかは解釈しない");
});

test("リンクと裸の URL", () => {
  assert.equal(
    show(parseMarkdown("[説明](https://example.com/x)")),
    "p([説明](https://example.com/x))",
  );
  assert.equal(
    show(parseMarkdown("見て https://example.com/a 。")),
    "p(見て [https://example.com/a](https://example.com/a) 。)",
    "末尾の句読点は含めない",
  );
});

/* ===== 安全について ===== */

test("危ない綴りはリンクにせず、書かれたまま出す", () => {
  // 属性に載せると動いてしまうものは、リンクにせずただの文字として残す。
  for (const href of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc"]) {
    const blocks = parseMarkdown(`[押して](${href})`);
    assert.equal(blocks[0]?.kind, "paragraph", href);
    for (const node of blocks.flatMap(inlineOf)) {
      assert.notEqual(node.kind, "link", `リンクになってしまった: ${href}`);
    }
    // 書かれたままの文字としては残る (黙って消さない)。
    assert.ok(show(blocks).includes(href), href);
  }

  assert.equal(isSafeHref("javascript:alert(1)"), false);
  assert.equal(isSafeHref("HTTPS://example.com"), true, "綴りの大小は問わない");
  assert.equal(isSafeHref("mailto:a@example.com"), true);
  assert.equal(isSafeHref("  javascript:x"), false, "前の空白でごまかせない");
});

test("HTML は組み立てず、文字として持つ", () => {
  // 木のなかに残るのは文字だけ。印にはならない。
  const blocks = parseMarkdown("<script>alert(1)</script>\n<img src=x onerror=alert(1)>");
  for (const block of blocks) {
    assert.equal(block.kind, "paragraph");
    for (const node of inlineOf(block)) {
      assert.equal(node.kind, "text", "文字以外になっている");
    }
  }
  assert.ok(show(blocks).includes("<script>"), "文字としては残る");
});

test("入れ子の強調でも止まる", () => {
  // 深追いしないので、ある深さから先はただの文字になる。
  const shown = show(parseMarkdown("***" + "*".repeat(40) + "深い" + "*".repeat(40) + "***"));
  assert.ok(shown.length > 0);
});

test("長い入力でも素直に返る", () => {
  const md = Array.from({ length: 500 }, (_, i) => `- 項目 ${String(i)} **強調**`).join("\n");
  const blocks = parseMarkdown(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, "list");
});

test("空の入力は空の木", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\n  "), []);
});
