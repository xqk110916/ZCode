import assert from "node:assert/strict";
import test from "node:test";
import {
  createPaperclipLocalServerController,
  type PaperclipLocalServerDeps,
} from "../src/paperclip/paperclipLocalServer.js";

const BASE_URL = "http://localhost:3100";

interface Harness {
  deps: PaperclipLocalServerDeps;
  spawns: Array<{ command: string; args: string[] }>;
  execs: Array<{ command: string; args: string[] }>;
  setHealth: (ok: boolean) => void;
}

function createHarness(
  platform: NodeJS.Platform,
  overrides: Partial<PaperclipLocalServerDeps> = {},
): Harness {
  const spawns: Harness["spawns"] = [];
  const execs: Harness["execs"] = [];
  let healthy = false;
  const deps: PaperclipLocalServerDeps = {
    resolveBaseUrl: async () => BASE_URL,
    platform,
    fetchImpl: (async () => ({ ok: healthy })) as unknown as typeof fetch,
    spawnImpl: (command, args) => {
      spawns.push({ command, args });
      // 启动命令发出后，模拟 server 在下一次探测时变为健康。
      healthy = true;
    },
    execFileImpl: async (command, args) => {
      execs.push({ command, args });
      // 停止命令发出后，模拟进程退出。
      healthy = false;
      return { stdout: "", stderr: "" };
    },
    delayImpl: async () => {},
    startPollIntervalMs: 1,
    startPollTimeoutMs: 30,
    stopPollIntervalMs: 1,
    stopPollTimeoutMs: 30,
    resolveNpxImpl: () =>
      platform === "win32" ? "C:\\nvm4w\\nodejs\\npx.cmd" : "/opt/homebrew/bin/npx",
    ...overrides,
  };
  return { deps, spawns, execs, setHealth: (ok) => (healthy = ok) };
}

test("start 幂等：已健康时不发任何命令", async () => {
  const h = createHarness("win32");
  h.setHealth(true);
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.start();
  assert.deepEqual(status, { state: "running" });
  assert.equal(h.spawns.length, 0);
});

test("win32 start：cmd.exe /c npx.cmd detached 启动（无 WSL）", async () => {
  const h = createHarness("win32");
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.start();
  assert.equal(status.state, "running");
  assert.equal(h.spawns.length, 1);
  // .cmd 不能被 detached spawn 直接执行（EINVAL），必须经 cmd.exe /c 包裹。
  assert.equal(h.spawns[0]!.command, "cmd.exe");
  assert.deepEqual(h.spawns[0]!.args, [
    "/c",
    "C:\\nvm4w\\nodejs\\npx.cmd",
    "-y",
    "paperclipai@latest",
    "run",
  ]);
  // 幂等重入：已健康不再发射。
  assert.deepEqual(await controller.start(), { state: "running" });
  assert.equal(h.spawns.length, 1);
});

test("darwin start：bash setsid/nohup 调 npx run，路径被引用", async () => {
  const h = createHarness("darwin");
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.start();
  assert.equal(status.state, "running");
  assert.equal(h.spawns[0]!.command, "/bin/bash");
  const commandText = h.spawns[0]!.args[1]!;
  assert.match(commandText, /paperclipai@latest run/);
  assert.match(commandText, /'\/opt\/homebrew\/bin\/npx'/);
  assert.match(commandText, /setsid nohup/);
});

test("start：找不到 npx 时返回可操作 error", async () => {
  const h = createHarness("darwin", { resolveNpxImpl: () => null });
  const controller = createPaperclipLocalServerController(h.deps);
  const status = await controller.start();
  assert.equal(status.state, "error");
  assert.match(status.detail ?? "", /npx/);
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
  assert.deepEqual(status, { state: "stopped" });
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

test("getStatus：按健康探测合成 running/stopped", async () => {
  const h = createHarness("darwin");
  const controller = createPaperclipLocalServerController(h.deps);
  assert.equal((await controller.getStatus()).state, "stopped");
  h.setHealth(true);
  assert.equal((await controller.getStatus()).state, "running");
});
