import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type {
  PaperclipLocalServerState,
  PaperclipLocalServerStatus,
  PaperclipLocalServerVersionInfo,
} from "@zcode/shared";
import {
  PaperclipUpdateCheckCache,
  applyInstalledPaperclipWindowsHidePatch,
  comparePaperclipVersion,
  readInstalledPaperclipVersion,
  resolveDefaultPaperclipInstallDir,
} from "./paperclipLocalServerVersion.js";

/**
 * Paperclip 本地 server 生命周期控制器（specs/services/paperclip-integration.md）。
 *
 * 设计约束：server 是跨窗口、跨宿主（desktop host / packages/server）生命周期的
 * 独立进程——这里只"发命令 + 健康探测"，不持有子进程句柄（detached/unref 即发即弃），
 * 因此宿主退出不影响 server，多窗口并发由"启动前先探 health"守卫幂等。
 *
 * 版本策略：**始终运行固定安装目录（~/.paperclip/server）的本地版本**（不经 npx、
 * 不联网、秒起——npx @latest 每次启动都要 registry 解析，代理网络下 5 分钟超时都
 * 不够，用户表现为"一直在安装"）；本地从未安装才 npm install latest（一次性）。
 * 更新是显式动作（updateLocalServer），checkLocalServerUpdate 负责版本对比（带 TTL 缓存）。
 *
 * 平台默认策略（全平台原生运行，数据库一律外置 PostgreSQL，由系统服务承载）：
 * - node 绝对路径 detached spawn（POSIX 上即 setsid(2)；Windows 上 node.exe 可直接
 *   spawn，无 .cmd 包裹问题）；npm 经 cmd.exe /c npm.cmd 执行（execFile 不能跑 .cmd）。
 *   Windows 内置 Administrator 账户的全权令牌使内嵌 PostgreSQL 无法原生运行，
 *   外置 PG 服务是 Windows 上的唯一支持形态。
 * - 全平台 stdout/stderr 统一落 ~/.paperclip/server-run.log（打包形态无终端，
 *   启动失败时日志是唯一排查渠道）。
 * - 停止：按进程命令行模式匹配终止（powershell Get-CimInstance / pkill，字符类
 *   技巧避免自匹配）；安装目录路径含 paperclipai，模式匹配天然命中；外置
 *   PostgreSQL 服务不随 server 停止（系统服务语义）。
 */
const HEALTH_TIMEOUT_MS = 3_000;
const START_POLL_INTERVAL_MS = 3_000;
// 本地版本直启后只剩数据库迁移（实测 <2min）；@latest 每次联网解析的冷启动已不在此路径。
const START_POLL_TIMEOUT_MS = 300_000;
const STOP_POLL_INTERVAL_MS = 2_000;
const STOP_POLL_TIMEOUT_MS = 20_000;
/** 首次安装 / 更新安装走网络下载，单独计时。 */
const INSTALL_TIMEOUT_MS = 480_000;
/** registry 版本查询（npm view）超时；失败静默（latestVersion=null）。 */
const VIEW_TIMEOUT_MS = 15_000;
/** 更新检查缓存 TTL：TTL 内重复调用不联网。 */
const UPDATE_CHECK_TTL_MS = 600_000;

export interface PaperclipLocalServerController {
  start(): Promise<PaperclipLocalServerStatus>;
  stop(): Promise<PaperclipLocalServerStatus>;
  getStatus(): Promise<PaperclipLocalServerStatus>;
  checkUpdate(): Promise<PaperclipLocalServerVersionInfo>;
  update(): Promise<PaperclipLocalServerStatus>;
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
      /** 子进程环境；启动路径前置 node 同目录保证版本配套。 */
      env?: NodeJS.ProcessEnv;
    },
  ) => void;
  /** 测试注入：默认 setTimeout。 */
  delayImpl?: (ms: number) => Promise<void>;
  /** 测试注入：默认按平台搜索 node/npm（GUI PATH 常不含 nvm）。 */
  resolveToolchainImpl?: () => { node: string; npm: string } | null;
  /** 测试注入：默认真实文件系统（解析 npx 用）。 */
  resolveLogFilePathImpl?: () => string;
  /** 测试注入：安装目录（默认 ~/.paperclip/server）。 */
  resolveInstallDirImpl?: () => string;
  /** 测试注入：读取已安装版本（默认读安装目录 package.json；安装目录由注入方闭包持有）。 */
  readInstalledVersionImpl?: () => string | null;
  /** 测试注入：启停健康轮询的间隔与上限。 */
  startPollIntervalMs?: number;
  startPollTimeoutMs?: number;
  stopPollIntervalMs?: number;
  stopPollTimeoutMs?: number;
  /** 测试注入：安装/更新与查询超时。 */
  installTimeoutMs?: number;
  viewTimeoutMs?: number;
  updateCheckTtlMs?: number;
}

