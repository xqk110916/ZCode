import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// BoardHub 独立应用前端：复用 @zcode/ui 组件源码（alias @ → ../ui/src，与 packages/web 同一策略），
// dev 代理到 boardhub-server（默认 3210，见 packages/boardhub-server/src/entry.ts）。
const BOARDHUB_SERVER_PORT = process.env.BOARDHUB_SERVER_PORT?.trim() || "3210";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "../ui/src"),
      "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
    },
  },
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      // 显式 127.0.0.1：server 默认只绑回环 IPv4，localhost 在部分系统优先解析 ::1 会连不上。
      "/ws": { target: `ws://127.0.0.1:${BOARDHUB_SERVER_PORT}`, ws: true },
      "/api": { target: `http://127.0.0.1:${BOARDHUB_SERVER_PORT}` },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
});
