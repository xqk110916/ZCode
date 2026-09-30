import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- task 索引仓库集中维护 sqlite schema、查询和状态写入，迁移稳定后再按读写职责拆分。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  ZCODE_AGENT_PROVIDER,
  zcodeTaskMetaSchema,
  resolveWorkspaceKey,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListItem,
} from "#src/session/zcodeTaskListTypes.js";
import type { ZCodeGroupedTaskRef } from "#src/session/zcodeTaskListTypes.js";
import type {
  TaskGroupStorePort,
  TaskGroupTaskProjection,
  TaskGroupTaskReaderPort,
} from "#src/customResources/customResourcesRepo.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function appendZCodeAgentIndexedProviderFilter(
  where: string[],
  args: Array<string | number>,
  provider: ZCodeProvider,
): void {
  // 列表按当前 runtime provider 过滤；历史导入来源不改变此边界。
  where.push("provider = ?");
  args.push(provider);
}
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface TaskIndexRow {
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

interface TaskIndexWriteRecord {
  meta: ZCodeTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
  // 只有 unread 专属写路径可以修改现有行，其他 metadata/snapshot 写必须保留当前 CAS marker。
  writeUnreadAt?: boolean;
  // searchableText 可空：传入 undefined 表示保留 existing 行的现有值。
  // 这样 applyAgentPatch / updateTaskState 这类不带 messages 上下文的写入不会把已索引的正文清空。
  searchableText?: string;
}

interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  title?: string;
  titleOverridden?: boolean;
  unreadAt?: number;
  model?: string;
  status?: ZCodeTaskMeta["status"];
  lastError?: ZCodeTaskMeta["lastError"];
  target?: ZCodeTaskMeta["target"];
  updatedAt?: number;
}

// 关键业务逻辑：聊天内容搜索只需要可匹配文本，不需要把完整超长会话无限塞进 sqlite 索引。
// 这里做上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;
const TASK_SEARCH_SNIPPET_PREFIX_RADIUS = 20;
const TASK_SEARCH_SNIPPET_SUFFIX_RADIUS = 72;
const TASK_SEARCH_SNIPPET_MAX_CHARS = 140;
const TASK_SEARCH_SNIPPET_LIMIT = 4;

const logger = createServiceLogger("task-index-repo");

function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

function isTerminalTaskStatus(status: ZCodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

function shouldPreserveNewerTerminalStatus(
  existingMeta: ZCodeTaskMeta | null,
  incomingMeta: ZCodeTaskMeta,
): boolean {
  if (!existingMeta || !isTerminalTaskStatus(existingMeta.status)) {
    return false;
  }
  if (incomingMeta.status && incomingMeta.status !== "running") {
    return false;
  }
  return existingMeta.updatedAt > incomingMeta.updatedAt;
}

function resolveTaskIndexRowWorkspaceIdentity(row: TaskIndexRow): string | undefined {
  const columnIdentity = row.workspace_identity?.trim();
  if (columnIdentity === row.workspace_key) {
    return columnIdentity;
  }
  // workspace_key 是 SQLite 查询与主键隔离的真实依据；只要它是统一格式的远端 identity，
  // 返回值就必须与它一致，不能让残留的 workspace_identity 列把实体投影到另一个远端。
  if (isRemoteWorkspaceIdentity(row.workspace_key)) {
    return row.workspace_key;
  }
  // identity 投影与主键不一致时不能采用，也不能把远端实体退回 workspacePath，
  // 否则相同路径的不同远端会在侧栏 activity join 时串行。
  return undefined;
}

function rowToMeta(row: TaskIndexRow): ZCodeTaskMeta {
  const workspaceIdentity = resolveTaskIndexRowWorkspaceIdentity(row);
  try {
    const parsed = zcodeTaskMetaSchema.safeParse(JSON.parse(row.meta_json));
    if (parsed.success) {
      return {
        ...(parsed.data as ZCodeTaskMeta),
        // SQLite 使用这些字段查询并隔离实体，旧 meta_json 里的 identity
        // 可能缺失或属于旧远端。读取时必须与行主键投影一致，sessions-index 才能
        // 按 workspaceKey + taskId 附加 running activity。
        taskId: row.task_id,
        workspacePath: row.workspace_path,
        workspaceIdentity,
        // unread 是 tasks-index 产品壳状态；标量列必须覆盖可能来自其他 Host 的旧 meta_json。
        unreadAt: row.unread_at ?? undefined,
        // cron 身份以 meta_json 为准；cron_automation_id 列是索引投影，仅作兜底：
        // 历史行 meta_json 里可能还没有该字段，回退读列，下次写入会自动回填进 meta_json。
        cronAutomationId: parsed.data.cronAutomationId ?? row.cron_automation_id ?? undefined,
        // off-peak 身份同款策略：meta_json 为准、列兜底——存量迁移只写列即可生效。
        offPeakTaskId: parsed.data.offPeakTaskId ?? row.off_peak_task_id ?? undefined,
        titleOverridden: row.title_overridden === 1,
      };
    }
    logger.warn(
      undefined,
      `读取 task index meta_json 非法 taskId=${row.task_id}`,
      parsed.error.flatten(),
    );
  } catch (error) {
    logger.warn(undefined, `读取 task index meta_json 失败 taskId=${row.task_id}`, error);
  }

  return {
    taskId: row.task_id,
    traceId: `zcode-${row.task_id}`,
    title: row.title,
    titleOverridden: row.title_overridden === 1,
    workspacePath: row.workspace_path,
    workspaceIdentity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mode: row.mode as ZCodeTaskMeta["mode"],
    model: row.model ?? undefined,
    provider: row.provider === ZCODE_AGENT_PROVIDER ? ZCODE_AGENT_PROVIDER : undefined,
    migrationSource: (row.migration_source as ZCodeTaskMeta["migrationSource"]) ?? undefined,
    forkedFromTaskId: row.forked_from_task_id ?? undefined,
    cronAutomationId: row.cron_automation_id ?? undefined,
    offPeakTaskId: row.off_peak_task_id ?? undefined,
    unreadAt: row.unread_at ?? undefined,
    status: (row.task_status as ZCodeTaskMeta["status"]) ?? undefined,
  };
}

/** 序列化 meta 到 meta_json。cron 身份随 meta 一起写入（单一来源），另在 writeRecord 投影到 cron_automation_id 索引列。 */
function serializeMetaJson(meta: ZCodeTaskMeta): string {
  return JSON.stringify(meta);
}

function normalizeLimit(limit: number | undefined): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  return [
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeSearchSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TASK_SEARCH_SNIPPET_MAX_CHARS);
}

