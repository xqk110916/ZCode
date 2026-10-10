/**
 * 探索看板定义存储：custom-resources.sqlite 的 resource_kv（key 前缀 db-board-dashboard:）。
 * 模式沿 ProjectSessionStore：损坏值跳过、zod 校验、ensureReady 懒初始化。
 * 看板定义是应用态资源（同自动化），其删除不涉及业务库数据。
 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { getCustomResourcesDatabasePath } from "#src/paths.js";
import { isCustomResourcesStorageMigrated, isCustomResourcesStoragePrepared } from "#src/customResources/database/prepared.js";
import { runCustomResourcesMigrations } from "#src/customResources/database/migrations.js";
import type { DbBoardDashboardSpec, DbBoardDashboardSummary } from "./dbBoard.js";
import { dbBoardDashboardSpecSchema } from "./dbBoardGeneration.js";

// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export const DB_BOARD_DASHBOARD_KEY_PREFIX = "db-board-dashboard:";

export function dashboardKey(id: string): string {
  return `${DB_BOARD_DASHBOARD_KEY_PREFIX}${id}`;
}

export class DbBoardDashboardStore {
  constructor(private readonly options: { dbPath?: string; busyTimeoutMs?: number } = {}) {}
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;

  async ensureReady(): Promise<void> {
    const path = this.options.dbPath ?? getCustomResourcesDatabasePath();
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

  /** 全量看板定义（内部用；list 摘要基于此）。损坏值跳过。 */
  async listAll(): Promise<DbBoardDashboardSpec[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(`SELECT key, value_json FROM resource_kv WHERE key LIKE ? ORDER BY updated_at DESC`)
      .all(`${DB_BOARD_DASHBOARD_KEY_PREFIX}%`) as Array<{ key: string; value_json: string }>;
    const specs: DbBoardDashboardSpec[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value_json);
      } catch {
        continue;
      }
      const validated = dbBoardDashboardSpecSchema.safeParse(parsed);
      if (!validated.success) continue;
      specs.push(validated.data);
    }
    return specs;
  }

  async list(): Promise<DbBoardDashboardSummary[]> {
    const specs = await this.listAll();
    return specs.map((spec) => ({
      id: spec.id,
      title: spec.title,
      chartCount: spec.charts.length,
      updatedAt: spec.updatedAt,
    }));
  }

  async get(id: string): Promise<DbBoardDashboardSpec | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT value_json FROM resource_kv WHERE key = ?`)
      .get(dashboardKey(id)) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = dbBoardDashboardSpecSchema.safeParse(JSON.parse(row.value_json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async save(spec: DbBoardDashboardSpec): Promise<void> {
    const validated = dbBoardDashboardSpecSchema.parse(spec);
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `INSERT INTO resource_kv (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at`,
      )
      .run(dashboardKey(validated.id), JSON.stringify(validated), Date.now());
  }

  async delete(id: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase().prepare(`DELETE FROM resource_kv WHERE key = ?`).run(dashboardKey(id));
  }
}
