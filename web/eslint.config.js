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
    },
  },
  {
    // node:test の test() は Promise を返すが、待つのはテストランナーの仕事。
    files: ["src/**/*.test.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
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
