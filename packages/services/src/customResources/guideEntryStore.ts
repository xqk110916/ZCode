import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

/** 设置「引导(新)」的一条项目引导记录（specs/ui/settings-guide-new.md）。 */
export interface ZCodeGuideEntry {
  id: string;
  name: string;
  remark: string;
  frontendPaths: string[];
  backendPaths: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateGuideEntryInput {
  name: string;
  remark?: string;
  frontendPaths: string[];
  backendPaths: string[];
}

interface GuideEntryRow {
  entry_id: string;
  name: string;
  remark: string;
  frontend_paths_json: string;
  backend_paths_json: string;
  created_at: number;
  updated_at: number;
}

function parsePathsJson(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function rowToGuideEntry(row: GuideEntryRow): ZCodeGuideEntry {
  return {
    id: row.entry_id,
    name: row.name,
    remark: row.remark ?? "",
    frontendPaths: parsePathsJson(row.frontend_paths_json),
    backendPaths: parsePathsJson(row.backend_paths_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 引导记录唯一所有者：custom-resources.sqlite 的 guide_entries 表。
 * 连接/迁移模式与 ProjectSessionStore 一致（WAL + busy_timeout + 账本迁移，幂等）。
 */
export class GuideEntryStore {
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

  /** 按创建时间倒序列出全部引导记录。 */
  async list(): Promise<ZCodeGuideEntry[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT entry_id, name, remark, frontend_paths_json, backend_paths_json, created_at, updated_at
        FROM guide_entries
        ORDER BY created_at DESC`,
      )
      .all() as unknown as GuideEntryRow[];
    return rows.map(rowToGuideEntry);
  }

  /** 新建引导记录；名称 trim 后非空、前后端路径各至少 1 条由调用方（service 层）校验。 */
  async create(input: CreateGuideEntryInput): Promise<ZCodeGuideEntry> {
    await this.ensureReady();
    const now = Date.now();
    const entry: ZCodeGuideEntry = {
      id: `guide-entry-${randomUUID()}`,
      name: input.name,
      remark: input.remark ?? "",
      frontendPaths: [...input.frontendPaths],
      backendPaths: [...input.backendPaths],
      createdAt: now,
      updatedAt: now,
    };
    this.getDatabase()
      .prepare(
        `INSERT INTO guide_entries (
          entry_id, name, remark, frontend_paths_json, backend_paths_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.name,
        entry.remark,
        JSON.stringify(entry.frontendPaths),
        JSON.stringify(entry.backendPaths),
        entry.createdAt,
        entry.updatedAt,
      );
    return entry;
  }

  /** 删除引导记录；不存在视为成功（幂等）。 */
  async delete(entryId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase().prepare(`DELETE FROM guide_entries WHERE entry_id = ?`).run(entryId);
  }
}
