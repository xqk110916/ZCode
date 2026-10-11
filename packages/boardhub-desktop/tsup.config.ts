import { defineConfig } from "tsup";

// 包本体是 ESM（type: module，对齐 packages/desktop 与 verbatimModuleSyntax），
// 主进程产物落 .cjs 后缀：Electron main 以 CommonJS 加载，规避 ESM main 的
// 动态 import / utilityProcess 路径解析边界。
export default defineConfig({
  entry: { "main/index": "src/main/index.ts" },
  outDir: "out",
  format: "cjs",
  platform: "node",
  target: "node22",
  outExtension: () => ({ js: ".cjs" }),
  clean: true,
  sourcemap: true,
  // electron 由 electron-builder 负责，不进 bundle。
  external: ["electron"],
});
