import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeBaseUrl } from "./connection.ts";

test("接続先の URL を整える", () => {
  assert.equal(normalizeBaseUrl("http://mhc.internal:8080"), "http://mhc.internal:8080");
  assert.equal(normalizeBaseUrl("  https://mhc.example.com/  "), "https://mhc.example.com");
  assert.equal(normalizeBaseUrl("https://mhc.example.com/api/"), "https://mhc.example.com/api");
  // 綴りを省いたら https を補う (社内でも平文より既定を安全側に寄せる)。
  assert.equal(normalizeBaseUrl("mhc.internal"), "https://mhc.internal");
});

test("http と https 以外は通さない", () => {
  // そのまま fetch に渡すと何が起きるか分からない綴りを、入口で止める。
  for (const bad of ["", "   ", "javascript:alert(1)", "file:///etc/passwd", "ftp://host/x"]) {
    assert.equal(normalizeBaseUrl(bad), null, bad);
  }
});