// 全局会话搜索 (TaskSearchDialog) 期望命中正文时返回若干片段做摘要展示。
// 以匹配点为中心截窗，去重相近窗口，最多 4 条；
// 全部未命中（title 命中）时回退一条整段摘要，避免下方空白。
function buildSearchSnippets(searchableText: string, search: string | null): string[] {
  if (!search || !searchableText.trim()) {
    return [];
  }

  const normalizedSearch = search.toLocaleLowerCase();
  const normalizedText = searchableText.toLocaleLowerCase();
  const snippets: string[] = [];
  const snippetRanges: Array<{ start: number; end: number }> = [];
  let searchStart = 0;

  while (snippets.length < TASK_SEARCH_SNIPPET_LIMIT && searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedSearch, searchStart);
    if (matchIndex < 0) {
      break;
    }

    const start = Math.max(0, matchIndex - TASK_SEARCH_SNIPPET_PREFIX_RADIUS);
    const end = Math.min(
      searchableText.length,
      matchIndex + normalizedSearch.length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS,
    );
    const prefix = start > 0 ? "..." : "";
    const suffix = end < searchableText.length ? "..." : "";
    const snippet = normalizeSearchSnippetText(
      `${prefix}${searchableText.slice(start, end)}${suffix}`,
    );
    const overlapsExistingSnippet = snippetRanges.some(
      (range) => Math.min(range.end, end) - Math.max(range.start, start) > 0,
    );
    // 同一个关键词在很近的位置多次出现时，摘要窗口会高度重叠；服务端先合并近重复摘要。
    if (snippet && !overlapsExistingSnippet) {
      snippets.push(snippet);
      snippetRanges.push({ start, end });
    }
    searchStart = matchIndex + normalizedSearch.length;
  }

  if (snippets.length === 0) {
    // title 命中但正文没命中时，仍给一条整段摘要兜底，避免标题下方空白。
    const fallbackSnippet = normalizeSearchSnippetText(searchableText);
    return fallbackSnippet ? [fallbackSnippet] : [];
  }

  return snippets;
}

function rowToTaskListItem(row: TaskIndexRow, search: string | null): ZCodeTaskListItem {
  const meta = rowToMeta(row);
  const snippets = buildSearchSnippets(row.searchable_text, search);
  if (snippets.length === 0) {
    return meta;
  }
  return { ...meta, searchSnippet: snippets[0], searchSnippets: snippets };
}

