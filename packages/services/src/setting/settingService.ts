import { access, readFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AppSettings,
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  formatLogPrefix,
  formatZodError,
} from "@zcode/shared";
import type { ISettingService } from "./setting.js";
import { normalizeSettingsPatch } from "#src/setting/normalizeSettingsPatch.js";
import {
  ProjectSessionStore,
  splitProjectSessionPatch,
  stripProjectSessionFields,
} from "#src/customResources/projectSessionStore.js";
import { createProjectSessionRouting } from "#src/setting/projectSessionRouting.js";
import { copyDataDirectory, getDataBaseDir, validateDataBaseDirTarget } from "../paths.js";
import { isEffectiveDevelopmentNodeEnv } from "../runtime-tools/nodeEnv.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { withSettingsWriteQueueTimeout } from "./settingsWriteQueue.js";
import {
  migrateLegacyAccountConnectionSettings,
  needsLegacyAccountConnectionMigration,
  readLegacyAccountConnectionSettingsFile,
  readIncompleteLegacyTeamConnections,
  retainLegacyAccountConnectionFields,
  type LegacyTeamConnection,
} from "#src/setting/legacyAccountConnectionSettings.js";
const DEFAULT_PROJECT_NAME = "ZCodeProject";
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

function resolveUserHomeDir() {
  // 独立桌面 Dev 实例已设置自己的 home；与 Electron 的显式 home 覆盖一致，避免污染其他实例。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getSettingsDir() {
  return join(resolveUserHomeDir(), ".zcode", "v2");
}

