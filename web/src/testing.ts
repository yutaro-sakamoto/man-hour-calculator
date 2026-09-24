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

/**
 * 種で決まる乱数 (mulberry32)。ファジング用。
 *
 * `Math.random` を使わないのは、落ちたときに**同じ入力を作り直せる**
 * ようにするため。種を変えれば別の標本になる。
 */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ファジングの回数。`MHC_FUZZ_ITERS` で増やせる (Rust 側と同じ名前)。 */
export function fuzzIterations(fallback: number): number {
  const raw = Number(process.env.MHC_FUZZ_ITERS);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}
