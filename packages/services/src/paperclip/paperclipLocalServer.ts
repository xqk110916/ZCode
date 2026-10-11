import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { PaperclipLocalServerState, PaperclipLocalServerStatus } from "@zcode/shared";

/**
 * Paperclip 本地 server 生命周期控制器（specs/services/paperclip-integration.md）。
 *
 * 设计约束：server 是跨窗口、跨宿主（desktop host / packages/server）生命周期的
 * 独立进程——这里只"发命令 + 健康探测"，不持有子进程句柄（detached/unref 即发即弃），
 * 因此宿主退出不影响 server，多窗口并发由"启动前先探 health"守卫幂等。
 *
 * 平台默认策略（全平台原生运行，数据库一律外置 PostgreSQL，由系统服务承载）：
 * - darwin/linux：直接 detached spawn `npx -y paperclipai@latest run`（Node 的 detached
 *   在 POSIX 上即 setsid(2) 系统调用，不依赖 shell 与 setsid 命令）。
 * - win32：`npx.cmd -y paperclipai@latest run`（.cmd 不能被 detached spawn 直接执行，
 *   经 cmd.exe /c 包裹；连接串等配置由实例 config 自带，无需命令行注入）。
 *   Windows 内置 Administrator 账户的全权令牌使内嵌 PostgreSQL 无法原生运行，
 *   外置 PG 服务是 Windows 上的唯一支持形态。
 * - 全平台 stdout/stderr 统一落 ~/.paperclip/server-run.log（打包形态无终端，
 *   启动失败时日志是唯一排查渠道）。
 * - GUI/服务进程 PATH 常不含 nvm：npx 解析显式搜索 nvm/Homebrew/nvm4w 常见位置。
 * - 停止：按进程命令行模式匹配终止（powershell Get-CimInstance / pkill，字符类
 *   技巧避免自匹配）；外置 PostgreSQL 服务不随 server 停止（系统服务语义）。
 */
const HEALTH_TIMEOUT_MS = 3_000;
const START_POLL_INTERVAL_MS = 3_000;
// 实测冷启动（npx 解析 + 数据库迁移）约 130s，留足余量到 5 分钟。
const START_POLL_TIMEOUT_MS = 300_000;
const STOP_POLL_INTERVAL_MS = 2_000;
const STOP_POLL_TIMEOUT_MS = 20_000;

export interface PaperclipLocalServerController {
  start(): Promise<PaperclipLocalServerStatus>;
  stop(): Promise<PaperclipLocalServerStatus>;
  getStatus(): Promise<PaperclipLocalServerStatus>;
  dispose(): void;
}

