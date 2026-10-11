/**
 * BoardHub 桌面壳主进程：utilityProcess 拉起 boardhub-server 单文件 bundle，
 * BrowserWindow 加载其静态托管的 web 产物（同源 /ws，前端零改动）。
 * 端口经 server stdout 的 READY 协议行获取（PORT=0，无探测竞态）；
 * server 意外退出时带退避自愈重启并重载窗口。见 specs/boardhub/standalone-app.md。
 */
import { app, BrowserWindow, utilityProcess, type UtilityProcess } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DEV_START_URL = process.env["ELECTRON_START_URL"]?.trim() || "";
/** 从 fork 到 READY 行的等待上限（server 冷启动含首次 sqlite 初始化）。 */
const READY_TIMEOUT_MS = 15_000;
/** READY 后对 /api/server-info 的确认超时。 */
const HEALTH_TIMEOUT_MS = 5_000;
/** 自愈退避序列；耗尽后停止自动重启，窗口展示错误页。 */
const RESTART_BACKOFF_MS = [1_000, 5_000, 15_000];

/** 桌面主进程事件日志（与 server 日志同目录）：打包形态 stdout 不可见，生命周期事件必须落盘。 */
const desktopEventLogPath = join(process.env["HOME"] ?? "~", ".boardhub/logs/boardhub-desktop.log");
function logEvent(event: string, detail?: unknown): void {
  const line = `[${new Date().toISOString()}] ${event}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`;
  console.warn(`[boardhub-desktop] ${line}`);
  try {
    mkdirSync(dirname(desktopEventLogPath), { recursive: true });
    appendFileSync(desktopEventLogPath, `${line}\n`);
  } catch {
    // 日志失败不阻断主流程。
  }
}

let serverProcess: UtilityProcess | null = null;
/** 已就绪的 server 端口；macOS 关窗重开时复用（server 进程常驻，不重启）。 */
let resolvedServerPort: number | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let restartAttempts = 0;
let restartTimer: NodeJS.Timeout | null = null;

function resolveResourceRoot(): string {
  // 打包后 extraResources 落在 Resources/boardhub/{server,web}；
  // dev 模式从包目录的 resources/ 读。
  return app.isPackaged
    ? join(process.resourcesPath, "boardhub")
    : join(__dirname, "../../resources");
}

function serverLogPath(): string {
  return join(process.env["HOME"] ?? "~", ".boardhub/logs/boardhub-server.log");
}

/**
 * fork server（PORT=0 随机端口）并解析其 stdout 的
 * `BOARDHUB_SERVER_READY {"port":N}` 协议行。
 */
