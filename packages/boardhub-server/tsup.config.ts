import { defineConfig } from "tsup";

// external 列表与 packages/server/tsup.config.ts 保持同一策略：CJS / native / ESM-only
// 大包外置交给 Node 原生加载，避免内联进 ESM bundle 后的 Dynamic require 崩溃。
// 注意：dist 产物运行时需能解析这些包（当前以 tsx 源码运行为主，dist 供后续桌面壳集成）。
const SERVER_STYLE_EXTERNAL = [
  "ssh2",
  "node-pty",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "proxy-from-env",
  "follow-redirects",
  "node-forge",
  "yaml",
  "yazl",
  "yauzl",
  "pg",
  "@modelcontextprotocol/server",
];

export default defineConfig({
  entry: { entry: "src/entry.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  // workspace 包 exports 指向 .ts 源码，Node 无法直接加载，需 bundle 进来。
  noExternal: [
    "@zcode/shared",
    "@zcode/rpc",
    "@zcode/services",
    "@zcode/services/node",
    "@zcode/client",
    "@zcode/server",
  ],
  external: SERVER_STYLE_EXTERNAL,
  // __ZCODE_VERSION__ 等常量在 shared 源码里有 typeof fallback，未注入 define 也能运行。
  tsconfig: "tsconfig.build.json",
  clean: true,
  sourcemap: true,
});
