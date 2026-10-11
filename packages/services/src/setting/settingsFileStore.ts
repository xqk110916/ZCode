/**
 * setting.json 的文件存储层：路径解析、坏文件隔离、读重试与原子写。
 * 从 settingService.ts 拆出（保持该文件在 max-lines 限制内）；读写语义不变：
 * 半截 JSON 短重试后才隔离、旧 Team 账号字段保留、项目会话三字段不落盘。
 */
import { readFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings } from "@zcode/shared";
import { appSettingsSchema, formatLogPrefix, formatZodError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import { getAppConfigDir } from "../paths.js";
import { isEffectiveDevelopmentNodeEnv } from "../runtime-tools/nodeEnv.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import {
  migrateLegacyAccountConnectionSettings,
  needsLegacyAccountConnectionMigration,
  readIncompleteLegacyTeamConnections,
  readLegacyAccountConnectionSettingsFile,
  retainLegacyAccountConnectionFields,
} from "#src/setting/legacyAccountConnectionSettings.js";
import { stripProjectSessionFields } from "#src/customResources/projectSessionStore.js";

const SETTINGS_PARSE_RETRY_DELAY_MS = 300;
const SETTINGS_PARSE_RETRY_COUNT = 3;

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("settingService", process.pid), ...args);
const debugLog = (...args: unknown[]) => {
  // NODE_ENV 来自用户 shell 时会误导服务层 debug 开关；统一使用 ZCODE_RUNTIME_ENV。
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  console.debug(formatLogPrefix("settingService", process.pid), ...args);
};

function getSettingsDir() {
  // 修复：settings 目录此前独立解析 HOME（ZCODE_DESKTOP_HOME_DIR / HOME / USERPROFILE），
  // 绕过了 paths.ts 的数据根链（setDataBaseDir > ZCODE_DATA_BASE_DIR > HOME），
  // 与 credentials / customResources 收口不一致——桌面 dev 隔离实例与 BoardHub 独立应用
  // 设置了数据根后 setting.json 仍写真实 HOME，污染其他实例。统一走 getAppConfigDir()；
  // 主应用默认数据根即 HOME，路径不变；桌面端隔离经 desktopRuntimeEnv 下发的
  // ZCODE_DATA_BASE_DIR 生效，与凭据等数据目录行为一致。
  return getAppConfigDir();
}

export function getSettingsFile(): string {
  return join(getSettingsDir(), "setting.json");
}

function defaultSettings(): AppSettings {
  return appSettingsSchema.parse({});
}