function getSettingsFile() {
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
    // 坏 setting.json 保留备份后隔离，让后续 update 重建合法配置，避免每次启动重复解析失败。
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
      // 并发读取下首个读取已隔离坏文件，后续 rename 遇 ENOENT 是预期结果，不按失败刷错误。
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

interface ReadSettingsResult {
  settings: AppSettings;
  needsMigrationPersist: boolean;
}

async function readSettingsWithMeta(): Promise<ReadSettingsResult> {
  const settingsFile = getSettingsFile();
  try {
    // get() 高频调用，普通读取只保留开发态 debug，避免生产日志暴涨且暴露配置细节。
    debugLog("reading settings from:", settingsFile);
    const raw = await readFile(settingsFile, "utf-8");
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(raw);
    } catch (parseError) {
      let lastParseError: unknown = parseError;
      // setting.json 可能正被另一次 update 覆盖写入（短暂半截 JSON）；先短重试，连续失败才隔离。
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

async function readSettings(): Promise<AppSettings> {
  return (await readSettingsWithMeta()).settings;
}

async function writeSettings(
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
  if (!shouldCommit()) return;
  maybeThrowInjectedFsFault({ operation: "writeFile", path: settingsFile });
  const raw = await readLegacyAccountConnectionSettingsFile(settingsFile);
  const rollbackFields = retainLegacyAccountConnectionFields(raw);
  // 项目三字段改存 custom-resources.sqlite；setting.json 不再持久化这三个 key，旧值废弃。
  const persisted = { ...rollbackFields, ...stripProjectSessionFields(settings) };
  // 旧 Team 尚待 OAuth 补组织时，schema 的默认 {} 不是用户的新选择。
  // 普通偏好保存必须保留新字段缺席；只有迁移提交或用户显式选连接才结束旧导入。
  if (!commitAccountSelection && readIncompleteLegacyTeamConnections(raw).length > 0) {
    delete persisted.providerFamilyConnectionSelections;
  }
  await atomicWriteText(settingsFile, JSON.stringify(persisted, null, 2), {
    beforeRename: () => {
      if (!shouldCommit()) {
        // 提交前超时的旧写只能清理临时文件，不能晚到 rename 覆盖新语言偏好。
        throw new Error("stale settings write skipped before atomic rename");
      }
      enterCommitPhase();
    },
    runRename: (renameFile) =>
      runExclusiveCommit(async () => {
        if (!shouldCommit()) throw new Error("stale settings write skipped before atomic rename");
        await renameFile();
      }),
  });
  log("write done");
}

export function createSettingService(): ISettingService {
  return createSettingServiceWithMigrations().service;
}

/** Host 私有迁移入口，不加入 Setting RPC；普通 get/update 从不等待 OAuth 查询。 */
export function createSettingServiceWithMigrations(): {
  service: ISettingService;
  prepareLegacyAccountConnections: (
    resolveOrganization: (connection: LegacyTeamConnection) => Promise<string | null>,
  ) => Promise<readonly ProviderFamilyDomain[]>;
  /** 关闭项目会话 KV 的 sqlite 连接（dispose 链/测试收尾用）。 */
  close: () => void;
} {
  let updateQueue = Promise.resolve();
  let commitQueue = Promise.resolve();
  let writeQueueGeneration = 0;

  const runSettingsCommit = async (commit: () => Promise<void>) => {
    const queued = commitQueue.then(commit, commit);
    commitQueue = queued.catch(() => {});
    await queued;
  };

  const enqueueSettingsWrite = async (
    runUpdate: (shouldCommit: () => boolean, enterCommitPhase: () => void) => Promise<void>,
  ) => {
    const runCurrentUpdate = () => {
      const currentGeneration = ++writeQueueGeneration;
      const shouldCommit = () => currentGeneration === writeQueueGeneration;
      return withSettingsWriteQueueTimeout(
        (enterCommitPhase) => runUpdate(shouldCommit, enterCommitPhase),
        () => {
          if (writeQueueGeneration === currentGeneration) {
            writeQueueGeneration += 1;
          }
        },
      );
    };
    const queued = updateQueue.then(
      () => runCurrentUpdate(),
      () => runCurrentUpdate(),
    );
    updateQueue = queued.catch(() => {});
    await queued;
  };

  // 项目会话三字段改存 custom-resources.sqlite（specs/services/custom-resource-store.md）。
  const projectSessionStore = new ProjectSessionStore();
  const { applyProjectSessionOverlay, mergeProjectSessionPatch } =
    createProjectSessionRouting(projectSessionStore);

  const service: ISettingService = {
    async get(): Promise<AppSettings> {
      // 设置切换后可能立即创建或冷恢复 Session；读取若越过已入队写入，
      // runtime 会固定旧开关值。先等待现有写队列，保证启动偏好读取到已提交的选择。
      await updateQueue;
      const result = await readSettingsWithMeta();
      if (!result.needsMigrationPersist) {
        return applyProjectSessionOverlay(result.settings);
      }

      await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
        const latest = await readSettingsWithMeta();
        if (!latest.needsMigrationPersist) {
          return;
        }

        // 旧版可能已把默认值落盘，升级后统一迁移一次；在队列内重读最新，避免覆盖并发保存。
        await writeSettings(latest.settings, shouldCommit, runSettingsCommit, enterCommitPhase);
      });

      return applyProjectSessionOverlay(await readSettings());
    },

    async update(patch: Partial<AppSettings>, expectedAccountSettings): Promise<void> {
      const runUpdate = async (shouldCommit: () => boolean, enterCommitPhase: () => void) => {
        const validatedPatch = appSettingsPatchSchema.parse(normalizeSettingsPatch(patch));
        const { projectSessionPatch, filePatch } = splitProjectSessionPatch(
          validatedPatch as Record<string, unknown>,
        );
        const current = await readSettings();
        if (expectedAccountSettings) {
          // 账号查询期间用户可能已手动切换。必须在同一写队列内校验，不能靠调用方先读再写。
          const expected = appSettingsPatchSchema.parse(expectedAccountSettings);
          if (
            current.providerFamilyDomain !== expected.providerFamilyDomain ||
            JSON.stringify(current.providerFamilyConnectionSelections ?? {}) !==
              JSON.stringify(expected.providerFamilyConnectionSelections ?? {})
          ) {
            throw new Error("Account connection settings changed");
          }
        }
        const merged = appSettingsSchema.parse({ ...current, ...filePatch });
        const mergedProjectSession = await mergeProjectSessionPatch(projectSessionPatch);
        if (Object.keys(filePatch).length > 0) {
          await writeSettings(
            merged,
            shouldCommit,
            runSettingsCommit,
            enterCommitPhase,
            Object.hasOwn(patch, "providerFamilyConnectionSelections"),
          );
        }
        if (Object.keys(projectSessionPatch).length > 0) {
          await projectSessionStore.write(mergedProjectSession);
        }
      };
      await enqueueSettingsWrite(runUpdate);
    },

    async updateDataBaseDir(newDir: string | undefined): Promise<void> {
      const currentBaseDir = getDataBaseDir();
      const targetBaseDir = newDir?.trim() || homedir();
      const validation = validateDataBaseDirTarget(targetBaseDir);
      if (!validation.ok) {
        // Windows 安装目录由安装器管理，.zcode/v2 放进去可能在升级时被覆盖；service 层统一拦截。
        const error = new Error(`${validation.code}: ${validation.forbiddenDir}`);
        (error as Error & { code: string }).code = validation.code;
        throw error;
      }

      if (currentBaseDir !== targetBaseDir) {
        log("copying data directory from", currentBaseDir, "to", targetBaseDir);
        await copyDataDirectory(currentBaseDir, targetBaseDir);
        log("data directory copy done");
      }

      await this.update({ dataBaseDir: newDir });
    },

    async ensureDefaultProject(userHomeDir: string): Promise<{ path: string; created: boolean }> {
      const path = join(userHomeDir, DEFAULT_PROJECT_NAME);
      let existedBefore = true;

      try {
        await access(path).catch(() => {
          existedBefore = false;
        });
        maybeThrowInjectedFsFault({ operation: "mkdir", path });
        await mkdir(path, { recursive: true });
      } catch (error) {
        log("ensureDefaultProject failed:", error);
        throw error;
      }

      return { path, created: !existedBefore };
    },
  };

  let inFlight: Promise<readonly ProviderFamilyDomain[]> | null = null;
  let migrationComplete = false;
  return {
    service,
    prepareLegacyAccountConnections(resolveOrganization) {
      // 已完成导入后不让每次请求鉴权重复读迁移文件。恢复旧备份需要重启 Host。
      if (migrationComplete) return Promise.resolve([]);
      if (inFlight) return inFlight;
      const run = async (): Promise<readonly ProviderFamilyDomain[]> => {
        await service.get();
        const original = await readLegacyAccountConnectionSettingsFile(getSettingsFile());
        const incomplete = readIncompleteLegacyTeamConnections(original);
        if (incomplete.length === 0) return [];
        // 网络在写队列外：代理设置读取及用户操作均可继续，不形成 get -> HTTP -> get 循环。
        const resolved = await Promise.all(
          incomplete.map(async (connection) => ({
            ...connection,
            organizationId: await resolveOrganization(connection).catch(() => null),
          })),
        );
        await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
          const latest = await readLegacyAccountConnectionSettingsFile(getSettingsFile());
          // 只核对迁移输入，不因普通语言/窗口设置变化丢失合法结果，也不覆盖用户新账号意图。
          if (
            Object.hasOwn(latest, "providerFamilyConnectionSelections") ||
            latest.providerFamilyDomain !== original.providerFamilyDomain ||
            JSON.stringify(retainLegacyAccountConnectionFields(latest)) !==
              JSON.stringify(retainLegacyAccountConnectionFields(original))
          )
            return;
          if (resolved.some((entry) => !entry.organizationId?.trim())) return;
          const migrated = appSettingsSchema.parse(migrateLegacyAccountConnectionSettings(latest));
          const selections: ProviderFamilyConnectionSelectionSettings = {
            ...migrated.providerFamilyConnectionSelections,
          };
          for (const { family, productId, projectId, organizationId } of resolved) {
            selections[family] = {
              kind: "team-coding-plan",
              productId,
              projectId,
              organizationId: organizationId!.trim(),
            };
          }
          await writeSettings(
            { ...migrated, providerFamilyConnectionSelections: selections },
            shouldCommit,
            runSettingsCommit,
            enterCommitPhase,
            true,
          );
        });
        return readIncompleteLegacyTeamConnections(
          await readLegacyAccountConnectionSettingsFile(getSettingsFile()),
        ).map((entry) => entry.family);
      };
      const pending = run();
      inFlight = pending;
      void pending.then(
        (unresolved) => {
          migrationComplete = unresolved.length === 0;
          if (inFlight === pending) inFlight = null;
        },
        () => {
          if (inFlight === pending) inFlight = null;
        },
      );
      return pending;
    },
    close() {
      projectSessionStore.close();
    },
  };
}
