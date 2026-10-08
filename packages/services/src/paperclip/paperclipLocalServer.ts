import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PaperclipLocalServerState,
  PaperclipLocalServerStatus,
} from "@zcode/shared";

/**
 * Paperclip 本地 server 生命周期控制器（specs/services/paperclip-integration.md）。
 *
 * 设计约束：server 是跨窗口、跨宿主（desktop host / packages/server）生命周期的
 * 独立进程——这里只"发命令 + 健康探测"，不持有子进程句柄（detached/unref 即发即弃），
 * 因此宿主退出不影响 server，多窗口并发由"启动前先探 health"守卫幂等。
 *
 * 平台默认策略（全平台原生运行，数据库一律外置 PostgreSQL，由系统服务承载）：
 * - darwin/linux：`npx -y paperclipai@latest run`（setsid/nohup 守护）。
 * - win32：`npx.cmd -y paperclipai@latest run`（detached + windowsHide；连接串等配置
 *   由实例 config（~/.paperclip/instances/default/config.json）自带，无需命令行注入）。
 *   Windows 内置 Administrator 账户的全权令牌使内嵌 PostgreSQL 无法原生运行，
 *   外置 PG 服务是 Windows 上的唯一支持形态。
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
    options: { detached: boolean; cwd?: string },
  ) => void;
  /** 测试注入：默认 setTimeout。 */
  delayImpl?: (ms: number) => Promise<void>;
  /** 测试注入：默认真实文件系统（解析 npx 用）。 */
  resolveNpxImpl?: () => string | null;
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
      // detached + ignore + unref：server 与宿主生命周期解耦，命令自身负责守护。
      const child = spawn(command, args, {
        ...options,
        detached: true,
        stdio: "ignore",
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

  function startCommandTimeoutHint(): string {
    return platform === "win32"
      ? "C:\\Users\\<you>\\.paperclip\\run-win.log"
      : "~/.paperclip/server-run.log";
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
      if (platform === "win32") {
        // .cmd 不能被 detached spawn 直接执行（Node 报 EINVAL），经 cmd.exe /c 包裹；
        // 进程树随 detached 独立，宿主退出不影响 server。
        spawnImpl("cmd.exe", ["/c", npx, "-y", "paperclipai@latest", "run"], {
          detached: true,
        });
      } else {
        spawnImpl("/bin/bash", ["-c", posixStartCommand(npx)], { detached: true });
      }
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

/** POSIX 启动命令：setsid/nohup 守护 + 日志重定向。 */
function posixStartCommand(npx: string): string {
  return `setsid nohup ${shellQuote(npx)} -y paperclipai@latest run >> ~/.paperclip/server-run.log 2>&1 &`;
}

/** POSIX 单引号包裹（路径含空格时 bash -c 仍安全）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
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
