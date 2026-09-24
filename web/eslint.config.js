import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    // 型情報を使う検査は TypeScript のソースだけに掛ける。
    // null の扱いや Promise の取りこぼしは型を見ないと分からないものが多い。
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser },
    },
    rules: {
      // WASM から読んだ数値をそのまま文字列に混ぜる箇所が多いので許可する。
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // 関数ひとつの分岐の数 (循環的複雑度) の上限。入れたときの最大が 25
      // (ui/tasks.ts と model/markdown.ts) なので、そこに置いて**上げない**。
      // 引っかかったら関数を割る。分布は ../scripts/complexity.sh で見られる。
      complexity: ["error", 25],
      // 文字列を HTML として解釈させる道を塞ぐ。文字は必ず textContent に
      // 入れる (.claude/rules/frontend.md)。取り決めだけだった頃、使っている
      // 箇所が 2 つ残っていた。
      // 文字列をコードとして走らせる道。CSP でも止まる (`script-src` に
      // 'unsafe-eval' を入れていない) が、書いた時点で気づけるようにする。
      "no-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-restricted-properties": [
        "error",
        ...["innerHTML", "outerHTML", "insertAdjacentHTML"].map((property) => ({
          property,
          message: "HTML の文字列を組み立てない。textContent に入れる (frontend.md)",
        })),
        ...["write", "writeln"].map((property) => ({
          object: "document",
          property,
          message: "HTML の文字列を組み立てない。textContent に入れる (frontend.md)",
        })),
      ],
    },
  },
  {
    // node:test の test() は Promise を返すが、待つのはテストランナーの仕事。
    files: ["src/**/*.test.ts"],
    // テストは攻撃の文字列 (`javascript:…`) をわざと持つ。
    rules: { "@typescript-eslint/no-floating-promises": "off", "no-script-url": "off" },
  },
  {
    // ビルドスクリプトと設定ファイルは Node で動く素の JavaScript。
    files: ["*.mjs", "*.js"],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: "module",
      ecmaVersion: 2023,
    },
  },
);