function buildCorruptSettingsBackupPath(settingsFile: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${settingsFile}.corrupt-${timestamp}`;
}

async function quarantineCorruptSettingsFile(settingsFile: string, error: unknown): Promise<void> {
  const backupPath = buildCorruptSettingsBackupPath(settingsFile);
  try {
    // 用户手动编辑或远端磁盘异常可能把 setting.json 写成非 JSON（例如 ":wq"）。
    // 如果只返回默认值不隔离坏文件，每次启动都会重复解析失败；这里保留备份后让后续 update 重建合法配置。
    maybeThrowInjectedFsFault({ operation: "rename", path: settingsFile });
    await rename(settingsFile, backupPath);
    log("invalid settings json backed up:", backupPath, "error:", error);
  } catch (renameError) {
    if (
      renameError &&
      typeof renameError === "object" &&
      "code" in renameError &&
      (renameError as { code?: string }).code === "ENOENT"
    ) {
      // 启动时多个服务可能同时读取同一个坏 setting.json。
      // 第一个读取已经完成隔离后，后续读取再 rename 会遇到 ENOENT；这是并发下的预期结果，不应当按备份失败刷错误日志。
      log("invalid settings json already quarantined by another reader, returning defaults");
      return;
    }
    log("invalid settings json backup failed, returning defaults. error:", renameError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldPersistSettingsMigrations(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return false;
  const raw = rawValue as Record<string, unknown>;
  return (
    (needsLegacyAccountConnectionMigration(rawValue) &&
      readIncompleteLegacyTeamConnections(rawValue).length === 0) ||
    raw.closeToTrayOnWindowsMigrationInitialized !== true ||
    raw.messageStreamShowReasoningMigrationInitialized !== true
  );
}

export interface ReadSettingsResult {
  settings: AppSettings;
  needsMigrationPersist: boolean;
}

export async function readSettingsWithMeta(): Promise<ReadSettingsResult> {
  const settingsFile = getSettingsFile();
  try {
    // settingService.get() 会被 UI 和远程会话高频调用。
    // 之前每次读取都把完整配置写入生产日志，导致日志暴涨且暴露路径/配置细节；普通读取只保留开发态 debug。
    debugLog("reading settings from:", settingsFile);
    const raw = await readFile(settingsFile, "utf-8");
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(raw);
    } catch (parseError) {
      let lastParseError: unknown = parseError;
      // setting.json 可能正被另一次 update 覆盖写入，读者会短暂读到半截 JSON。
      // 先做短重试，只有连续失败才按坏文件隔离，避免把正常会话配置误清成默认值。
      for (let retryAttempt = 1; retryAttempt <= SETTINGS_PARSE_RETRY_COUNT; retryAttempt += 1) {
        await delay(SETTINGS_PARSE_RETRY_DELAY_MS);
        try {
          rawValue = JSON.parse(await readFile(settingsFile, "utf-8"));
          break;
        } catch (retryParseError) {
          lastParseError = retryParseError;
        }
      }
      if (rawValue === undefined) {
        await quarantineCorruptSettingsFile(settingsFile, lastParseError);
        return {
          settings: defaultSettings(),
          needsMigrationPersist: false,
        };
      }
    }
    const result = appSettingsSchema.safeParse(migrateLegacyAccountConnectionSettings(rawValue));
    if (!result.success) {
      log(
        "read failed schema validation, returning defaults. error:",
        formatZodError(result.error),
      );
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }
    debugLog("read result:", JSON.stringify(result.data));
    return {
      settings: result.data,
      needsMigrationPersist: shouldPersistSettingsMigrations(rawValue),
    };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      debugLog("settings file missing, using defaults");
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }

    // 文件解析失败等异常兜底返回默认值
    log("read failed, returning defaults. error:", err);
    return {
      settings: defaultSettings(),
      needsMigrationPersist: false,
    };
  }
}

export async function readSettings(): Promise<AppSettings> {
  return (await readSettingsWithMeta()).settings;
}

export async function writeSettings(
  settings: AppSettings,
  shouldCommit: () => boolean = () => true,
  runExclusiveCommit: (commit: () => Promise<void>) => Promise<void> = (commit) => commit(),
  enterCommitPhase: () => void = () => undefined,
  commitAccountSelection = false,
): Promise<void> {
  const settingsDir = getSettingsDir();
  const settingsFile = getSettingsFile();
  // Windows 下测试只改了 HOME，模块顶层常量如果在导入时就把 homedir() 固化，
  // 后续读写仍会串到真实用户目录。这里改成每次按当前环境解析配置路径，保证本地和测试都稳定。
  log("writing settings to:", settingsFile, JSON.stringify(settings));
  maybeThrowInjectedFsFault({ operation: "mkdir", path: settingsDir });
  await mkdir(settingsDir, { recursive: true });
  // 写入是 whole-file read-modify-write（保留旧 Team 字段、剔除项目会话字段），
  // 进程内写队列只串行化本实例；BoardHub 的 Web 版与桌面版共用同一份 setting.json，
  // 跨进程丢更新必须由共享文件锁覆盖「读旧值 → 合并 → 原子替换」全过程（与凭据写入同模式）。
  await withFileLock(settingsFile, async () => {
    if (!shouldCommit()) return;
    maybeThrowInjectedFsFault({ operation: "writeFile", path: settingsFile });
    const raw = await readLegacyAccountConnectionSettingsFile(settingsFile);
    const rollbackFields = retainLegacyAccountConnectionFields(raw);
    // 项目会话三字段改存 custom-resources.sqlite（specs/services/custom-resource-store.md）；
    // setting.json 不再持久化这三个 key，旧文件里的值视为废弃。
    const persisted = { ...rollbackFields, ...stripProjectSessionFields(settings) };
    // 旧 Team 尚待 OAuth 补组织时，schema 的默认 {} 不是用户的新选择。
    // 普通偏好保存必须保留新字段缺席；只有迁移提交或用户显式选连接才结束旧导入。
    if (!commitAccountSelection && readIncompleteLegacyTeamConnections(raw).length > 0) {
      delete persisted.providerFamilyConnectionSelections;
    }
    await atomicWriteText(settingsFile, JSON.stringify(persisted, null, 2), {
      // 外层 withFileLock 已持有同一路径的文件锁（覆盖读改写全程）；
      // atomicWriteText 的内建锁不可重入，嵌套会自等死锁，这里显式关闭。
      useFileLock: false,
      beforeRename: () => {
        if (!shouldCommit()) {
          // 提交前超时的旧写只能清理临时文件，不能晚到 rename 覆盖新语言偏好。
          throw new Error("stale settings write skipped before atomic rename");
        }
        enterCommitPhase();
      },
      runRename: (renameFile) =>
        runExclusiveCommit(async () => {
          if (!shouldCommit()) {
            throw new Error("stale settings write skipped before atomic rename");
          }
          await renameFile();
        }),
    });
    log("write done");
  });
}
