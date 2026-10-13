/**
 * Paperclip 本地服务版本工具：固定安装目录探测、calver 比较、更新检查缓存。
 *
 * 从 paperclipLocalServer.ts 拆出（保持主文件行数上限）：这些是纯函数/轻 IO，
 * 与生命周期状态机（启停/健康轮询）解耦，各自独立可测。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaperclipLocalServerVersionInfo } from "@zcode/shared";

/** 固定安装目录：npm install --prefix 产物，启动始终运行此目录的已安装版本。 */
export function resolveDefaultPaperclipInstallDir(): string {
  return join(homedir(), ".paperclip", "server");
}

/**
 * 读取安装目录中 paperclipai 的版本（package.json version 字段）。
 * 未安装 / 解析失败返回 null——启动路径据此决定是否需要首次安装。
 */
export function readInstalledPaperclipVersion(installDir: string): string | null {
  try {
    const manifestPath = join(installDir, "node_modules", "paperclipai", "package.json");
    if (!existsSync(manifestPath)) return null;
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * calver/semver 风格比较（a 与 b 按点分段数字比较；段数不同按缺省 0 补齐）。
 * 返回 -1 / 0 / 1；解析不了的段按字符串兜底比较，保证全序。
 */
export function comparePaperclipVersion(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const length = Math.max(pa.length, pb.length);
  for (let index = 0; index < length; index += 1) {
    const na = Number(pa[index] ?? "0");
    const nb = Number(pb[index] ?? "0");
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
      return na < nb ? -1 : 1;
    }
    const sa = pa[index] ?? "0";
    const sb = pb[index] ?? "0";
    if (!Number.isFinite(na) || !Number.isFinite(nb)) {
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/** 更新检查结果缓存：registry 查询走网络（代理环境可能慢），TTL 内复用不重复联网。 */
export class PaperclipUpdateCheckCache {
  private cachedAt = 0;
  private cached: PaperclipLocalServerVersionInfo | null = null;

  constructor(private readonly ttlMs: number) {}

  get(): PaperclipLocalServerVersionInfo | null {
    if (this.cached && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cached;
    }
    return null;
  }

  set(value: PaperclipLocalServerVersionInfo): void {
    this.cached = value;
    this.cachedAt = Date.now();
  }

  /** 更新安装成功后失效缓存，下一次检查立刻反映新版本。 */
  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }
}

/**
 * 安装产物补丁（仅 Windows）：paperclipai 的 pg_dump 备份 / psql 恢复 spawn 未带
 * windowsHide——从无控制台的服务宿主拉起控制台程序会弹可见黑窗（每小时备份一次，
 * 用户表现为「黑窗口闪一下自动关」）。安装/更新后自动补上；模式不匹配（上游已改
 * 或已打过补丁）时静默跳过，绝不让补丁失败阻断安装。
 *
 * 返回是否实际修改（供日志观测）；上游修复后模式消失，本补丁自然退化为 no-op。
 */
export function applyInstalledPaperclipWindowsHidePatch(installDir: string): boolean {
  if (process.platform !== "win32") return false;
  const entry = join(installDir, "node_modules", "paperclipai", "dist", "index.js");
  try {
    let source = readFileSync(entry, "utf-8");
    let changed = false;
    const targets = [
      // pg_dump 备份：stdout 接 gzip 管道落备份文件，每小时定时执行。
      'stdio: ["ignore", "pipe", "pipe"],\n      env: {\n        ...process.env,\n        PGCONNECT_TIMEOUT: String(opts.connectTimeout)',
      // psql 恢复：stdin 喂备份内容。
      'stdio: ["pipe", "ignore", "pipe"],\n      env: {\n        ...process.env,\n        PGCONNECT_TIMEOUT: String(connectTimeout)',
    ];
    for (const pattern of targets) {
      const patched = pattern.replace('pipe"],\n      env:', 'pipe"],\n      windowsHide: true,\n      env:');
      if (source.includes(pattern)) {
        source = source.replace(pattern, patched);
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(entry, source, "utf-8");
    }
    return changed;
  } catch {
    // 补丁是尽力而为：读不到/写失败都不影响安装结果。
    return false;
  }
}
