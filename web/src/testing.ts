/**
 * 単体テスト用の小さなヘルパ。
 *
 * 配列の添字アクセスは `noUncheckedIndexedAccess` のせいで毎回 undefined を
 * 相手にすることになる。テストでは「無ければその場で落ちる」のが正しいので、
 * ここで一度だけ潰しておく。
 */

import assert from "node:assert/strict";

export function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  assert.ok(value !== undefined, `添字 ${String(index)} の要素が無い`);
  return value;
}
