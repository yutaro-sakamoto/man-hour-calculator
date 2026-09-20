/**
 * コメントの Markdown を読む。
 *
 * # なぜ自前なのか
 *
 * 配るのは 1 枚の HTML で、外部への通信もしない。Markdown のためだけに
 * 数十 KB のライブラリを抱えるより、コメント欄に要るぶんだけを書いたほうが
 * 軽いし、何が通るかを自分で把握できる。
 *
 * # 安全について
 *
 * コメントは**他人が書いた文字列**。HTML を組み立てて流し込むと、そこから
 * スクリプトを差し込まれる。そこで
 *
 * 1. ここでは**木を作るだけ**で、HTML 文字列はどこにも現れない
 * 2. 木を DOM にするのは {@link renderMarkdown} の短い関数で、文字は必ず
 *    `textContent` に入る (`innerHTML` は使わない)
 *
 * という形にしてある。どんな入力が来ても印にはならない。
 *
 * リンクだけは URL が属性に載るので、`http` `https` `mailto` 以外の綴り
 * (`javascript:` など) はリンクにせず、書かれたままの文字として出す。
 *
 * # 通すもの
 *
 * 見出し (`#`〜`######`)、箇条書き (`-` `*` `+`)、番号付き (`1.`)、
 * 引用 (`>`)、コードブロック (``` ```)、水平線 (`---`)、段落。
 * 行のなかでは強調 (`**` `*`)、コード (`` ` ``)、打ち消し (`~~`)、
 * リンク `[文字](URL)`、裸の URL。
 *
 * 表や脚注は入れていない。コメント欄で要るものではないため。
 */

/** 行のなかの一片。 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "strong" | "em" | "strike"; children: Inline[] };

/** 行のまとまり。 */
export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "rule" };

/** 属性に置いてよい綴り。これ以外はリンクにしない。 */
const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i;

/** 裸の URL。末尾の句読点は含めない。 */
const BARE_URL = /https?:\/\/[^\s<>"'）)]+[^\s<>"'）).,:;!?]/g;

export const isSafeHref = (href: string): boolean => SAFE_SCHEME.test(href.trim());

/* ===== 行のなか ===== */

/**
 * 入れ子は強調のなかの強調まで。深く追いかけても得るものが少なく、
 * 止まらなくなる危険のほうが大きい。
 */
function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let at = 0;

  const flush = (): void => {
    if (text !== "") {
      out.push({ kind: "text", text });
      text = "";
    }
  };

  while (at < source.length) {
    const rest = source.slice(at);

    // コードは中身を解釈しない。いちばん先に見る。
    const code = /^`([^`]+)`/.exec(rest);
    if (code?.[1] !== undefined) {
      flush();
      out.push({ kind: "code", text: code[1] });
      at += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link?.[1] !== undefined && link[2] !== undefined) {
      flush();
      if (isSafeHref(link[2])) {
        out.push({
          kind: "link",
          text: link[1] === "" ? link[2] : link[1],
          href: link[2],
        });
      } else {
        // 通せない綴りは、書かれたままの文字として出す。
        out.push({ kind: "text", text: link[0] });
      }
      at += link[0].length;
      continue;
    }

    if (depth < 2) {
      const emphasis = /^(\*\*\*|\*\*|\*|~~)([\s\S]+?)\1/.exec(rest);
      if (emphasis?.[1] !== undefined && emphasis[2] !== undefined) {
        flush();
        const children = parseInline(emphasis[2], depth + 1);
        const kind = emphasis[1] === "~~" ? "strike" : emphasis[1] === "*" ? "em" : "strong";
        out.push({ kind, children });
        at += emphasis[0].length;
        continue;
      }
    }

    text += source[at] ?? "";
    at += 1;
  }
  flush();
  return autoLink(out);
}

/** 文字のかたまりのなかの裸の URL をリンクにする。 */
function autoLink(tokens: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const token of tokens) {
    if (token.kind !== "text") {
      out.push(token);
      continue;
    }
    let last = 0;
    for (const match of token.text.matchAll(BARE_URL)) {
      if (match.index > last) {
        out.push({ kind: "text", text: token.text.slice(last, match.index) });
      }
      out.push({ kind: "link", text: match[0], href: match[0] });
      last = match.index + match[0].length;
    }
    if (last === 0) out.push(token);
    else if (last < token.text.length) {
      out.push({ kind: "text", text: token.text.slice(last) });
    }
  }
  return out;
}

/* ===== 行ごと ===== */

/** Markdown を木にする。DOM には触らないので、そのまま試せる。 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let at = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  while (at < lines.length) {
    const line = lines[at] ?? "";

    // コードブロック。閉じが無ければ残り全部を中身とする。
    if (line.startsWith("```")) {
      flushParagraph();
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !(lines[at] ?? "").startsWith("```")) {
        body.push(lines[at] ?? "");
        at += 1;
      }
      at += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      at += 1;
      continue;
    }

    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      at += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        children: parseInline(heading[2]),
      });
      at += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      flushParagraph();
      const body: string[] = [];
      while (at < lines.length && /^ {0,3}>/.test(lines[at] ?? "")) {
        body.push((lines[at] ?? "").replace(/^ {0,3}>\s?/, ""));
        at += 1;
      }
      blocks.push({ kind: "quote", blocks: parseMarkdown(body.join("\n")) });
      continue;
    }

    const bulletAt = /^ {0,3}([-*+])\s+(.*)$/;
    const numberAt = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
    if (bulletAt.test(line) || numberAt.test(line)) {
      flushParagraph();
      const ordered = !bulletAt.test(line);
      const shape = ordered ? numberAt : bulletAt;
      const items: Inline[][] = [];
      while (at < lines.length) {
        const match = shape.exec(lines[at] ?? "");
        if (match?.[2] === undefined) break;
        items.push(parseInline(match[2]));
        at += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    paragraph.push(line);
    at += 1;
  }
  flushParagraph();
  return blocks;
}

