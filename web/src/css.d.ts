/**
 * CSS をそのまま取り込む宣言。
 *
 * `import "./styles.css"` は esbuild に「この CSS も束ねてくれ」と伝える
 * ためだけのもので、値は何も返らない。TypeScript 7 は宣言の無い取り込みを
 * 通さなくなったので、ここで形を教えておく。
 */
declare module "*.css";
