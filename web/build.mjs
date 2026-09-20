// src/main.ts を 1 本の IIFE にまとめ、CSS も 1 枚にして dist/ に出す。
// xtask はこの出力を index.html に流し込む。
import * as esbuild from "esbuild";
import { stat } from "node:fs/promises";

const result = await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // 単一 HTML に <script> として埋め込むので、モジュールではなく IIFE にする。
  format: "iife",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  outdir: "dist",
  entryNames: "bundle",
  logLevel: "info",
});

if (result.errors.length > 0) process.exit(1);

for (const file of ["dist/bundle.js", "dist/bundle.css"]) {
  const { size } = await stat(file);
  console.log(`  ${file}  ${(size / 1024).toFixed(1)} KiB`);
}