function startServerProcess(): Promise<number> {
  return new Promise((resolve, reject) => {
    const resourceRoot = resolveResourceRoot();
    const entryPath = join(resourceRoot, "server/entry.cjs");
    let settled = false;
    let stdoutBuffer = "";
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`boardhub-server 未在 ${READY_TIMEOUT_MS / 1000}s 内就绪`));
      }
    }, READY_TIMEOUT_MS);

    const child = utilityProcess.fork(entryPath, [], {
      serviceName: "boardhub-server",
      // utilityProcess 的 stdio 默认 inherit（child.stdout 为 null，输出直通主进程终端，
      // READY 协议行无法解析）——必须显式 pipe 才能拿到子进程 stdout。
      stdio: "pipe",
      env: {
        ...process.env,
        PORT: "0",
        BOARDHUB_WEB_ROOT: join(resourceRoot, "web"),
      },
    });
    serverProcess = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(`[boardhub-server] ${text}`);
      stdoutBuffer += text;
      // 按行扫描 READY 协议行（可能与其他日志同 chunk 到达）；解析后清空防重复匹配。
      for (const line of stdoutBuffer.split("\n")) {
        const match = line.match(/^BOARDHUB_SERVER_READY (\{"port":\d+\})\s*$/);
        if (match) {
          const port = (JSON.parse(match[1]!) as { port: number }).port;
          stdoutBuffer = "";
          if (!settled) {
            settled = true;
            logEvent("server-ready", { port });
            clearTimeout(timer);
            resolve(port);
          }
          return;
        }
      }
      stdoutBuffer = stdoutBuffer.slice(-1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[boardhub-server] ${chunk}`);
    });
    child.once("exit", (code) => {
      logEvent("server-process-exit", { code, settled });
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`boardhub-server 提前退出（code ${code}）`));
        return;
      }
      onServerExited(code ?? -1);
    });
  });
}

async function confirmServerHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/server-info`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** server 意外退出（非 app 退出）后的处理：清状态，有存活窗口则退避自愈。 */
function onServerExited(code: number): void {
  logEvent("server-exited", { code, hasWindow: Boolean(mainWindow), quitting });
  serverProcess = null;
  resolvedServerPort = null;
  if (quitting || !mainWindow) {
    return;
  }
  scheduleServerRestart();
}

function scheduleServerRestart(): void {
  if (restartAttempts >= RESTART_BACKOFF_MS.length) {
    logEvent("server-restart-gave-up", { attempts: restartAttempts });
    showStartupError(
      `boardhub-server 连续 ${RESTART_BACKOFF_MS.length} 次重启失败，已停止自动重试。` +
        `日志文件：${serverLogPath()}`,
    );
    return;
  }
  const delay = RESTART_BACKOFF_MS[restartAttempts]!;
  restartAttempts += 1;
  logEvent("server-restart-scheduled", { delay, attempt: restartAttempts });
  restartTimer = setTimeout(() => {
    void recoverServerAndReload();
  }, delay);
}

async function recoverServerAndReload(): Promise<void> {
  if (quitting || !mainWindow) {
    return;
  }
  try {
    const port = await startServerProcess();
    if (!(await confirmServerHealth(port))) {
      throw new Error("health check failed after READY");
    }
    resolvedServerPort = port;
    restartAttempts = 0;
    logEvent("server-recovered", { port });
    if (mainWindow && !quitting) {
      // 端口是新的，reload 不够（旧 URL 指向旧端口），必须整页导航。
      await mainWindow.loadURL(`http://127.0.0.1:${port}`);
    }
  } catch (error) {
    logEvent("server-restart-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    scheduleServerRestart();
  }
}

function showStartupError(message: string): void {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>BoardHub</title></head>
<body style="background:#161616;color:#e2e8f0;font:14px/1.6 -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;margin:0">
<div style="max-width:480px;padding:24px"><h2 style="font-size:15px;margin:0 0 8px">BoardHub 服务启动失败</h2>
<p style="margin:0 0 8px;color:#94a3b8;word-break:break-all">${message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")}</p></div></body></html>`;
  const target =
    mainWindow ??
    new BrowserWindow({
      width: 560,
      height: 320,
      title: "BoardHub",
      backgroundColor: "#161616",
      autoHideMenuBar: true,
    });
  void target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "BoardHub",
    backgroundColor: "#161616",
    autoHideMenuBar: true,
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(url);
}

async function createMainWindow(): Promise<void> {
  if (DEV_START_URL) {
    createWindow(DEV_START_URL);
    return;
  }

  if (!resolvedServerPort) {
    try {
      const port = await startServerProcess();
      if (!(await confirmServerHealth(port))) {
        throw new Error("health check failed after READY");
      }
      resolvedServerPort = port;
    } catch (error) {
      showStartupError(
        `${error instanceof Error ? error.message : String(error)}。日志文件：${serverLogPath()}`,
      );
      return;
    }
  }

  createWindow(`http://127.0.0.1:${resolvedServerPort}`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.on("before-quit", () => {
    // 主动退出路径：exit 回调不得触发自愈重启。
    quitting = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  });

  void app.whenReady().then(() => {
    void createMainWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    // macOS 常驻 Dock（activate 重建窗口、server 进程保活）；其余平台直接退出。
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("will-quit", () => {
    serverProcess?.kill();
    serverProcess = null;
  });
}
