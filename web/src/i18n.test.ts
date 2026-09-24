/**
 * 訳の抜けと食い違い。
 *
 * 鍵が揃っていることは型が見ている (`Dictionary`)。型で見えないのは中身で、
 * ここで見る。
 *
 * - 差し込み口 (`{days}` など) が両方の言語で同じ。片方に無いと、値が
 *   出ないか、`{days}` がそのまま画面に出る
 * - 強調 (`<b>`) の数が同じ (`boldMarkup()` で要素にする)
 * - 英語の表に日本語が残っていない (訳し忘れ)。言語の切り替えボタンの
 *   「日本語」のように、わざと残すものだけは名指しで許す
 * - 空の訳が無い
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { TABLES } from "./i18n.ts";

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
const bolds = (text: string): number => text.split("<b>").length - 1;

/** 英語の画面にも日本語で出してよいもの。 */
// 言語の切り替えボタンは、その言語自身の名前で書く (英語の画面でも「日本語」)。
const JAPANESE_ON_PURPOSE = new Set<string>(["lang.ja"]);

test("差し込み口と強調が、日本語と英語で揃っている", () => {
  const { ja, en } = TABLES;
  for (const key of Object.keys(ja) as (keyof typeof ja)[]) {
    assert.deepEqual(placeholders(en[key]), placeholders(ja[key]), `${key} の差し込み口`);
    assert.equal(bolds(en[key]), bolds(ja[key]), `${key} の強調`);
  }
});

test("英語の表に、訳し忘れの日本語が無い", () => {
  const japanese = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
  const leftovers = Object.entries(TABLES.en)
    .filter(([key, text]) => japanese.test(text) && !JAPANESE_ON_PURPOSE.has(key))
    .map(([key, text]) => `${key}: ${text}`);
  assert.deepEqual(leftovers, []);
});

test("空の訳が無い", () => {
  for (const [lang, table] of Object.entries(TABLES)) {
    for (const [key, text] of Object.entries(table)) {
      assert.ok(text.trim() !== "", `${lang}.${key} が空`);
    }
  }
});
