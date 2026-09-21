#!/usr/bin/env node
/**
 * `cargo cyclonedx` が crate ごとに吐く SBOM を 1 つにまとめる。
 *
 * 受け取る側が読むのは「この配布物に何が入っているか」なので、
 * crate ごとに分かれていると見るものが増えるだけになる。
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const outPath = process.argv[2];
if (outPath === undefined) {
  console.error("使い方: merge-sbom.mjs <出力先>");
  process.exit(1);
}

/** `*.cdx.json` を再帰的に集める (自分の出力先は除く)。 */
function collect(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "target" || entry.startsWith("."))
      continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collect(path, found);
    else if (entry.endsWith(".cdx.json") && path !== outPath) found.push(path);
  }
  return found;
}

const files = collect(".");
if (files.length === 0) {
  console.error("cargo cyclonedx の出力が見つかりません");
  process.exit(1);
}

// `purl` (パッケージの正準な名前) で重ねる。同じ crate が複数の
// crate から参照されていても 1 行にまとまる。
const components = new Map();
for (const file of files) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  for (const component of doc.components ?? []) {
    const key = component.purl ?? `${component.name}@${component.version}`;
    if (!components.has(key)) components.set(key, component);
  }
  // 各文書の主体 (crate 自身) も部品として残す。
  const self = doc.metadata?.component;
  if (self !== undefined) {
    const key = self.purl ?? `${self.name}@${self.version}`;
    if (!components.has(key)) components.set(key, self);
  }
}

const sorted = [...components.values()].sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);

const merged = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: "man-hour-calculator",
      description: "工数見積もり (Rust workspace)",
    },
    tools: [{ name: "cargo-cyclonedx + merge-sbom.mjs" }],
  },
  components: sorted,
};

writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(
  `${String(sorted.length)} 件を ${outPath} にまとめました (${files.length} 文書から)`,
);