export class TaskIndexRepo implements TaskGroupTaskReaderPort {
  constructor(
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}
  /**
   * 分组存储所有者（custom-resources.sqlite）。组合根装配 CustomResourcesRepo 后绑定；
   * 未绑定时任务生命周期里的分组钩子 no-op（单测 / storage worker 等独立实例场景）。
   */
  private taskGroupStore: TaskGroupStorePort | null = null;
  bindTaskGroupStore(store: TaskGroupStorePort): void {
    this.taskGroupStore = store;
  }
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly writeChains = new Map<string, Promise<void>>();

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        // 释放失败连接；迁移后修复可能已部分提交，重试仍走原幂等初始化。
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
      // ignore close errors
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // 多窗口 Host 共用 tasks-index；写事务和首次 schema 升级应短暂等待，而不是立即 SQLITE_BUSY。
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // Worker 已完成该路径的原始准备，业务连接不再重复全表修复。
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
    this.backfillOffPeakTaskMarkers();
    // 分组存储已拆到 custom-resources.sqlite（从零开始，旧库分组存量废弃）；
    // 这里只按 deleted tombstone 收敛新库残留引用，替代旧库内的分组自愈。
    await this.cleanupDeletedTaskGroupReferencesViaStore();
  }

  private async cleanupDeletedTaskGroupReferencesViaStore(): Promise<void> {
    if (!this.taskGroupStore) {
      return;
    }
    try {
      const rows = this.getDatabase()
        .prepare(
          `SELECT workspace_key, task_id
          FROM tasks
          WHERE deleted = 1`,
        )
        .all() as Array<{ workspace_key: string; task_id: string }>;
      if (rows.length === 0) {
        return;
      }
      await this.taskGroupStore.cleanupTaskGroupingReferences(
        rows.map((row) => ({ workspaceKey: row.workspace_key, taskId: row.task_id })),
      );
    } catch (error) {
      logger.warn(undefined, "启动收敛 task 分组引用失败（下次启动重试）", error);
    }
  }

  /**
   * 存量回填（幂等，每次 bootstrap 自愈）：打点上线前产生的 off-peak 会话行没有
   * offPeakTaskId。off_peak_tasks 与 tasks 同库（tasks-index.sqlite），按 session 绑定
   * join 只补投影列——rowToMeta 以列兜底即可生效，下次 syncTaskMeta 会自动回填 meta_json。
   * 全新安装时 off_peak_tasks 可能尚未由 OffPeakTaskRepo 建表，需 guard。
   */
  private backfillOffPeakTaskMarkers(): void {
    const database = this.getDatabase();
    const hasOffPeakTable = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
      .get();
    if (!hasOffPeakTable) {
      return;
    }
    database
      .prepare(
        `UPDATE tasks SET off_peak_task_id = (
          SELECT o.off_peak_task_id FROM off_peak_tasks o
          WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
        )
        WHERE off_peak_task_id IS NULL
          AND EXISTS (
            SELECT 1 FROM off_peak_tasks o
            WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
          )`,
      )
      .run();
  }

  private deleteTaskGroupingReferencesSafe(
    workspaceKeyValue: string,
    taskId: string,
  ): Promise<void> {
    if (!this.taskGroupStore) {
      return Promise.resolve();
    }
    // 拆库后任务删除与分组清理不再同事务；清理失败仅告警，
    // tombstone 保留，下次进程启动的收敛逻辑自愈（幂等）。
    return this.taskGroupStore
      .deleteTaskGroupingReferences(workspaceKeyValue, taskId)
      .catch((error) => {
        logger.warn(undefined, `清理 task 分组引用失败 taskId=${taskId}`, error);
      });
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("task index sqlite 尚未初始化");
    }
    return this.db;
  }

  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  private enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = this.writeKey(params);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    return result;
  }

  private getTaskRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): TaskIndexRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
    return row ?? null;
  }

  async archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const normalizedDays = Math.max(1, Math.floor(params.olderThanDays));
    const cutoff = Date.now() - normalizedDays * 24 * 60 * 60 * 1000;
    const where = [
      "workspace_key = ?",
      "deleted = 0",
      "archived = 0",
      "pinned = 0",
      "unread_at IS NULL",
      "updated_at < ?",
      "task_status = 'completed'",
    ];
    const args: Array<string | number> = [workspaceKey(params), cutoff];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
      )
      .all(...args) as unknown as TaskIndexRow[];
    if (rows.length === 0) {
      return [];
    }

    const archiveTask = this.getDatabase().prepare(
      `UPDATE tasks
      SET archived = 1
      WHERE workspace_key = ? AND task_id = ?`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        archiveTask.run(row.workspace_key, row.task_id);
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
    return rows.map(rowToMeta);
  }

  private writeRecord(record: TaskIndexWriteRecord): ZCodeTaskMeta {
    // searchable_text 传 undefined 表示"不动现有值"。读一次 row 拿到当前值，
    // 否则 ON CONFLICT 时 excluded.searchable_text 会被赋成空字符串，把已索引正文清空。
    const existing =
      record.searchableText === undefined
        ? this.getTaskRow({
            workspacePath: record.meta.workspacePath,
            workspaceIdentity: record.meta.workspaceIdentity,
            taskId: record.meta.taskId,
          })
        : null;
    const searchableText =
      record.searchableText !== undefined
        ? record.searchableText.slice(0, TASK_SEARCH_TEXT_MAX_CHARS)
        : (existing?.searchable_text ?? "");
    this.getDatabase()
      .prepare(
        `INSERT INTO tasks (
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        ) VALUES (
          @workspace_key,
          @workspace_path,
          @workspace_identity,
          @task_id,
          @title,
          @task_status,
          @provider,
          @mode,
          @model,
          @migration_source,
          @forked_from_task_id,
          @cron_automation_id,
          @off_peak_task_id,
          @created_at,
          @updated_at,
          @unread_at,
          @last_unread_at,
          @pinned,
          @archived,
          @deleted,
          @title_overridden,
          @searchable_text,
          @meta_json
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          forked_from_task_id = excluded.forked_from_task_id,
          cron_automation_id = excluded.cron_automation_id,
          off_peak_task_id = excluded.off_peak_task_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = CASE
            WHEN @write_unread_at = 1 THEN excluded.unread_at
            ELSE tasks.unread_at
          END,
          last_unread_at = MAX(
            tasks.last_unread_at,
            COALESCE(tasks.unread_at, 0),
            CASE WHEN @write_unread_at = 1 THEN excluded.last_unread_at ELSE 0 END
          ),
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json`,
      )
      .run({
        workspace_key: workspaceKey(record.meta),
        workspace_path: record.meta.workspacePath,
        workspace_identity: record.meta.workspaceIdentity ?? null,
        task_id: record.meta.taskId,
        title: record.meta.title,
        task_status: record.meta.status ?? null,
        provider: record.meta.provider ?? null,
        mode: record.meta.mode,
        model: record.meta.model ?? null,
        migration_source: record.meta.migrationSource ?? null,
        forked_from_task_id: record.meta.forkedFromTaskId ?? null,
        // cron automation 身份从 meta 投影到索引列（meta_json 里也保留一份，见 serializeMetaJson）。
        cron_automation_id: record.meta.cronAutomationId ?? null,
        // off-peak 身份同款投影。
        off_peak_task_id: record.meta.offPeakTaskId ?? null,
        created_at: record.meta.createdAt,
        updated_at: record.meta.updatedAt,
        unread_at: record.meta.unreadAt ?? null,
        last_unread_at: record.meta.unreadAt ?? 0,
        write_unread_at: record.writeUnreadAt ? 1 : 0,
        pinned: record.pinned ? 1 : 0,
        archived: record.archived ? 1 : 0,
        deleted: record.deleted ? 1 : 0,
        title_overridden: record.titleOverridden ? 1 : 0,
        searchable_text: searchableText,
        meta_json: serializeMetaJson(record.meta),
      });
    const persisted = this.getTaskRow(record.meta);
    if (!persisted) {
      throw new Error(`task index 写入后缺少 task: ${record.meta.taskId}`);
    }
    return rowToMeta(persisted);
  }

  async syncTaskMeta(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    // 调用方可以从 snapshot.messages 计算正文，传进来同步刷新 searchable_text。
    // 不传则保留 sqlite 已有的 searchable_text（在 writeRecord 里兜底）。
    searchableText?: string;
  }): Promise<ZCodeTaskMeta> {
    const result = await this.syncTaskMetaWithGroupedAdmission(params, false);
    return result.meta;
  }

  /** 首次公开 root task 时，原子提交 task row 与 grouped 顶层顺序。 */
  async syncTaskMetaAtGroupedTop(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    return this.syncTaskMetaWithGroupedAdmission(params, true);
  }

  private async syncTaskMetaWithGroupedAdmission(
    params: {
      meta: ZCodeTaskMeta;
      pinned?: boolean;
      archived?: boolean;
      deleted?: boolean;
      titleOverridden?: boolean;
      searchableText?: string;
    },
    initializeGroupedAtTop: boolean,
  ): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, async () => {
      const database = this.getDatabase();
      if (initializeGroupedAtTop) database.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        const existingMeta = existing ? rowToMeta(existing) : null;
        const titleOverridden = params.titleOverridden ?? existing?.title_overridden === 1;
        // snapshot 来源的 updatedAt 是 runtime sessionStore 里的"最后一次结构变更"时间，
        // 不一定包含 session.titleUpdated / turn.completed 这些事件触发的 Date.now() 增量。
        // 如果这里直接用 params.meta.updatedAt 覆盖，会把刚刚走 applyAgentPatch 写入的更新时间戳冲回旧值，
        // 表现为新会话第一次 prompt 后又被压回列表底部。这里取与 sqlite 已有值的 max，保证单调不回退。
        const updatedAt = Math.max(params.meta.updatedAt, existingMeta?.updatedAt ?? 0);
        const preserveExistingTerminalStatus = shouldPreserveNewerTerminalStatus(
          existingMeta,
          params.meta,
        );
        const meta: ZCodeTaskMeta = {
          ...params.meta,
          // agent 只负责 session 核心标题，用户手动重命名属于 app 侧 task 状态。
          // 同步 agent snapshot 时保留已覆盖标题，避免后台状态刷新把用户标题冲掉。
          title: titleOverridden && existingMeta ? existingMeta.title : params.meta.title,
          titleOverridden,
          // turn.completed 会先通过 applyAgentPatch 写入较新的 completed/error。
          // 随后到达的 protocol snapshot 可能仍带较旧 running；如果这里降级 status，
          // 手机 replayable 切回 task 时就会把已完成任务恢复成“工作中”。
          status: preserveExistingTerminalStatus ? existingMeta?.status : params.meta.status,
          lastError: preserveExistingTerminalStatus
            ? existingMeta?.lastError
            : params.meta.lastError,
          target: Object.prototype.hasOwnProperty.call(params.meta, "target")
            ? params.meta.target
            : existingMeta?.target,
          // Claude Code 导入升级成真实 ZCode session 后，protocol snapshot
          // 本身不知道迁移来源。同步运行态快照时保留已有 migrationSource，避免
          // 列表过滤和后续切模型把导入任务重新当成普通 ZCode 任务。
          migrationSource: params.meta.migrationSource ?? existingMeta?.migrationSource,
          // 同步运行态快照时保留已有 cron automation 身份：运行态 protocol snapshot 的 meta 不带 cron 标记，
          // 不用已存值兜底会在后续 sync 时把 cron 身份冲掉，导致 icon / 分组 / 关联查询失效。
          cronAutomationId: params.meta.cronAutomationId ?? existingMeta?.cronAutomationId,
          // off-peak 身份同款兜底：快照不带标记时保全既有归属。
          offPeakTaskId: params.meta.offPeakTaskId ?? existingMeta?.offPeakTaskId,
          updatedAt,
          unreadAt: params.meta.unreadAt ?? existingMeta?.unreadAt,
        };
        const persistedMeta = this.writeRecord({
          meta,
          pinned: params.pinned ?? existing?.pinned === 1,
          archived: params.archived ?? existing?.archived === 1,
          deleted: params.deleted ?? existing?.deleted === 1,
          titleOverridden,
          searchableText: params.searchableText,
        });
        // 任务行（含事务模式）先同步提交完毕，再执行分组钩子：
        // 分组存储已拆到 custom-resources.sqlite，跨库无法同事务。
        if (initializeGroupedAtTop) database.exec("COMMIT");
        // 分组钩子失败只告警不回滚任务行：缺序节点由查询 normalize 按 createdAt 自愈，
        // cron/off-peak 归组在下次 sync 补齐（幂等 OR IGNORE 语义保持不变）。
        // cron session 首次获得 cronAutomationId 时归入固定 cron 分组。
        // 会话内 CronCreate 是给已有 task 补 cron 标记，不能只判断 !existing，否则左侧列表不会归入定时任务分组。
        // INSERT OR IGNORE 不覆盖已有成员关系——用户后续把它拖出 cron 组后不会被自动拖回。
        if (meta.cronAutomationId && !existingMeta?.cronAutomationId) {
          await this.ensureCronGroupMembershipSafe(meta);
        }
        // 闲时会话首次获得 offPeakTaskId 时归入固定闲时系统分组（机制同 cron）。
        if (meta.offPeakTaskId && !existingMeta?.offPeakTaskId) {
          await this.ensureOffPeakGroupMembershipSafe(meta);
        }
        // root draft 首发过去先提交 task row，再另一次写 sort_order；
        // sessions-index 在两次写之间公开 task 时，Renderer 会把缺序节点补到末尾。
        const initializedGroupedOrder = initializeGroupedAtTop
          ? await this.initializeGroupedTaskAtTopSafe(meta)
          : false;
        return { meta: persistedMeta, initializedGroupedOrder };
      } catch (error) {
        // 分组钩子不抛错（safe 包装），到达这里时事务若仍打开说明任务行写入失败。
        if (initializeGroupedAtTop && database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  private async ensureCronGroupMembershipSafe(
    meta: ZCodeTaskMeta,
  ): Promise<void> {
    if (!this.taskGroupStore) {
      return;
    }
    try {
      await this.taskGroupStore.ensureCronGroupMembership(meta);
    } catch (error) {
      logger.warn(undefined, `cron 系统分组归属写入失败 taskId=${meta.taskId}`, error);
    }
  }

  private async ensureOffPeakGroupMembershipSafe(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  ): Promise<void> {
    if (!this.taskGroupStore) {
      return;
    }
    try {
      await this.taskGroupStore.ensureOffPeakGroupMembership(meta);
    } catch (error) {
      logger.warn(undefined, `闲时系统分组归属写入失败 taskId=${meta.taskId}`, error);
    }
  }

  /** 任务首次公开且未分组时写入顶层排序（分组落在 custom-resources.sqlite）。 */
  private async initializeGroupedTaskAtTopSafe(params: ZCodeGroupedTaskRef): Promise<boolean> {
    if (!this.taskGroupStore) {
      return false;
    }
    try {
      const row = this.getTaskRow(params);
      if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
        return false;
      }
      return await this.taskGroupStore.initializeTaskAtTopIfAbsent(params);
    } catch (error) {
      logger.warn(undefined, `初始化 task 顶层排序失败 taskId=${params.taskId}`, error);
      return false;
    }
  }

  /**
   * 只在索引行不存在时写入基线元数据；已存在（含已删除）的产品壳状态原样保留。
   *
   * 远端 workspace 的 V4 会话路径可能晚于会话创建才建立 sessions-index
   * 订阅。首次 snapshot 必须能补齐全新的 tasks-index.sqlite，但不能用摘要默认值
   * 覆盖已有的 pin/archive/unread/手动标题，也不能与随后到达的完整 snapshot 竞态回写。
   */
  async seedTaskMetaIfMissing(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(meta, () => {
      const existing = this.getTaskRow(meta);
      if (existing) {
        return rowToMeta(existing);
      }
      return this.writeRecord({
        meta,
        pinned: false,
        archived: false,
        deleted: false,
        titleOverridden: meta.titleOverridden ?? false,
      });
    });
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1) {
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        }
        const current = rowToMeta(row);
        if (current.unreadAt !== params.expectedUnreadAt) {
          database.exec("COMMIT");
          return { meta: current, cleared: false };
        }

        const nextMeta: ZCodeTaskMeta = {
          ...current,
          unreadAt: undefined,
        };
        // 手机已读请求可能晚于新的终态未读到达。比较和写入必须持有同一
        // SQLite 写事务，否则旧点击会把随后产生的 unreadAt 无条件清掉。
        const persistedMeta = this.writeRecord({
          meta: nextMeta,
          pinned: row.pinned === 1,
          archived: row.archived === 1,
          deleted: false,
          titleOverridden: row.title_overridden === 1,
          writeUnreadAt: true,
        });
        database.exec("COMMIT");
        return { meta: persistedMeta, cleared: true };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, async () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // 确认框可能停留期间被另一端恢复；归档检查必须与 tombstone 写入同事务，
        // 不能先读后删。已删除/不存在也跳过，避免重试从 CLI seed 后复活。
        if (!row || row.deleted === 1 || row.archived !== 1) {
          database.exec("COMMIT");
          return null;
        }
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: row.pinned === 1,
          archived: true,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        database.exec("COMMIT");
        // 删除标记与分组引用拆库后不再同事务；tombstone 保留，清理失败由启动收敛自愈。
        await this.deleteTaskGroupingReferencesSafe(row.workspace_key, row.task_id);
        return meta;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params, async () => {
      const database = this.getDatabase();
      const deleting = params.patch.deleted === true;
      const requestedUnreadAt = params.patch.unreadAt;
      const allocatingUnreadAt = typeof requestedUnreadAt === "number";
      const mutatingUnreadAt = "unreadAt" in params.patch;
      const transactional = deleting || mutatingUnreadAt;
      if (transactional) {
        database.exec("BEGIN IMMEDIATE");
      }
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1) {
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        }
        const current = rowToMeta(row);
        // 毫秒时间戳可能让同一 task 的两个逻辑未读得到相同版本，
        // 且清除 unreadAt 后只看当前值会再次复用旧版本。必须在 SQLite 写锁内
        // 基于不会随清除重置的持久 watermark 分配严格递增 marker。
        const lastUnreadAt = Math.max(
          row.last_unread_at,
          row.unread_at ?? 0,
          current.unreadAt ?? 0,
        );
        const unreadAt = allocatingUnreadAt
          ? Math.max(requestedUnreadAt, lastUnreadAt + 1)
          : "unreadAt" in params.patch
            ? undefined
            : current.unreadAt;
        const nextMeta: ZCodeTaskMeta = {
          ...current,
          title: params.patch.title ?? current.title,
          titleOverridden: params.patch.titleOverridden ?? current.titleOverridden,
          model: params.patch.model ?? current.model,
          updatedAt: params.patch.updatedAt ?? current.updatedAt,
          unreadAt,
          status: params.patch.status ?? current.status,
          lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
          target: "target" in params.patch ? params.patch.target : current.target,
        };
        const persistedMeta = this.writeRecord({
          meta: nextMeta,
          pinned: params.patch.pinned ?? row.pinned === 1,
          archived: params.patch.archived ?? row.archived === 1,
          deleted: params.patch.deleted ?? row.deleted === 1,
          titleOverridden: params.patch.titleOverridden ?? row.title_overridden === 1,
          writeUnreadAt: mutatingUnreadAt,
        });
        if (transactional) database.exec("COMMIT");
        if (deleting) {
          // 删除标记和分组引用拆库后不再同事务；tombstone 保留，清理失败由启动收敛自愈，
          // 避免 sessions-index 内容、task 可见性与分组归属长期矛盾。
          await this.deleteTaskGroupingReferencesSafe(row.workspace_key, row.task_id);
        }
        return persistedMeta;
      } catch (error) {
        if (transactional && database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async applyAgentPatch(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: Pick<TaskIndexStatePatch, "title" | "status" | "lastError" | "target" | "updatedAt">;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const row = this.getTaskRow(params);
      if (!row || row.deleted === 1) {
        return null;
      }
      const current = rowToMeta(row);
      const canAcceptAgentTitle = row.title_overridden !== 1;
      const nextMeta: ZCodeTaskMeta = {
        ...current,
        title: canAcceptAgentTitle && params.patch.title ? params.patch.title : current.title,
        titleOverridden: row.title_overridden === 1,
        updatedAt: params.patch.updatedAt ?? current.updatedAt,
        status: params.patch.status ?? current.status,
        lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
        target: "target" in params.patch ? params.patch.target : current.target,
      };
      return this.writeRecord({
        meta: nextMeta,
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        deleted: row.deleted === 1,
        titleOverridden: row.title_overridden === 1,
      });
    });
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    // listTaskMetas 支持不传 workspacePath 查询全部任务，但 workspaceKey 只接受必填路径。
    // 先把可选入参收窄成明确的 workspace target，避免类型层把全量查询和 workspace 查询混在一起。
    const targetWorkspaceKey = params.workspacePath
      ? workspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND (@include_deleted = 1 OR deleted = 0)
          -- 按请求指定的 runtime provider 过滤；迁移来源另存于 migration_source。
          AND (@provider IS NULL OR provider = @provider)
          AND (@pinned IS NULL OR pinned = @pinned)
          AND (@archived IS NULL OR archived = @archived)
        ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
      )
      .all({
        workspace_key: targetWorkspaceKey,
        include_deleted: params.includeDeleted ? 1 : 0,
        provider: params.provider ?? null,
        pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
        archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
      }) as unknown as TaskIndexRow[];
    return rows.map(rowToMeta);
  }

  /**
   * 读取 workspace 下的删除 tombstone。
   *
   * CLI session store 会继续保留会话内容；如果列表 join 只读取 active/pinned/archived，
   * deleted task 会因“不在 archived 集合”被误判成普通 task，并在冷启动后重新出现。
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    const workspaceKeyValue = workspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const rows = this.getDatabase()
      .prepare(
        `SELECT task_id
        FROM tasks
        WHERE workspace_key = @workspace_key
          AND deleted = 1
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY task_id`,
      )
      .all({
        workspace_key: workspaceKeyValue,
        provider: params.provider ?? null,
      }) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  /**
   * 列出某条 automation 产生的所有 cron session（用于 automation 详情展开、关联查询）。
   * 走 cron_automation_id 索引列，只返回未删除的 session，按创建时间倒序。
   */
  async listSessionsByAutomation(automationId: string): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE cron_automation_id = @automation_id
          AND deleted = 0
        ORDER BY created_at DESC, task_id DESC`,
      )
      .all({ automation_id: automationId }) as unknown as TaskIndexRow[];
    return rows.map(rowToMeta);
  }

  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    if (workspaceKeys.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }

    const search = params.search?.trim();
    const normalizedSearchLike =
      search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
    const where = ["deleted = 0", `workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`];
    const args: Array<string | number> = [...workspaceKeys];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    if (params.kind === "pinned") {
      where.push("pinned = 1", "archived = 0");
    } else if (params.kind === "archived") {
      where.push("archived = 1");
    } else {
      where.push("pinned = 0", "archived = 0");
    }
    if (normalizedSearchLike) {
      // 之前只按 title 模糊匹配，没有命中聊天正文；TaskSearchDialog 长期搜不到内容。
      // 现在 title 或 searchable_text 任一命中即视为匹配，正文摘要在结果阶段构建。
      where.push("(LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?)");
    }

    if (normalizedSearchLike) {
      args.push(normalizedSearchLike, normalizedSearchLike);
    }
    const whereClause = where.join(" AND ");
    const totalRow = this.getDatabase()
      .prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${whereClause}`)
      .get(...args) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const limit = normalizeLimit(params.limit);
    const listArgs: Array<string | number> = [...args];
    if (limit !== null) {
      listArgs.push(limit);
    }
    const orderBy =
      params.sortBy === "created"
        ? "created_at DESC, updated_at DESC, task_id DESC"
        : "updated_at DESC, created_at DESC, task_id DESC";
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${whereClause}
        ORDER BY ${orderBy}${limit === null ? "" : " LIMIT ?"}`,
      )
      .all(...listArgs) as unknown as TaskIndexRow[];
    const workspacePurposeByKey = new Map(
      params.workspaceScopes.flatMap((scope) =>
        scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
      ),
    );

    return {
      items: rows.map((row) => {
        const item = rowToTaskListItem(row, search ?? null);
        const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
        return workspacePurpose ? { ...item, workspacePurpose } : item;
      }),
      total,
      hasMore: total > rows.length,
    };
  }

  /** 任务首次公开且未分组时写入顶层排序；分组落在 custom-resources.sqlite（经 TaskGroupStorePort）。 */
  async initializeGroupedTaskAtTop(params: ZCodeGroupedTaskRef): Promise<boolean> {
    await this.ensureReady();
    return this.initializeGroupedTaskAtTopSafe(params);
  }

  // ---- TaskGroupTaskReaderPort：CustomResourcesRepo 的分组校验 / join 读取面 ----

  async getTaskGroupingProjection(params: ZCodeGroupedTaskRef): Promise<TaskGroupTaskProjection | null> {
    await this.ensureReady();
    const row = this.getTaskRow(params);
    if (!row) {
      return null;
    }
    return {
      deleted: row.deleted === 1,
      archived: row.archived === 1,
      pinned: row.pinned === 1,
      provider: row.provider,
    };
  }

  async listScopedTaskKeys(workspaceKeys: string[]): Promise<Array<{ workspaceKey: string; taskId: string }>> {
    await this.ensureReady();
    if (workspaceKeys.length === 0) {
      return [];
    }
    const rows = this.getDatabase()
      .prepare(
        `SELECT workspace_key, task_id
        FROM tasks
        WHERE workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`,
      )
      .all(...workspaceKeys) as Array<{ workspace_key: string; task_id: string }>;
    return rows.map((row) => ({ workspaceKey: row.workspace_key, taskId: row.task_id }));
  }

  async listScopedActiveTasks(params: {
    workspaceKeys: string[];
    includeAllWorkspaces: boolean;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskListItem[]> {
    await this.ensureReady();
    const where = ["deleted = 0", "archived = 0", "pinned = 0"];
    const args: Array<string | number> = [];
    if (!params.includeAllWorkspaces) {
      if (params.workspaceKeys.length === 0) {
        return [];
      }
      where.push(`workspace_key IN (${params.workspaceKeys.map(() => "?").join(", ")})`);
      args.push(...params.workspaceKeys);
    }
    if (params.provider) {
      // grouped 和 workspace 都是 ZCode Agent 任务列表入口，共享 provider 过滤口径。
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${where.join(" AND ")}`,
      )
      .all(...args) as unknown as TaskIndexRow[];
    return rows.map((row) => rowToTaskListItem(row, null));
  }

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1) {
      return null;
    }
    return rowToMeta(row);
  }
}
