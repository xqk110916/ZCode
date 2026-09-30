import type { AppSettings } from "@zcode/shared";
import { appSettingsSchema } from "@zcode/shared";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { getCustomResourcesDatabasePath } from "#src/paths.js";
import {
  isCustomResourcesStorageMigrated,
  isCustomResourcesStoragePrepared,
} from "#src/customResources/database/prepared.js";
import { runCustomResourcesMigrations } from "#src/customResources/database/migrations.js";

// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** 项目会话三字段（key 与 AppSettings 字段同名，存 custom-resources.sqlite 的 resource_kv）。 */
export type ProjectSessionFieldName =
  | "lastWorkspaceSession"
  | "recentProjects"
  | "lastActiveTabIndex";

export type ProjectSessionPatch = Partial<Pick<AppSettings, ProjectSessionFieldName>>;

const PROJECT_SESSION_FIELD_NAMES: readonly ProjectSessionFieldName[] = [
  "lastWorkspaceSession",
  "recentProjects",
  "lastActiveTabIndex",
];

export function isProjectSessionField(key: string): key is ProjectSessionFieldName {
  return (PROJECT_SESSION_FIELD_NAMES as readonly string[]).includes(key);
}

/** 拆分 patch：项目字段走 custom-resources KV，其余走 setting.json。 */
export function splitProjectSessionPatch(
  patch: Record<string, unknown>,
): { projectSessionPatch: ProjectSessionPatch; filePatch: Record<string, unknown> } {
  const projectSessionPatch: Record<string, unknown> = {};
  const filePatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (isProjectSessionField(key)) {
      projectSessionPatch[key] = value;
    } else {
      filePatch[key] = value;
    }
  }
  return {
    projectSessionPatch: projectSessionPatch as ProjectSessionPatch,
    filePatch,
  };
}

/** 剔除项目字段：setting.json 不再持久化这三个 key（旧文件里的值视为废弃）。 */
export function stripProjectSessionFields<T extends object>(value: T): T {
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (isProjectSessionField(key)) continue;
    result[key] = entry;
  }
  return result as T;
}

/**
 * 项目会话 KV 读写。值的结构复用 appSettingsSchema 中对应字段校验，
 * 损坏值按缺省处理（get() 会回退 AppSettings 默认值），不阻塞设置读取。
 */
export class ProjectSessionStore {
  constructor(private readonly options: { startupDbPath?: string; busyTimeoutMs?: number } = {}) {}
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;

  async ensureReady(): Promise<void> {
    const path = this.options.startupDbPath ?? getCustomResourcesDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.options.busyTimeoutMs ?? 5000}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (isCustomResourcesStoragePrepared(path, this.db)) return;
    if (!isCustomResourcesStorageMigrated(path, this.db)) runCustomResourcesMigrations(this.db);
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("custom resources sqlite 尚未初始化");
    }
    return this.db;
  }

  /** 只返回 KV 中已存在的字段；损坏值按缺省跳过。 */
  async read(): Promise<ProjectSessionPatch> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(`SELECT key, value_json FROM resource_kv`)
      .all() as Array<{ key: string; value_json: string }>;
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      if (!isProjectSessionField(row.key)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value_json);
      } catch {
        continue;
      }
      // 复用 AppSettings 字段校验，保证 KV 值与 schema 口径一致。
      const validated = appSettingsSchema.safeParse({ [row.key]: parsed });
      if (!validated.success) continue;
      result[row.key] = validated.data[row.key];
    }
    return result as ProjectSessionPatch;
  }

  /** 只写入 patch 中出现的字段（upsert）；不触碰其他 key。 */
  async write(patch: ProjectSessionPatch): Promise<void> {
    const entries = Object.entries(patch).filter(([key]) => isProjectSessionField(key));
    if (entries.length === 0) {
      await this.ensureReady();
      return;
    }
    await this.ensureReady();
    const database = this.getDatabase();
    const now = Date.now();
    const upsert = database.prepare(
      `INSERT INTO resource_kv (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at`,
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of entries) {
        upsert.run(key, JSON.stringify(value), now);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
