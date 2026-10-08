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
 * 平台默认策略：
 * - win32：server 部署在 WSL（默认发行版）——经 wsl.exe 调 `~/.paperclip/start-server.sh`
 *   （脚本内含 nvm 加载与 setsid/nohup 守护）；停止同时 pkill server 与内嵌 PostgreSQL。
 * - darwin/linux：原生运行——PATH 上无 npx 时（GUI 启动的 ZCode 常见）显式搜索
 *   nvm/Homebrew 常见安装位置。
 */
const HEALTH_TIMEOUT_MS = 3_000;
const START_POLL_INTERVAL_MS = 3_000;
// 实测 WSL 冷启动（npx 解析 + 内嵌 PostgreSQL 初始化）约 130s，留足余量到 5 分钟。
const START_POLL_TIMEOUT_MS = 300_000;
const STOP_POLL_INTERVAL_MS = 2_000;
const STOP_POLL_TIMEOUT_MS = 20_000;

const WSL_START_COMMAND =
  "setsid nohup bash ~/.paperclip/start-server.sh </dev/null >/dev/null 2>&1 &";
// pkill/pgrep 模式用字符类技巧（paperclip[a]i）避免匹配到承载本命令的 bash 自身。
const WSL_STOP_COMMAND =
  'if pgrep -f "paperclip[a]i" >/dev/null; then pkill -f "paperclip[a]i"; pkill -f "instances/default/d[b]"; fi; true';
// 发射脚本与看护循环同处一个由宿主（ZCode host 进程）持有的 wsl.exe 会话：
// WSL/systemd 会在发起会话结束时回收其作用域内的后台进程（setsid 也逃不出 cgroup），
// 因此会话必须由宿主长命持有；看护循环在服务进程消失后自动结束，wsl.exe 自然退出。
const WSL_HOLDER_COMMAND = `${WSL_START_COMMAND} while pgrep -f "paperclip[a]i|start-server.s[h]" >/dev/null; do sleep 10; done`;

export interface PaperclipLocalServerController {
  start(): Promise<PaperclipLocalServerStatus>;
  stop(): Promise<PaperclipLocalServerStatus>;
  getStatus(): Promise<PaperclipLocalServerStatus>;
  /** 释放宿主持有的会话（win32 wsl.exe 看护进程）；不影响服务进程的独立运行语义。 */
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
  /** 测试注入：默认真实 spawn（即发即弃，用于 darwin/linux 原生启动）。 */
  spawnImpl?: (command: string, args: string[], commandText: string) => Promise<void>;
  /**
   * 测试注入：默认真实 spawn 的"宿主持有"变体（win32 用）。返回句柄用于 dispose 清理；
   * 子进程生命周期与当前宿主耦合（宿主退出时由 dispose/进程树回收终止 wsl.exe 会话）。
   */
  spawnHeldImpl?: (command: string, args: string[], commandText: string) => { kill(): void };
  /** 测试注入：默认 setTimeout。 */
  delayImpl?: (ms: number) => Promise<void>;
  /** 测试注入：默认真实文件系统（解析 macOS npx 用）。 */
  resolveNpxImpl?: () => string | null;
  /** 测试注入：启停健康轮询的间隔与上限（默认 3s/120s 与 2s/20s）。 */
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
    (async (command, args) => {
      // detached + ignore + unref：命令自身负责守护（setsid/nohup），宿主不追踪子进程。
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    });
  const spawnHeldImpl =
    deps.spawnHeldImpl ??
    ((command, args) => {
      // 不 unref、保留句柄：wsl.exe 会话与当前宿主同生命周期（见 WSL_HOLDER_COMMAND 注释）。
      const child = spawn(command, args, {
        stdio: "ignore",
        windowsHide: true,
      });
      return {
        kill() {
          child.kill();
        },
      };
    });
  const resolveNpx = deps.resolveNpxImpl ?? (() => resolveDefaultNpx(platform));
  const startPollIntervalMs = deps.startPollIntervalMs ?? START_POLL_INTERVAL_MS;
  const startPollTimeoutMs = deps.startPollTimeoutMs ?? START_POLL_TIMEOUT_MS;
  const stopPollIntervalMs = deps.stopPollIntervalMs ?? STOP_POLL_INTERVAL_MS;
  const stopPollTimeoutMs = deps.stopPollTimeoutMs ?? STOP_POLL_TIMEOUT_MS;