export interface PaperclipLocalServerDeps {
  resolveBaseUrl: () => Promise<string>;
  /** 测试注入：默认 process.platform。 */
  platform?: NodeJS.Platform;
  /** 测试注入：默认真实 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入：默认真实 execFile（回调风格）。 */
  execFileImpl?: (
    command: string,
    args: string[],
    options: { timeout: number; windowsHide?: boolean },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** 测试注入：默认真实 spawn（detached 即发即弃）。 */
  spawnImpl?: (
    command: string,
    args: string[],
    options: {
      detached: boolean;
      cwd?: string;
      /** 子进程 stdio；启动路径传日志 fd 数组，缺省 ignore。 */
      stdio?: Array<"ignore" | number>;
      /** 子进程环境；启动路径前置 npx 同目录保证 node 版本配套。 */
      env?: NodeJS.ProcessEnv;
    },
  ) => void;
  /** 测试注入：默认 setTimeout。 */
  delayImpl?: (ms: number) => Promise<void>;
  /** 测试注入：默认真实文件系统（解析 npx 用）。 */
  resolveNpxImpl?: () => string | null;
  /** 测试注入：启动日志文件路径。 */
  resolveLogFilePathImpl?: () => string;
  /** 测试注入：启停健康轮询的间隔与上限。 */
  startPollIntervalMs?: number;
  startPollTimeoutMs?: number;
  stopPollIntervalMs?: number;
  stopPollTimeoutMs?: number;
}

interface HealthProbeResult {
  ok: boolean;
  error?: string;
}

export function createPaperclipLocalServerController(
  deps: PaperclipLocalServerDeps,
): PaperclipLocalServerController {
  const platform = deps.platform ?? process.platform;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const delay = deps.delayImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const execFileImpl =
    deps.execFileImpl ??
    ((command, args, options) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stderr: String(stderr ?? "") }));
          else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
      }));
  const spawnImpl =
    deps.spawnImpl ??
    ((command, args, options) => {
      // detached + unref：server 与宿主生命周期解耦。POSIX 上 Node 的 detached
      // 即 setsid(2) 系统调用（不依赖 setsid 命令），命令自身无需再守护。
      const child = spawn(command, args, {
        ...options,
        detached: true,
        stdio: options.stdio ?? "ignore",
        windowsHide: true,
      });
      child.unref();
    });
  const resolveNpx = deps.resolveNpxImpl ?? (() => resolveDefaultNpx(platform));
  const startPollIntervalMs = deps.startPollIntervalMs ?? START_POLL_INTERVAL_MS;
  const startPollTimeoutMs = deps.startPollTimeoutMs ?? START_POLL_TIMEOUT_MS;
  const stopPollIntervalMs = deps.stopPollIntervalMs ?? STOP_POLL_INTERVAL_MS;
  const stopPollTimeoutMs = deps.stopPollTimeoutMs ?? STOP_POLL_TIMEOUT_MS;

  // 单飞状态：同宿主内并发调用共享同一次动作；跨宿主由 health 守卫兜底。
  let inFlight: Promise<PaperclipLocalServerStatus> | null = null;

  async function probeHealth(baseUrl: string): Promise<HealthProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${baseUrl}/api/health`, {
        signal: controller.signal,
      });
      return { ok: response.ok };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollHealth(
    baseUrl: string,
    expectOk: boolean,
    intervalMs: number,
    timeoutMs: number,
  ): Promise<HealthProbeResult> {
    const deadline = Date.now() + timeoutMs;
    let last: HealthProbeResult = { ok: !expectOk };
    for (;;) {
      last = await probeHealth(baseUrl);
      if (last.ok === expectOk) return last;
      if (Date.now() >= deadline) return last;
      await delay(intervalMs);
    }
  }

  function resolveLogFilePath(): string {
    return deps.resolveLogFilePathImpl?.() ?? join(homedir(), ".paperclip", "server-run.log");
  }

  function startCommandTimeoutHint(): string {
    return platform === "win32"
      ? "%USERPROFILE%\\.paperclip\\server-run.log"
      : "~/.paperclip/server-run.log";
  }

  /** 发射 server 进程：全平台 stdout/stderr 落日志文件（fd 由子进程继承后父侧关闭）。 */
  function launchServerProcess(npx: string): void {
    const logFile = resolveLogFilePath();
    mkdirSync(dirname(logFile), { recursive: true });
    const logFd = openSync(logFile, "a");
    // npx 的 shebang 是 `#!/usr/bin/env node`：宿主 PATH 里 nvm 等旧版本 node 排前时，
    // npx 会跑在旧 node 上（paperclipai 要求 ≥24.11，本机 nvm 24.7 会被 doctor 拒绝）。
    // npx 与配套 node 同目录，把该目录前置到 PATH 保证版本配套。
    const npxDir = dirname(npx);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: process.env.PATH ? `${npxDir}${delimiter}${process.env.PATH}` : npxDir,
    };
    try {
      const stdio: Array<"ignore" | number> = ["ignore", logFd, logFd];
      if (platform === "win32") {
        // .cmd 不能被 detached spawn 直接执行（Node 报 EINVAL），经 cmd.exe /c 包裹；
        // 进程树随 detached 独立，宿主退出不影响 server。
        spawnImpl("cmd.exe", ["/c", npx, "-y", "paperclipai@latest", "run"], {
          detached: true,
          stdio,
          env,
        });
      } else {
        // POSIX：直接 detached spawn（Node 的 detached 即 setsid(2)，无需 bash/setsid 命令）。
        spawnImpl(npx, ["-y", "paperclipai@latest", "run"], { detached: true, stdio, env });
      }
    } finally {
      // 子进程已继承 fd，父侧副本即可关闭；写入失败不阻断启动（探测兜底）。
      closeSync(logFd);
    }
  }

  async function runStart(): Promise<PaperclipLocalServerStatus> {
    const baseUrl = await deps.resolveBaseUrl();
    if ((await probeHealth(baseUrl)).ok) {
      // 幂等：其他窗口/宿主（或手动）已经把 server 拉起来了。
      return { state: "running" };
    }
    const npx = resolveNpx();
    if (!npx) {
      return {
        state: "error",
        detail: "未找到 npx（PATH / nvm / nvm4w / Homebrew），请先安装 Node.js 24.11+",
      };
    }
    try {
      launchServerProcess(npx);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { state: "error", detail };
    }
    const probe = await pollHealth(baseUrl, true, startPollIntervalMs, startPollTimeoutMs);
    if (probe.ok) {
      return { state: "running" };
    }
    // npx 冷启动 + 数据库迁移可能较慢；超时给出日志位置提示。
    return {
      state: "error",
      detail: `等待服务就绪超时（${probe.error ?? "health 一直未通过"}）；请检查日志 ${startCommandTimeoutHint()}`,
    };
  }

  async function runStop(): Promise<PaperclipLocalServerStatus> {
    const baseUrl = await deps.resolveBaseUrl();
    if (!(await probeHealth(baseUrl)).ok) {
      return { state: "stopped" };
    }
    try {
      if (platform === "win32") {
        // 按命令行匹配 paperclipai 进程终止；外置 PostgreSQL 服务不受影响。
        // "paperclip[a]i" 字符类技巧避免 Get-CimInstance 过滤串匹配到自身命令。
        const result = await execFileImpl(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*paperclip[a]i*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
          ],
          { timeout: 15_000, windowsHide: true },
        );
        void result;
      } else {
        // 字符类技巧避免 pkill 匹配到承载本命令的 bash 自身。
        const result = await execFileImpl("/bin/bash", ["-c", "pkill -f 'paperclip[a]i'; true"], {
          timeout: 15_000,
        });
        void result;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { state: "error", detail };
    }
    const probe = await pollHealth(baseUrl, false, stopPollIntervalMs, stopPollTimeoutMs);
    if (probe.ok) {
      // pollHealth(expectOk=false) 成功返回时 probe.ok 必为 false；仍为 true 说明超时后服务仍存活。
      return {
        state: "error",
        detail: "停止命令已发出，但健康探测仍通过——请手动检查残留进程",
      };
    }
    return { state: "stopped" };
  }

  return {
    start: () => {
      if (!inFlight) {
        inFlight = runStart().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    stop: () => {
      if (!inFlight) {
        inFlight = runStop().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    async getStatus() {
      if (inFlight) {
        return { state: "unknown" as PaperclipLocalServerState, detail: "action-in-flight" };
      }
      const baseUrl = await deps.resolveBaseUrl();
      const probe = await probeHealth(baseUrl);
      return probe.ok ? { state: "running" } : { state: "stopped" };
    },
    dispose() {
      // 原生形态下宿主不持有子进程句柄，无需清理。
    },
  };
}

/** 解析 npx 实际路径：GUI/服务进程 PATH 常不含 nvm 与用户级安装位置。 */
function resolveDefaultNpx(platform: NodeJS.Platform): string | null {
  const candidates: string[] = [];
  const home = homedir();
  if (platform === "win32") {
    // nvm4w（本机即此形态）与用户级 npm 目录；找不到时兜底 PATH 上的 npx.cmd。
    candidates.push(
      "C:\\nvm4w\\nodejs\\npx.cmd",
      join(home, "AppData", "Roaming", "npm", "npx.cmd"),
    );
  } else if (platform === "darwin") {
    candidates.push("/opt/homebrew/bin/npx", "/usr/local/bin/npx");
  } else {
    candidates.push("/usr/bin/npx", "/usr/local/bin/npx");
  }
  // POSIX nvm：按版本目录名排序取最新。
  const nvmDir = join(home, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(nvmDir).sort();
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      candidates.push(join(nvmDir, versions[index]!, "bin", "npx"));
    }
  } catch {
    // nvm 未安装：跳过。
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // 兜底：PATH 上的裸名（spawn 自行解析）。
  return platform === "win32" ? "npx.cmd" : "npx";
}
