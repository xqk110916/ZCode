import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// vitest it 别名为 test：本文件需同时被 pre-push 的根 vitest（related 模式）收集——
// node:test 风格在 vitest 下会 "No test suite found"（仓库双测试体系的现实约束）。
import { it as test } from "vitest";
import {
  createPaperclipLocalServerController,
  type PaperclipLocalServerDeps,
} from "../src/paperclip/paperclipLocalServer.js";
import {
  applyInstalledPaperclipWindowsHidePatch,
  comparePaperclipVersion,
} from "../src/paperclip/paperclipLocalServerVersion.js";

const BASE_URL = "http://localhost:3100";
const INSTALLED_VERSION = "2026.1012.0";

interface Harness {
  deps: PaperclipLocalServerDeps;
  spawns: Array<{
    command: string;
    args: string[];
    options?: { detached?: boolean; cwd?: string; stdio?: Array<"ignore" | number>; env?: NodeJS.ProcessEnv };
  }>;
  execs: Array<{ command: string; args: string[] }>;
  setHealth: (ok: boolean) => void;
  setInstalledVersion: (version: string | null) => void;
  setLatestVersion: (version: string) => void;
  logFilePath: string;
  cleanup: () => void;
}

function createHarness(
  platform: NodeJS.Platform,
  overrides: Partial<PaperclipLocalServerDeps> = {},
): Harness {
  const spawns: Harness["spawns"] = [];
  const execs: Harness["execs"] = [];
  let healthy = false;
  let installedVersion: string | null = INSTALLED_VERSION;
  let latestVersion = INSTALLED_VERSION;
  // 日志注入临时目录：launchServerProcess 会真实 openSync 日志文件。
  const logDir = mkdtempSync(join(tmpdir(), "paperclip-local-server-"));
  const logFilePath = join(logDir, "server-run.log");
  const installDir = join(logDir, "server-install");
  const deps: PaperclipLocalServerDeps = {
    resolveBaseUrl: async () => BASE_URL,
    platform,
    fetchImpl: (async () => ({ ok: healthy })) as unknown as typeof fetch,
    spawnImpl: (command, args, options) => {
      spawns.push({ command, args, options });
      // 启动命令发出后，模拟 server 在下一次探测时变为健康。
      healthy = true;
    },
    execFileImpl: async (command, args) => {
      execs.push({ command, args });
      if (command === "powershell.exe" || command === "/bin/bash") {
        // 停止命令发出后，模拟进程退出。
        healthy = false;
      }
      if (args.includes("view")) {
        return { stdout: `${latestVersion}\n`, stderr: "" };
      }
      if (args.includes("install")) {
        // npm install 成功后安装目录出现对应版本。
        installedVersion = latestVersion;
      }
      return { stdout: "", stderr: "" };
    },
    delayImpl: async () => {},
    startPollIntervalMs: 1,
    startPollTimeoutMs: 30,
    stopPollIntervalMs: 1,
    stopPollTimeoutMs: 30,
    resolveToolchainImpl: () =>
      platform === "win32"
        ? { node: "C:\\nvm4w\\nodejs\\node.exe", npm: "C:\\nvm4w\\nodejs\\npm.cmd" }
        : { node: "/opt/homebrew/bin/node", npm: "/opt/homebrew/bin/npm" },
    resolveLogFilePathImpl: () => logFilePath,
    resolveInstallDirImpl: () => installDir,
    readInstalledVersionImpl: () => installedVersion,
    updateCheckTtlMs: 600_000,
    ...overrides,
  };
  return {
    deps,
    spawns,
    execs,
    setHealth: (ok) => (healthy = ok),
    setInstalledVersion: (version) => (installedVersion = version),
    setLatestVersion: (version) => (latestVersion = version),
    logFilePath,
    cleanup: () => rmSync(logDir, { recursive: true, force: true }),
  };
}

test("start 幂等：已健康时不发任何命令（携带已安装版本）", async () => {
  const h = createHarness("win32");
  h.setHealth(true);
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.start();
  assert.deepEqual(status, { state: "running", installedVersion: INSTALLED_VERSION });
  assert.equal(h.spawns.length, 0);
});

test("win32 start：独立终端窗口长期运行（服务自带控制台，子进程继承不再闪窗）", async () => {
  const h = createHarness("win32");
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.start();
  assert.equal(status.state, "running");
  assert.equal(h.spawns.length, 1);
  assert.equal(h.execs.length, 0);
  // cmd /c start：start 在新控制台窗口里跑 cmd /k node <安装目录入口> run。
  assert.equal(h.spawns[0]!.command, "cmd.exe");
  const args = h.spawns[0]!.args;
  assert.equal(args[0], "/c");
  assert.equal(args[1], "start");
  assert.equal(args[2], "Paperclip Server");
  assert.equal(args[3], "/D");
  assert.equal(args[4], h.deps.resolveInstallDirImpl!());
  assert.equal(args[5], "cmd");
  assert.equal(args[6], "/k");
  assert.equal(args[7], "C:\\nvm4w\\nodejs\\node.exe");
  assert.match(args[8]!, /server-install.*paperclipai.*dist.*index\.js$/);
  assert.equal(args[9], "run");
  assert.equal(h.spawns[0]!.options?.detached, true);
  // 幂等重入：已健康不再发射。
  assert.equal((await controller.start()).state, "running");
  assert.equal(h.spawns.length, 1);
});