interface HealthProbeResult {
  ok: boolean;
  error?: string;
}

/** 平台工具链解析：node 绝对路径 + npm 可执行（Windows 为 npm.cmd）。 */
function resolveDefaultToolchain(platform: NodeJS.Platform): { node: string; npm: string } | null {
  const candidates: Array<{ node: string; npm: string }> = [];
  const home = homedir();
  if (platform === "win32") {
    // nvm4w（本机即此形态）与用户级 npm 目录；node 兜底 PATH 裸名（spawn 自行解析）。
    candidates.push({
      node: "C:\\nvm4w\\nodejs\\node.exe",
      npm: "C:\\nvm4w\\nodejs\\npm.cmd",
    });
    candidates.push({
      node: join(home, "AppData", "Roaming", "npm", "node.exe"),
      npm: join(home, "AppData", "Roaming", "npm", "npm.cmd"),
    });
  } else {
    candidates.push({ node: "/opt/homebrew/bin/node", npm: "/opt/homebrew/bin/npm" });
    candidates.push({ node: "/usr/local/bin/node", npm: "/usr/local/bin/npm" });
    candidates.push({ node: "/usr/bin/node", npm: "/usr/bin/npm" });
  }
  // POSIX nvm：按版本目录名排序取最新。
  const nvmDir = join(home, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(nvmDir).sort();
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      const bin = join(nvmDir, versions[index]!, "bin");
      candidates.push({ node: join(bin, "node"), npm: join(bin, "npm") });
    }
  } catch {
    // nvm 未安装：跳过。
  }
  for (const candidate of candidates) {
    if (existsSync(candidate.npm)) return candidate;
  }
  // 兜底：PATH 裸名（node 必需；npm 由 cmd/shell 解析）。
  return { node: "node", npm: platform === "win32" ? "npm.cmd" : "npm" };
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
  const resolveToolchain =
    deps.resolveToolchainImpl ?? (() => resolveDefaultToolchain(platform));
  const installDir = deps.resolveInstallDirImpl?.() ?? resolveDefaultPaperclipInstallDir();
  const readInstalledVersion =
    deps.readInstalledVersionImpl ?? (() => readInstalledPaperclipVersion(installDir));
  const startPollIntervalMs = deps.startPollIntervalMs ?? START_POLL_INTERVAL_MS;
  const startPollTimeoutMs = deps.startPollTimeoutMs ?? START_POLL_TIMEOUT_MS;
  const stopPollIntervalMs = deps.stopPollIntervalMs ?? STOP_POLL_INTERVAL_MS;
  const stopPollTimeoutMs = deps.stopPollTimeoutMs ?? STOP_POLL_TIMEOUT_MS;
  const installTimeoutMs = deps.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
  const viewTimeoutMs = deps.viewTimeoutMs ?? VIEW_TIMEOUT_MS;
  const updateCache = new PaperclipUpdateCheckCache(deps.updateCheckTtlMs ?? UPDATE_CHECK_TTL_MS);

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
      ? "Paperclip Server 终端窗口"
      : "~/.paperclip/server-run.log";
  }

  /**
   * 发射 server 进程。
   *
   * Windows：**独立终端窗口长期运行**——服务自带控制台后，它拉起的全部控制台子进程
   * （pg_dump 备份、psql、git、各类探测；paperclipai 多数 spawn 缺 windowsHide）都继承
   * 该控制台而不是新建可见窗口，彻底消除"黑窗口闪一下"（无头形态下无法逐一堵漏，
   * 终端形态是釜底抽薪）。窗口随服务存在：服务退出后 cmd /k 停在提示符保留现场，
   * 停止流程按 paperclipai 命令行模式一并关闭窗口 cmd。日志随窗口可见（不再落
   * server-run.log，该文件仅 POSIX 形态继续使用）。
   *
   * POSIX：无控制台窗口概念，维持 detached 直启 + stdout/stderr 落日志文件
   * （fd 由子进程继承后父侧关闭）。
   */
  function launchServerProcess(node: string): void {
    const entry = join(installDir, "node_modules", "paperclipai", "dist", "index.js");
    // node 同目录前置 PATH 保证配套运行时（npx 时代的老问题：宿主 PATH 里的旧 node 抢跑）。
    const nodeDir = dirname(node);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: process.env.PATH ? `${nodeDir}${delimiter}${process.env.PATH}` : nodeDir,
    };
    if (platform === "win32") {
      // cmd /c start：start 在新控制台窗口里跑 cmd /k node（外层 cmd 即发即弃）；
      // /k 让服务退出后窗口保留提示符，启动失败的报错不至于随窗口一起消失。
      spawnImpl(
        "cmd.exe",
        ["/c", "start", "Paperclip Server", "/D", installDir, "cmd", "/k", node, entry, "run"],
        {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          env,
        },
      );
      return;
    }
    const logFile = resolveLogFilePath();
    mkdirSync(dirname(logFile), { recursive: true });
    const logFd = openSync(logFile, "a");
    // server 以安装目录为 cwd 运行（npm --prefix 产物的相对依赖解析以实际路径为准，
    // cwd 仅为进程语义兜底）。
    try {
      spawnImpl(node, [entry, "run"], {
        detached: true,
        cwd: installDir,
        stdio: ["ignore", logFd, logFd],
        env,
      });
    } finally {
      // 子进程已继承 fd，父侧副本即可关闭；写入失败不阻断启动（探测兜底）。
      closeSync(logFd);
    }
  }

  /** npm install 到固定安装目录（首装或更新）。Windows 的 .cmd 经 cmd.exe /c 执行。 */
  async function runNpmInstall(npm: string): Promise<void> {
    if (platform === "win32") {
      await execFileImpl("cmd.exe", ["/c", npm, "install", "paperclipai@latest", `--prefix`, installDir], {
        timeout: installTimeoutMs,
        windowsHide: true,
      });
    } else {
      await execFileImpl(npm, ["install", "paperclipai@latest", "--prefix", installDir], {
        timeout: installTimeoutMs,
      });
    }
    updateCache.invalidate();
    // 安装产物补丁：pg_dump/psql spawn 缺 windowsHide（每小时备份弹黑窗），npm 重装后重放。
    applyInstalledPaperclipWindowsHidePatch(installDir);
  }

  async function runStart(): Promise<PaperclipLocalServerStatus> {
    const baseUrl = await deps.resolveBaseUrl();
    if ((await probeHealth(baseUrl)).ok) {
      // 幂等：其他窗口/宿主（或手动）已经把 server 拉起来了。
      return { state: "running", installedVersion: readInstalledVersion() ?? undefined };
    }
    const toolchain = resolveToolchain();
    if (!toolchain) {
      return {
        state: "error",
        detail: "未找到 node/npm（PATH / nvm / nvm4w / Homebrew），请先安装 Node.js 24.11+",
      };
    }
    // 本地版本优先：已安装直接运行（不联网）；从未安装才首次安装 latest（一次性）。
    if (!readInstalledVersion()) {
      try {
        await runNpmInstall(toolchain.npm);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { state: "error", detail: `首次安装 paperclipai 失败：${detail}` };
      }
    }
    try {
      launchServerProcess(toolchain.node);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { state: "error", detail };
    }
    const probe = await pollHealth(baseUrl, true, startPollIntervalMs, startPollTimeoutMs);
    if (probe.ok) {
      return { state: "running", installedVersion: readInstalledVersion() ?? undefined };
    }
    // 首装后的数据库迁移可能较慢；超时给出日志位置提示。
    return {
      state: "error",
      detail: `等待服务就绪超时（${probe.error ?? "health 一直未通过"}）；请检查日志 ${startCommandTimeoutHint()}`,
    };
  }

  async function runStop(): Promise<PaperclipLocalServerStatus> {
    const baseUrl = await deps.resolveBaseUrl();
    if (!(await probeHealth(baseUrl)).ok) {
      return { state: "stopped", installedVersion: readInstalledVersion() ?? undefined };
    }
    try {
      if (platform === "win32") {
        // 按命令行匹配 paperclipai 进程终止；外置 PostgreSQL 服务不受影响。
        // 终端形态下同时命中承载服务的 cmd /k 窗口（命令行含 paperclipai 路径），
        // 停止后不留空提示符窗口。"paperclip[a]i" 字符类技巧避免 Get-CimInstance
        // 过滤串匹配到自身命令。
        const result = await execFileImpl(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*paperclip[a]i*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
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
    return { state: "stopped", installedVersion: readInstalledVersion() ?? undefined };
  }

  async function runCheckUpdate(): Promise<PaperclipLocalServerVersionInfo> {
    const installedVersion = readInstalledVersion();
    const cached = updateCache.get();
    if (cached) {
      // 安装目录可能在缓存后被外部改动（手动 npm i），以最新读取的本版本为准合成。
      return {
        ...cached,
        installedVersion,
        updateAvailable:
          installedVersion !== null &&
          cached.latestVersion !== null &&
          comparePaperclipVersion(installedVersion, cached.latestVersion) < 0,
      };
    }
    let latestVersion: string | null = null;
    try {
      const npm = resolveToolchain()?.npm;
      if (npm) {
        if (platform === "win32") {
          const result = await execFileImpl("cmd.exe", ["/c", npm, "view", "paperclipai", "version"], {
            timeout: viewTimeoutMs,
            windowsHide: true,
          });
          latestVersion = result.stdout.trim().split("\n").pop()?.trim() || null;
        } else {
          const result = await execFileImpl(npm, ["view", "paperclipai", "version"], {
            timeout: viewTimeoutMs,
          });
          latestVersion = result.stdout.trim().split("\n").pop()?.trim() || null;
        }
      }
    } catch {
      // registry 查询失败（代理/断网）静默降级：latestVersion=null，UI 不显示更新标识。
    }
    const info: PaperclipLocalServerVersionInfo = {
      installedVersion,
      latestVersion,
      updateAvailable:
        installedVersion !== null &&
        latestVersion !== null &&
        comparePaperclipVersion(installedVersion, latestVersion) < 0,
    };
    if (latestVersion !== null) {
      updateCache.set(info);
    }
    return info;
  }

  async function runUpdate(): Promise<PaperclipLocalServerStatus> {
    const baseUrl = await deps.resolveBaseUrl();
    const wasRunning = (await probeHealth(baseUrl)).ok;
    const toolchain = resolveToolchain();
    if (!toolchain) {
      return {
        state: "error",
        detail: "未找到 node/npm（PATH / nvm / nvm4w / Homebrew），请先安装 Node.js 24.11+",
      };
    }
    try {
      await runNpmInstall(toolchain.npm);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { state: "error", detail: `更新 paperclipai 失败：${detail}` };
    }
    // 更新前服务在运行 → 重启到新版本；未运行则仅安装（下次启动即新版本）。
    if (!wasRunning) {
      return { state: "stopped", installedVersion: readInstalledVersion() ?? undefined };
    }
    await runStop();
    return runStart();
  }

  function launchAction(action: () => Promise<PaperclipLocalServerStatus>): Promise<PaperclipLocalServerStatus> {
    if (!inFlight) {
      inFlight = action().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    start: () => launchAction(runStart),
    stop: () => launchAction(runStop),
    update: () => launchAction(runUpdate),
    checkUpdate: runCheckUpdate,
    async getStatus() {
      if (inFlight) {
        return { state: "unknown" as PaperclipLocalServerState, detail: "action-in-flight" };
      }
      const baseUrl = await deps.resolveBaseUrl();
      const probe = await probeHealth(baseUrl);
      return probe.ok
        ? { state: "running", installedVersion: readInstalledVersion() ?? undefined }
        : { state: "stopped", installedVersion: readInstalledVersion() ?? undefined };
    },
    dispose() {
      // 原生形态下宿主不持有子进程句柄，无需清理。
    },
  };
}