/* ===== DOM にする ===== */

function fillInline(nodes: readonly Inline[], into: Node): void {
  for (const node of nodes) {
    if (node.kind === "text") {
      into.appendChild(document.createTextNode(node.text));
    } else if (node.kind === "code") {
      const code = document.createElement("code");
      code.textContent = node.text;
      into.appendChild(code);
    } else if (node.kind === "link") {
      const anchor = document.createElement("a");
      anchor.href = node.href;
      // 別のところへ連れて行くので、元のページは渡さない。
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = node.text;
      into.appendChild(anchor);
    } else {
      const tag = node.kind === "em" ? "em" : node.kind === "strike" ? "s" : "strong";
      const element = document.createElement(tag);
      fillInline(node.children, element);
      into.appendChild(element);
    }
  }
}

function fillBlocks(blocks: readonly Block[], into: Node): void {
  for (const block of blocks) {
    switch (block.kind) {
      case "rule":
        into.appendChild(document.createElement("hr"));
        break;
      case "code": {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = block.text;
        pre.appendChild(code);
        into.appendChild(pre);
        break;
      }
      case "heading": {
        // コメントのなかの見出しなので、ページの見出しより下げる。
        const element = document.createElement(`h${String(Math.min(6, block.level + 2))}`);
        fillInline(block.children, element);
        into.appendChild(element);
        break;
      }
      case "list": {
        const list = document.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = document.createElement("li");
          fillInline(item, li);
          list.appendChild(li);
        }
        into.appendChild(list);
        break;
      }
      case "quote": {
        const quote = document.createElement("blockquote");
        fillBlocks(block.blocks, quote);
        into.appendChild(quote);
        break;
      }
      default: {
        const p = document.createElement("p");
        fillInline(block.children, p);
        into.appendChild(p);
      }
    }
  }
}

/**
 * Markdown を DOM に組み立てる。
 *
 * **`innerHTML` は使わない。** 文字は必ず `textContent` に入るので、
 * どんな入力が来てもスクリプトにはならない。
 */
export function renderMarkdown(source: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "markdown";
  fillBlocks(parseMarkdown(source), root);
  return root;
}
