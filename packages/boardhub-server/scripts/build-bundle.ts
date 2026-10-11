/**
 * BoardHub server 单文件 bundle：全内联 CJS（桌面壳 utilityProcess 直接 fork）。
 * 与 packages/server/build-remote.ts 同一模式；BoardHub 依赖链不含 native addon
 * （node-pty/ssh2/koffi），无需 native external 处理。
 */
import { readFileSync } from "node:fs";
import { build, type Plugin } from "esbuild";

const { version } = JSON.parse(readFileSync("../../package.json", "utf-8"));

/**
 * services 全模块树会拉进 ssh2 / cpu-features 的 optional native binding；
 * 两者加载处均为 try/catch 可选加速（失败回退纯 JS），把 .node 文件 external 后
 * 运行时 require 失败即走各自的 fallback，无需随包分发二进制。
 */
const nativeAddonPlugin: Plugin = {
  name: "native-addon-external",
  setup(builder) {
    builder.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const buildResult = await build({
  entryPoints: ["src/entry.ts"],
  bundle: true,
  outfile: "dist/bundle/entry.cjs",
  platform: "node",
  format: "cjs",
  target: "node22",
  plugins: [nativeAddonPlugin],
  // CJS 环境没有 import.meta.url（entry 用它解析 web 产物的默认路径），
  // banner 注入等价变量后 define 全局替换，源码无需感知最终打包格式。
  banner: {
    js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href; var __import_meta_dirname = __dirname;',
  },
  define: {
    "import.meta.url": "__import_meta_url",
    "import.meta.dirname": "__import_meta_dirname",
    __ZCODE_VERSION__: JSON.stringify(version),
  },
  metafile: true,
  sourcemap: false,
});

const bundledThirdParty = Object.keys(buildResult.metafile.inputs).filter((input) =>
  input.includes("node_modules"),
);
console.log(`Built dist/bundle/entry.cjs（内联第三方模块 ${bundledThirdParty.length} 个）`);
