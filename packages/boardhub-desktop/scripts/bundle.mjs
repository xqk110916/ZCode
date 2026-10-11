/**
 * BoardHub 桌面打包编排：web 产物 + server 单文件 bundle → resources/，
 * 主进程 tsup → out/，最后 electron-builder。
 * 用法：node scripts/bundle.mjs [--mac|--win|--dir]
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "../..");

const args = process.argv.slice(2);
const target = args.includes("--win") ? "win" : args.includes("--dir") ? "dir" : "mac";

function run(command, cwd, runArgs = []) {
  const result = spawnSync(command, runArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${runArgs.join(" ")} exited with ${result.status}`);
  }
}

console.log("[boardhub-desktop] 1/4 构建 web 产物");
run("pnpm", repoRoot, ["--filter", "@zcode/boardhub-web", "build"]);

console.log("[boardhub-desktop] 2/4 构建 server 单文件 bundle");
run("pnpm", repoRoot, ["--filter", "@zcode/boardhub-server", "build:bundle"]);

console.log("[boardhub-desktop] 3/4 预置 resources/");
const resourcesDir = resolve(pkgRoot, "resources");
rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(resolve(resourcesDir, "server"), { recursive: true });
mkdirSync(resolve(resourcesDir, "web"), { recursive: true });
cpSync(
  resolve(repoRoot, "packages/boardhub-server/dist/bundle/entry.cjs"),
  resolve(resourcesDir, "server/entry.cjs"),
);
cpSync(resolve(repoRoot, "packages/boardhub-web/dist"), resolve(resourcesDir, "web"), {
  recursive: true,
});

console.log("[boardhub-desktop] 4/4 构建主进程并交给 electron-builder");
run("pnpm", pkgRoot, ["build:main"]);
if (target === "dir") {
  run("pnpm", pkgRoot, ["exec", "electron-builder", "--mac", "--dir"]);
} else {
  run("pnpm", pkgRoot, ["exec", "electron-builder", `--${target}`]);
}
console.log("[boardhub-desktop] 完成，产物在 packages/boardhub-desktop/dist/");