  // 单飞状态：同宿主内并发调用共享同一次动作；跨宿主由 health 守卫兜底。
  let inFlight: Promise<PaperclipLocalServerStatus> | null = null;
  // win32 宿主持有的 wsl.exe 看护句柄（重复 start 只保留最新一个，旧的随服务进程退出）。
  let holder: { kill(): void } | null = null;

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

  async function runStart(): Promise<PaperclipLocalServerStatus> {
    const baseUrl = await deps.resolveBaseUrl();
    if ((await probeHealth(baseUrl)).ok) {
      // 幂等：其他窗口/宿主（或手动）已经把 server 拉起来了。
      return { state: "running" };
    }
    try {
      if (platform === "win32") {
        // wsl.exe 输出可能为 UTF-16，但这里不消费输出；看护循环保证会话在服务存活期间持续被持有。
        holder?.kill();
        holder = spawnHeldImpl(
          "wsl.exe",
          ["--", "bash", "-c", WSL_HOLDER_COMMAND],
          WSL_HOLDER_COMMAND,
        );
      } else {
        const npx = resolveNpx();
        if (!npx) {
          return {
            state: "error",
            detail: "未找到 npx（PATH / nvm / Homebrew），请先安装 Node.js 24.11+",
          };
        }
        const startCommand = `setsid nohup ${shellQuote(npx)} -y paperclipai@latest run >> ~/.paperclip/server-run.log 2>&1 &`;
        await spawnImpl("/bin/bash", ["-c", startCommand], startCommand);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { state: "error", detail };
    }
    const probe = await pollHealth(baseUrl, true, startPollIntervalMs, startPollTimeoutMs);
    if (probe.ok) {
      return { state: "running" };
    }
    // npx 冷启动 + 内嵌 PostgreSQL 初始化可能较慢；超时给出日志位置提示。
    const logHint =
      platform === "win32"
        ? "WSL: ~/.paperclip/instances/default/logs/"
        : "~/.paperclip/server-run.log";
    return {
      state: "error",
      detail: `等待服务就绪超时（${probe.error ?? "health 一直未通过"}）；请检查日志 ${logHint}`,
    };
  }

  async function runStop(): Promise<PaperclipLocalServerStatus> {
    const baseUrl = await deps.resolveBaseUrl();
    if (!(await probeHealth(baseUrl)).ok) {
      return { state: "stopped" };
    }
    try {
      if (platform === "win32") {
        const result = await execFileImpl(
          "wsl.exe",
          ["--", "bash", "-c", WSL_STOP_COMMAND],
          { timeout: 15_000, windowsHide: true },
        );
        void result;
      } else {
        // 字符类技巧避免 pkill 匹配到承载本命令的 bash 自身（与 WSL_STOP_COMMAND 同理）。
        const stopCommand = "pkill -f 'paperclip[a]i'; true";
        const result = await execFileImpl("/bin/bash", ["-c", stopCommand], {
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
        // 进行中的动作由调用方的 start/stop promise 报告最终状态；
        // 这里只透出瞬时语义，避免重复探测造成误导。
        return { state: "unknown" as PaperclipLocalServerState, detail: "action-in-flight" };
      }
      const baseUrl = await deps.resolveBaseUrl();
      const probe = await probeHealth(baseUrl);
      return probe.ok ? { state: "running" } : { state: "stopped" };
    },
    dispose() {
      holder?.kill();
      holder = null;
    },
  };
}

/** POSIX 单引号包裹（路径含空格时 bash -c 仍安全）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** darwin/linux：解析 npx 的实际路径；GUI 启动的 ZCode 进程 PATH 常不含 nvm。 */
function resolveDefaultNpx(platform: NodeJS.Platform): string | null {
  const candidates: string[] = [];
  const home = homedir();
  if (platform === "darwin") {
    candidates.push("/opt/homebrew/bin/npx", "/usr/local/bin/npx");
  } else {
    candidates.push("/usr/bin/npx", "/usr/local/bin/npx");
  }
  // nvm：按版本目录名排序取最新（版本号字符串排序对 vA.B.C 不完全严格，但取最大值足够）。
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
  return null;
}