test("darwin/linux start：node 绝对路径 detached spawn（PATH 前置 node 同目录）", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const h = createHarness(platform);
    const controller = createPaperclipLocalServerController(h.deps);
    const status = await controller.start();
    assert.equal(status.state, "running");
    assert.equal(h.spawns[0]!.command, "/opt/homebrew/bin/node");
    assert.equal(h.spawns[0]!.options?.detached, true);
    const stdio = h.spawns[0]!.options?.stdio;
    assert.equal(stdio?.[0], "ignore");
    assert.equal(typeof stdio?.[1], "number");
    // PATH 前置 node 同目录（分隔符随宿主平台，取首段判断）。
    const path = h.spawns[0]!.options?.env?.PATH ?? "";
    assert.equal(path.split(/[;:]/)[0], "/opt/homebrew/bin");
    h.cleanup();
  }
});

test("start 首次安装：本地未安装时先 npm install latest 再启动", async () => {
  const h = createHarness("win32");
  h.setLatestVersion("2026.1013.0");
  h.setInstalledVersion(null);
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.start();
  assert.equal(status.state, "running");
  assert.equal(status.installedVersion, "2026.1013.0");
  // 首装：cmd.exe /c npm.cmd install paperclipai@latest --prefix <安装目录>。
  assert.equal(h.execs[0]!.command, "cmd.exe");
  assert.equal(h.execs[0]!.args[0], "/c");
  assert.match(h.execs[0]!.args[1]!, /npm\.cmd$/);
  assert.equal(h.execs[0]!.args[2], "install");
  assert.equal(h.execs[0]!.args[3], "paperclipai@latest");
  assert.ok(h.execs[0]!.args.includes(h.deps.resolveInstallDirImpl!()));
  assert.equal(h.spawns.length, 1);
  h.cleanup();
});

test("start：找不到 node/npm 时返回可操作 error", async () => {
  const h = createHarness("darwin", { resolveToolchainImpl: () => null });
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.start();
  assert.equal(status.state, "error");
  assert.match(status.detail ?? "", /node\/npm/);
  assert.equal(h.spawns.length, 0);
});

test("start 超时：健康一直不通过时返回 error 并带日志提示", async () => {
  const h = createHarness("win32", {
    // 发射后仍保持不健康（覆盖默认的“发射即健康”模拟）。
    spawnImpl: (command, args) => {
      h.spawns.push({ command, args });
    },
    startPollTimeoutMs: 5,
    startPollIntervalMs: 1,
  });
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.start();
  assert.equal(status.state, "error");
  assert.match(status.detail ?? "", /超时/);
});

test("并发 start 单飞：同宿主并发只发一次启动命令", async () => {
  const h = createHarness("win32");
  const controller = createPaperclipLocalServerController(h.deps);
  const [first, second] = await Promise.all([controller.start(), controller.start()]);
  assert.equal(first.state, "running");
  assert.deepEqual(second, first);
  assert.equal(h.spawns.length, 1);
});

test("stop 幂等：未运行时直接 stopped", async () => {
  const h = createHarness("darwin");
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.stop();
  assert.equal(status.state, "stopped");
  assert.equal(status.installedVersion, INSTALLED_VERSION);
  assert.equal(h.execs.length, 0);
});

test("win32 stop：powershell 按命令行匹配终止（无 WSL）", async () => {
  const h = createHarness("win32");
  h.setHealth(true);
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.stop();
  assert.equal(status.state, "stopped");
  assert.equal(h.execs.length, 1);
  assert.equal(h.execs[0]!.command, "powershell.exe");
  const script = h.execs[0]!.args[2]!;
  assert.match(script, /Get-CimInstance Win32_Process/);
  // 过滤器同时命中 node.exe 与承载终端窗口的 cmd.exe（停止后不留空提示符窗口）。
  assert.match(script, /Name='node.exe' OR Name='cmd.exe'/);
  // 字符类技巧：过滤串自身不匹配 paperclipai 模式。
  assert.match(script, /paperclip\[a\]i/);
});

test("darwin stop：pkill 字符类防自匹配", async () => {
  const h = createHarness("darwin");
  h.setHealth(true);
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.stop();
  assert.equal(status.state, "stopped");
  assert.equal(h.execs[0]!.command, "/bin/bash");
  assert.match(h.execs[0]!.args[1]!, /pkill -f 'paperclip\[a\]i'/);
});

test("getStatus：按健康探测合成 running/stopped（带已安装版本）", async () => {
  const h = createHarness("darwin");
  const controller = createPaperclipLocalServerController(h.deps);
  assert.equal((await controller.getStatus()).state, "stopped");
  h.setHealth(true);
  assert.deepEqual(await controller.getStatus(), {
    state: "running",
    installedVersion: INSTALLED_VERSION,
  });
});

test("checkUpdate：本地落后于 registry 时 updateAvailable=true（calver 数值比较）", async () => {
  const h = createHarness("win32");
  h.setLatestVersion("2026.1013.0");
  const controller = createPaperclipLocalServerController(h.deps);
  const info = await controller.checkUpdate();
  assert.deepEqual(info, {
    installedVersion: "2026.1012.0",
    latestVersion: "2026.1013.0",
    updateAvailable: true,
  });
});

test("checkUpdate：本地即最新时 updateAvailable=false", async () => {
  const h = createHarness("win32");
  const controller = createPaperclipLocalServerController(h.deps);
  const info = await controller.checkUpdate();
  assert.equal(info.updateAvailable, false);
});

test("checkUpdate：registry 查询失败时 latestVersion=null 且不缓存", async () => {
  const h = createHarness("win32", {
    execFileImpl: async () => {
      throw new Error("network down");
    },
  });
  const controller = createPaperclipLocalServerController(h.deps);
  const info = await controller.checkUpdate();
  assert.equal(info.latestVersion, null);
  assert.equal(info.updateAvailable, false);
});

test("update：服务未运行时仅安装不启动", async () => {
  const h = createHarness("win32");
  h.setLatestVersion("2026.1013.0");
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.update();
  assert.equal(status.state, "stopped");
  assert.equal(status.installedVersion, "2026.1013.0");
  assert.equal(h.spawns.length, 0);
  assert.equal(h.execs.filter((e) => e.args.includes("install")).length, 1);
  // 更新后缓存失效：下一次检查立即反映新版本。
  const info = await controller.checkUpdate();
  assert.equal(info.updateAvailable, false);
});

test("update：服务运行中时安装后 stop + start 重启到新版本", async () => {
  const h = createHarness("win32");
  h.setHealth(true);
  h.setLatestVersion("2026.1013.0");
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.update();
  assert.equal(status.state, "running");
  assert.equal(status.installedVersion, "2026.1013.0");
  // 序列：npm install → powershell stop → 终端窗口启动（win32 形态）。
  assert.ok(h.execs[0]!.args.includes("install"));
  assert.equal(h.execs[1]!.command, "powershell.exe");
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0]!.command, "cmd.exe");
  assert.equal(h.spawns[0]!.args[1], "start");
});

test("comparePaperclipVersion：calver 分段数值比较", () => {
  assert.equal(comparePaperclipVersion("2026.1012.0", "2026.1012.0"), 0);
  assert.equal(comparePaperclipVersion("2026.1012.0", "2026.1012.1"), -1);
  // 字符串比较会把 "9" 排在 "1012" 后，数值比较必须正确识别 1012 > 9。
  assert.equal(comparePaperclipVersion("2026.1012.0", "2026.9.9"), 1);
  assert.equal(comparePaperclipVersion("2026.1012", "2026.1012.0"), 0);
  assert.equal(comparePaperclipVersion("2026.1012.0", "2027.1.0"), -1);
});

test("applyInstalledPaperclipWindowsHidePatch：为 pg_dump/psql spawn 补 windowsHide（幂等）", () => {
  if (process.platform !== "win32") return; // 补丁仅 Windows 生效
  const dir = mkdtempSync(join(tmpdir(), "pc-patch-"));
  const entry = join(dir, "node_modules", "paperclipai", "dist");
  mkdirSync(entry, { recursive: true });
  const file = join(entry, "index.js");
  const pgDump = [
    'stdio: ["ignore", "pipe", "pipe"],',
    "      env: {",
    "        ...process.env,",
    "        PGCONNECT_TIMEOUT: String(opts.connectTimeout)",
  ].join("\n");
  const psql = [
    'stdio: ["pipe", "ignore", "pipe"],',
    "      env: {",
    "        ...process.env,",
    "        PGCONNECT_TIMEOUT: String(connectTimeout)",
  ].join("\n");
  writeFileSync(file, `a${pgDump}b${psql}c`, "utf-8");
  try {
    assert.equal(applyInstalledPaperclipWindowsHidePatch(dir), true);
    const patched = readFileSync(file, "utf-8");
    assert.ok(patched.includes("windowsHide: true"));
    assert.equal(patched.split('windowsHide: true').length - 1, 2);
    // 幂等：已打补丁再跑不改文件。
    assert.equal(applyInstalledPaperclipWindowsHidePatch(dir), false);
    // 模式不存在（上游已改）：no-op 不抛错。
    writeFileSync(file, "totally different content", "utf-8");
    assert.equal(applyInstalledPaperclipWindowsHidePatch(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
