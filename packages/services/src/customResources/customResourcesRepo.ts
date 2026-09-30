/* eslint-disable max-lines -- 分组存储从 taskIndexRepo 整体平移（CRUD/结构查询/排序/bootstrap/系统分组），
   迁移稳定后再按读写职责拆分；与 taskIndexRepo 的既有豁免口径一致。 */
import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type {
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
  ZCodeTaskListItem,
  ZCodeTaskListWorkspaceScope,
} from "#src/session/zcodeTaskListTypes.js";
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

/**
 * TaskIndexRepo 与 CustomResourcesRepo 的依赖方向（见 specs/services/custom-resource-store.md）：
 * - TaskIndexRepo --TaskGroupStorePort--> 本 repo：任务生命周期钩子写分组；
 * - 本 repo --TaskGroupTaskReaderPort--> TaskIndexRepo：分组校验 / join 读任务。
 * 两个 port 都定义在本模块，实现方只依赖 port 类型，不产生模块级循环导入。
 */

/** task 可见性投影：分组排序校验只关心这四个状态，不依赖 tasks 表行结构。 */
export interface TaskGroupTaskProjection {
  deleted: boolean;
  archived: boolean;
  pinned: boolean;
  provider: string | null;
}

/** 分组校验 / join 所需的任务读取面，由 TaskIndexRepo 实现。 */
export interface TaskGroupTaskReaderPort {
  /** 读取单条 task 的分组可见性投影；缺行返回 null（视为不可见）。 */
  getTaskGroupingProjection(ref: ZCodeGroupedTaskRef): Promise<TaskGroupTaskProjection | null>;
  /** 列出 workspace keys 范围内全部 task key（含已删除），用于清理顶层排序。 */
  listScopedTaskKeys(
    workspaceKeys: string[],
  ): Promise<Array<{ workspaceKey: string; taskId: string }>>;
  /** grouped 视图 join 用：scope 内 active（未删/未归档/未置顶）task 列表。 */
  listScopedActiveTasks(params: {
    workspaceKeys: string[];
    includeAllWorkspaces: boolean;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskListItem[]>;
}

/** 任务生命周期钩子的分组写入面，由 CustomResourcesRepo 实现、TaskIndexRepo 持有。 */
export interface TaskGroupStorePort {
  /** cron session 首次获得 cronAutomationId 时归入 cron 系统分组。 */
  ensureCronGroupMembership(meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">): Promise<void>;
  /** 闲时 session 首次获得 offPeakTaskId 时归入闲时系统分组（远程 workspace 不归组）。 */
  ensureOffPeakGroupMembership(meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">): Promise<void>;
  /** 任务首次公开且未分组时插入顶层排序；返回是否真正初始化。 */
  initializeTaskAtTopIfAbsent(params: ZCodeGroupedTaskRef): Promise<boolean>;
  /** 删除单条 task 的成员关系与顶层排序引用。 */
  deleteTaskGroupingReferences(workspaceKeyValue: string, taskId: string): Promise<void>;
  /** 批量清理 task key 的分组引用（启动时按 deleted tombstone 幂等收敛）。 */
  cleanupTaskGroupingReferences(keys: ReadonlyArray<{ workspaceKey: string; taskId: string }>): Promise<void>;
}

interface TaskGroupRow {
  group_id: string;
  title: string;
  color: string;
  created_at: number;
  updated_at: number;
}

interface TaskGroupMemberRow {
  group_id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  sort_order: number | null;
  added_at: number;
  created_at: number;
  updated_at: number;
}

interface TaskGroupViewNodeOrderRow {
  node_type: "group" | "task";
  node_key: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface TaskGroupWorkspaceBootstrapRow {
  workspace_key: string;
  group_id: string | null;
}

interface WorkspaceBootstrapScope {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

const GROUPED_TASK_ORDER_STEP = 1000;
const GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY = "__zcode_internal_grouped_workspace_bootstrap_once__";
const DEFAULT_TASK_GROUP_COLOR: ZCodeTaskGroupColor = "gray";
const WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] satisfies ZCodeTaskGroupColor[];

function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  return [
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeWorkspaceBootstrapScopes(
  scopes: ZCodeTaskListWorkspaceScope[],
): WorkspaceBootstrapScope[] {
  const seen = new Set<string>();
  const result: WorkspaceBootstrapScope[] = [];
  for (const scope of scopes) {
    if (scope.workspacePurpose === "conversation") {
      // 对话 backing workspace 只是 cwd，不是项目；迁移期不能为它生成同名项目分组。
      continue;
    }
    const key = workspaceKey(scope);
    if (!key.trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      workspaceKey: key,
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
    });
  }
  return result;
}

function isTaskGroupColor(value: string): value is ZCodeTaskGroupColor {
  return (
    value === "gray" ||
    value === "red" ||
    value === "orange" ||
    value === "yellow" ||
    value === "green" ||
    value === "blue" ||
    value === "purple"
  );
}

function rowToTaskGroup(row: TaskGroupRow): ZCodeTaskGroup {
  return {
    id: row.group_id,
    title: row.title,
    color: isTaskGroupColor(row.color) ? row.color : DEFAULT_TASK_GROUP_COLOR,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workspaceGroupId(targetWorkspaceKey: string): string {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest("hex");
  return `workspace-group-${hash.slice(0, 24)}`;
}

function workspaceGroupTitle(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/u, "");
  const leaf = normalized.split(/[\\/]/u).filter(Boolean).at(-1);
  return leaf?.trim() || normalized.trim() || "Workspace";
}

function workspaceGroupColor(targetWorkspaceKey: string): ZCodeTaskGroupColor {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest();
  const colorIndex = hash.readUInt8(0) % WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS.length;
  return WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS[colorIndex] ?? DEFAULT_TASK_GROUP_COLOR;
}

function taskNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  return `${workspaceKey(params)}\u0000${params.taskId}`;
}

function taskOrderNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  // task_group_view_node_orders.node_key 不能使用 "\u0000" 分隔；
  // node:sqlite 读 TEXT 时会截断 NUL 后面的 taskId，导致 grouped 视图排序写入后查询匹配不上。
  return JSON.stringify([workspaceKey(params), params.taskId]);
}

function groupedTopNodeOrderRef(node: ZCodeGroupedTaskViewNode): {
  nodeType: "group" | "task";
  nodeKey: string;
  mapKey: string;
} {
  if (node.type === "group") {
    return {
      nodeType: "group",
      nodeKey: node.group.id,
      mapKey: `group:${node.group.id}`,
    };
  }
  const nodeKey = taskOrderNodeKey(node.task);
  return {
    nodeType: "task",
    nodeKey,
    mapKey: `task:${nodeKey}`,
  };
}

function compareGroupedNodes(
  left: ZCodeGroupedTaskViewNode,
  right: ZCodeGroupedTaskViewNode,
): number {
  const leftOrder = left.sortOrder ?? 0;
  const rightOrder = right.sortOrder ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return groupedTopNodeOrderRef(left).mapKey.localeCompare(groupedTopNodeOrderRef(right).mapKey);
}

function compareCronGroupTasks(left: ZCodeTaskListItem, right: ZCodeTaskListItem): number {
  // cron 系统分组固定按创建时间倒序：最新的定时任务结果始终展示在最前面，
  // 不参与用户手动排序（sort_order），新 session 到达时天然排到组顶部。
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return taskNodeKey(right).localeCompare(taskNodeKey(left));
}

function compareGroupTasks(
  left: ZCodeTaskListItem,
  right: ZCodeTaskListItem,
  memberByTaskKey: Map<string, TaskGroupMemberRow>,
): number {
  const leftMember = memberByTaskKey.get(taskNodeKey(left));
  const rightMember = memberByTaskKey.get(taskNodeKey(right));
  const leftOrder = leftMember?.sort_order ?? 0;
  const rightOrder = rightMember?.sort_order ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return taskNodeKey(left).localeCompare(taskNodeKey(right));
}

export class CustomResourcesRepo implements TaskGroupStorePort {
  constructor(
    private readonly options: {
      startupDbPath?: string;
      busyTimeoutMs?: number;
      /** 分组校验 / join 需要读取 tasks-index 数据；由组合根注入 TaskIndexRepo 实现。 */
      taskReader?: TaskGroupTaskReaderPort;
    } = {},
  ) {}
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
      // 多窗口 Host 共用 custom-resources；写事务和首次 schema 升级应短暂等待，而不是立即 SQLITE_BUSY。
      this.db.exec(`PRAGMA busy_timeout = ${this.options.busyTimeoutMs ?? 5000}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // Worker 已完成该路径的原始准备，业务连接不再重复迁移。
    if (isCustomResourcesStoragePrepared(path, this.db)) return;
    if (!isCustomResourcesStorageMigrated(path, this.db)) runCustomResourcesMigrations(this.db);
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("custom resources sqlite 尚未初始化");
    }
    return this.db;
  }

  private requireTaskReader(): TaskGroupTaskReaderPort {
    if (!this.options.taskReader) {
      throw new Error("CustomResourcesRepo 缺少 taskReader，无法执行分组校验/join");
    }
    return this.options.taskReader;
  }

  // ---- TaskGroupStorePort：任务生命周期钩子（TaskIndexRepo 调用） ----

  /**
   * 把一条 cron session 归入固定的 cron 系统分组（见 CRON_DEFAULT_GROUP_ID）。
   * 幂等：分组行、视图排序、成员关系都用 INSERT OR IGNORE，绝不覆盖用户手动整理的结果。
   * 仅在 session 首次获得 cronAutomationId 时由 syncTaskMeta 调用一次。
   */
  async ensureCronGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  ): Promise<void> {
    await this.ensureReady();
    this.ensureSystemGroupMembership(meta, {
      groupId: CRON_DEFAULT_GROUP_ID,
      title: "cron",
      color: "blue",
    });
  }

  /**
   * 把一条闲时会话归入固定的闲时系统分组（见 OFF_PEAK_DEFAULT_GROUP_ID）。
   * 机制与 cron 完全同构；仅在首次获得 offPeakTaskId 时由 syncTaskMeta 调用。
   */
  async ensureOffPeakGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  ): Promise<void> {
    // 闲时任务暂不支持远程 workspace：远程会话即使带标记也不归入闲时系统分组。
    if (meta.workspaceIdentity && isRemoteWorkspaceIdentity(meta.workspaceIdentity)) {
      return;
    }
    await this.ensureReady();
    this.ensureSystemGroupMembership(meta, {
      groupId: OFF_PEAK_DEFAULT_GROUP_ID,
      title: "off-peak",
      color: "purple",
    });
  }

  private ensureSystemGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
    params: { groupId: string; title: string; color: string },
  ): void {
    const database = this.getDatabase();
    const now = Date.now();
    database
      .prepare(
        `INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(params.groupId, params.title, params.color, now, now);
    // 分组视图排序：不存在才插入（OR IGNORE），避免每次新建系统分组 session 都把该组顺序打乱。
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at)
        VALUES ('group', ?, ?, ?, ?)`,
      )
      .run(params.groupId, this.getNextGroupedTopSortOrder(), now, now);
    // OR IGNORE：若该 task 已有成员关系（用户已手动分组），保持不动。
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_members (
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        params.groupId,
        workspaceKey(meta),
        meta.workspacePath,
        meta.workspaceIdentity ?? null,
        meta.taskId,
        now,
        now,
        now,
      );
  }

  async initializeTaskAtTopIfAbsent(params: ZCodeGroupedTaskRef): Promise<boolean> {
    await this.ensureReady();
    const database = this.getDatabase();
    const existingMember = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?
        LIMIT 1`,
      )
      .get(workspaceKey(params), params.taskId) as { found: number } | undefined;
    const nodeKey = taskOrderNodeKey(params);
    const existingTopOrder = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_view_node_orders
        WHERE node_type = 'task' AND node_key = ?
        LIMIT 1`,
      )
      .get(nodeKey) as { found: number } | undefined;
    if (existingMember || existingTopOrder) {
      return false;
    }
    const now = Date.now();
    // session 可见与首标题缺行都可能并发触发完整 snapshot 回源。
    // 顶层顺序只能在第一次出现时初始化；重复回源若再次分配最小 sort_order，
    // 较慢完成的旧任务会越过之后创建的新任务，使最终顺序依赖异步完成时序。
    this.upsertGroupedTopOrder({
      nodeType: "task",
      nodeKey,
      sortOrder: this.getNextGroupedTopSortOrder(),
      now,
    });
    return true;
  }

  async deleteTaskGroupingReferences(workspaceKeyValue: string, taskId: string): Promise<void> {
    await this.ensureReady();
    const database = this.getDatabase();
    // 拆库后与 tasks 删除不再同事务；两条清理至少在新库内原子提交。
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `DELETE FROM task_group_members
          WHERE workspace_key = ? AND task_id = ?`,
        )
        .run(workspaceKeyValue, taskId);
      database
        .prepare(
          `DELETE FROM task_group_view_node_orders
          WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
        )
        .run(JSON.stringify([workspaceKeyValue, taskId]), workspaceKeyValue);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async cleanupTaskGroupingReferences(
    keys: ReadonlyArray<{ workspaceKey: string; taskId: string }>,
  ): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.ensureReady();
    const database = this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      // 任务删除 tombstone 可能因崩溃未清理新库成员关系；初始化时幂等收敛已落盘的脏引用。
      for (const key of keys) {
        database
          .prepare(
            `DELETE FROM task_group_members
            WHERE workspace_key = ? AND task_id = ?`,
          )
          .run(key.workspaceKey, key.taskId);
        database
          .prepare(
            `DELETE FROM task_group_view_node_orders
            WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
          )
          .run(JSON.stringify([key.workspaceKey, key.taskId]), key.workspaceKey);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- 分组 CRUD（adapter 委托） ----

  async createTaskGroup(params?: {
    title?: string;
    color?: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    const now = Date.now();
    const id = `task-group-${randomUUID()}`;
    const title = params?.title?.trim() || "New Group";
    const color = params?.color ?? DEFAULT_TASK_GROUP_COLOR;
    this.getDatabase()
      .prepare(
        `INSERT INTO task_groups (
          group_id,
          title,
          color,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, title, color, now, now);
    // 新建内容必须立即进入用户排序，并插到当前混排列表顶部；
    // 不能依赖 created_at 和已有 sort_order 混排，否则两套坐标量级不同会导致刷新后位置漂移。
    this.upsertGroupedTopOrder({
      nodeType: "group",
      nodeKey: id,
      sortOrder: this.getNextGroupedTopSortOrder(),
      now,
    });
    return {
      id,
      title,
      color,
      createdAt: now,
      updatedAt: now,
    };
  }

  async renameTaskGroup(params: { groupId: string; title: string }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    const title = params.title.trim() || "New Group";
    const now = Date.now();
    const database = this.getDatabase();
    const result = database
      .prepare(
        `UPDATE task_groups
        SET title = ?, updated_at = ?
        WHERE group_id = ?`,
      )
      .run(title, now, params.groupId);
    if (result.changes === 0) {
      throw new Error("Task group 不存在，无法重命名");
    }
    const row = database
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups
        WHERE group_id = ?`,
      )
      .get(params.groupId) as TaskGroupRow | undefined;
    if (!row) {
      throw new Error("Task group 重命名后读取失败");
    }
    return rowToTaskGroup(row);
  }

  async updateTaskGroupColor(params: {
    groupId: string;
    color: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup> {
    await this.ensureReady();
    if (!isTaskGroupColor(params.color)) {
      throw new Error("Task group 颜色无效");
    }
    const now = Date.now();
    const database = this.getDatabase();
    const result = database
      .prepare(
        `UPDATE task_groups
        SET color = ?, updated_at = ?
        WHERE group_id = ?`,
      )
      .run(params.color, now, params.groupId);
    if (result.changes === 0) {
      throw new Error("Task group 不存在，无法更新颜色");
    }
    const row = database
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups
        WHERE group_id = ?`,
      )
      .get(params.groupId) as TaskGroupRow | undefined;
    if (!row) {
      throw new Error("Task group 更新颜色后读取失败");
    }
    return rowToTaskGroup(row);
  }

  async deleteTaskGroup(params: { groupId: string }): Promise<void> {
    await this.ensureReady();
    const database = this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database
        .prepare("DELETE FROM task_groups WHERE group_id = ?")
        .run(params.groupId);
      if (result.changes === 0) {
        throw new Error("Task group 不存在，无法删除");
      }
      database
        .prepare(
          `DELETE FROM task_group_view_node_orders
          WHERE node_type = 'group' AND node_key = ?`,
        )
        .run(params.groupId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- grouped 视图查询 / 排序（adapter 委托） ----

  /**
   * grouped 原始结构读取（不 join tasks 表、无 bootstrap / normalize 写回）。
   * 任务内容改由 sessions-index 提供，客户端 join；这里只回 group / member / 顶层排序三张表。
   * 组可见性沿用 queryGroupedTaskView 口径：bootstrap workspace group 只在其 workspace 可见。
   */
  async queryGroupedTaskViewStructure(params: {
    workspaceScopes: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeGroupedTaskViewStructure> {
    await this.ensureReady();
    const visibleWorkspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
    const bootstrapRows = this.getDatabase()
      .prepare(
        `SELECT workspace_key, group_id
        FROM task_group_workspace_bootstraps
        WHERE group_id IS NOT NULL`,
      )
      .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
    const bootstrapWorkspaceKeyByGroupId = new Map(
      bootstrapRows
        .filter((row) => row.group_id)
        .map((row) => [row.group_id as string, row.workspace_key]),
    );
    const groupRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups`,
      )
      .all() as unknown as TaskGroupRow[];
    const groups = groupRows
      .filter((row) => {
        const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
        return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
      })
      .map(rowToTaskGroup);
    const memberRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        FROM task_group_members`,
      )
      .all() as unknown as TaskGroupMemberRow[];
    const members: ZCodeGroupedTaskViewStructureMember[] = memberRows.map((row) => ({
      groupId: row.group_id,
      workspaceKey: row.workspace_key,
      workspacePath: row.workspace_path,
      ...(row.workspace_identity ? { workspaceIdentity: row.workspace_identity } : {}),
      taskId: row.task_id,
      sortOrder: row.sort_order,
      addedAt: row.added_at,
    }));
    const orderRows = this.getDatabase()
      .prepare(
        `SELECT
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        FROM task_group_view_node_orders`,
      )
      .all() as unknown as TaskGroupViewNodeOrderRow[];
    const topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[] = [];
    for (const row of orderRows) {
      if (row.node_type === "group") {
        topLevelOrders.push({
          type: "group",
          groupId: row.node_key,
          sortOrder: row.sort_order,
        });
        continue;
      }
      // task node_key = JSON.stringify([workspaceKey, taskId])（NUL 分隔在 sqlite TEXT 会被截断）。
      try {
        const parsed = JSON.parse(row.node_key) as unknown;
        if (
          Array.isArray(parsed) &&
          typeof parsed[0] === "string" &&
          typeof parsed[1] === "string"
        ) {
          topLevelOrders.push({
            type: "task",
            workspaceKey: parsed[0],
            taskId: parsed[1],
            sortOrder: row.sort_order,
          });
        }
      } catch {
        // 历史脏 node_key 跳过：客户端会按 createdAt 补内存序，不致崩溃。
      }
    }
    return { groups, members, topLevelOrders };
  }

  async applyGroupedTaskViewOrder(
    params: ZCodeGroupedTaskViewOrderInput & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const taskReader = this.requireTaskReader();
    const workspaceKeys = new Set(normalizeWorkspaceKeys(params.workspaceScopes));
    const now = Date.now();
    const database = this.getDatabase();

    const groupIds = new Set(
      (
        database.prepare("SELECT group_id FROM task_groups").all() as Array<{
          group_id: string;
        }>
      ).map((row) => row.group_id),
    );
    const validateTaskRef = async (task: ZCodeGroupedTaskRef): Promise<string | null> => {
      const key = workspaceKey(task);
      if (!workspaceKeys.has(key)) {
        throw new Error("Grouped task order 包含当前 scope 外的 task");
      }
      const projection = await taskReader.getTaskGroupingProjection(task);
      if (
        !projection ||
        projection.deleted ||
        projection.archived ||
        projection.pinned
      ) {
        throw new Error("Grouped task order 包含不可见 task");
      }
      if (params.provider && projection.provider !== params.provider) {
        // grouped 保存回包之前没有 provider 边界，旧 gemini/codex/claude 排序残留会在保存后重新展示。
        // 带 provider 的 ZCode Agent 视图只接受当前 glm task；旧 provider 引用作为不可见遗留数据跳过。
        return null;
      }
      return key;
    };

    const topLevelTaskKeys = new Set<string>();
    const groupedTaskKeys = new Set<string>();
    const visibleTopLevelNodes: ZCodeGroupedTaskViewTopLevelNodeRef[] = [];
    const visibleGroups: Array<{ groupId: string; taskRefs: ZCodeGroupedTaskRef[] }> = [];
    for (const node of params.topLevelNodes) {
      if (node.type === "group") {
        if (!groupIds.has(node.groupId)) {
          throw new Error("Grouped task order 包含不存在的 group");
        }
        visibleTopLevelNodes.push(node);
        continue;
      }
      const workspaceKey = await validateTaskRef(node.task);
      if (!workspaceKey) {
        continue;
      }
      const key = `${workspaceKey}\u0000${node.task.taskId}`;
      topLevelTaskKeys.add(key);
      visibleTopLevelNodes.push(node);
    }
    for (const group of params.groups) {
      if (!groupIds.has(group.groupId)) {
        throw new Error("Grouped task order 包含不存在的 group");
      }
      const visibleTaskRefs: ZCodeGroupedTaskRef[] = [];
      for (const taskRef of group.taskRefs) {
        const workspaceKey = await validateTaskRef(taskRef);
        if (!workspaceKey) {
          continue;
        }
        const key = `${workspaceKey}\u0000${taskRef.taskId}`;
        if (groupedTaskKeys.has(key)) {
          throw new Error("Grouped task order 不能让同一个 task 进入多个 group");
        }
        groupedTaskKeys.add(key);
        visibleTaskRefs.push(taskRef);
      }
      visibleGroups.push({ groupId: group.groupId, taskRefs: visibleTaskRefs });
    }

    const scopedTaskOrderKeys =
      workspaceKeys.size === 0
        ? []
        : await taskReader.listScopedTaskKeys([...workspaceKeys]);

    database.exec("BEGIN IMMEDIATE");
    try {
      const markWorkspaceBootstrapDisabled = database.prepare(
        `INSERT INTO task_group_workspace_bootstraps (
          workspace_key,
          group_id,
          created_at,
          updated_at
        ) VALUES (?, NULL, ?, ?)
        ON CONFLICT(workspace_key) DO UPDATE SET
          updated_at = excluded.updated_at`,
      );
      // 用户已经显式保存 grouped 排序时，后续查询不能再执行 workspace 自动初始化。
      // 这里写全局 marker，避免新 workspace 出现后又触发迁移式 workspace group 初始化。
      markWorkspaceBootstrapDisabled.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      const deleteMembership = database.prepare(
        `DELETE FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?`,
      );
      const upsertMembership = database.prepare(
        `INSERT INTO task_group_members (
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          group_id = excluded.group_id,
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
      );
      for (const key of topLevelTaskKeys) {
        const [targetWorkspaceKey, taskId] = key.split("\u0000");
        if (!targetWorkspaceKey || !taskId) {
          throw new Error("Grouped task order 顶层 task key 非法");
        }
        deleteMembership.run(targetWorkspaceKey, taskId);
      }
      for (const group of visibleGroups) {
        group.taskRefs.forEach((taskRef, index) => {
          const targetWorkspaceKey = workspaceKey(taskRef);
          upsertMembership.run(
            group.groupId,
            targetWorkspaceKey,
            taskRef.workspacePath,
            taskRef.workspaceIdentity ?? null,
            taskRef.taskId,
            (index + 1) * GROUPED_TASK_ORDER_STEP,
            now,
            now,
            now,
          );
        });
      }

      // 一次提交最终排序，避免菜单/草稿/取消分组等 grouped 视图变更留下部分写入状态。
      database.prepare("DELETE FROM task_group_view_node_orders WHERE node_type = 'group'").run();
      const deleteTaskOrder = database.prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
      );
      // 只清理当前 workspace scope 里的 task 排序；否则远端/未展开 workspace 的混排位置会被本次变更误删。
      for (const { workspaceKey: targetWorkspaceKey, taskId } of scopedTaskOrderKeys) {
        deleteTaskOrder.run(JSON.stringify([targetWorkspaceKey, taskId]), targetWorkspaceKey);
      }
      const insertOrder = database.prepare(
        `INSERT INTO task_group_view_node_orders (
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      visibleTopLevelNodes.forEach((node, index) => {
        const nodeType = node.type;
        const nodeKey = node.type === "group" ? node.groupId : taskOrderNodeKey(node.task);
        insertOrder.run(nodeType, nodeKey, (index + 1) * GROUPED_TASK_ORDER_STEP, now, now);
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    return this.queryGroupedTaskView({
      workspaceScopes: params.workspaceScopes,
      provider: params.provider,
    });
  }

  // 过渡面：grouped 列表消费已切 sessions-index + queryGroupedTaskViewStructure，
  // 本方法仅剩 applyGroupedTaskViewOrder 的回包复用（UI 已不采信该回包），
  // 随 applyGroupedTaskViewOrder 返回面收敛一并收口。
  private async queryGroupedTaskView(
    params: ZCodeGroupedTaskViewQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeGroupedTaskView> {
    await this.ensureReady();
    const taskReader = this.requireTaskReader();
    const includeAllWorkspaces = params.includeAllWorkspaces === true;
    const requestedWorkspaceScopes = normalizeWorkspaceBootstrapScopes(params.workspaceScopes);
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    const activeTasks =
      !includeAllWorkspaces && workspaceKeys.length === 0
        ? []
        : await taskReader.listScopedActiveTasks({
            workspaceKeys,
            includeAllWorkspaces,
            provider: params.provider,
          });
    const workspaceScopes = includeAllWorkspaces
      ? normalizeWorkspaceBootstrapScopes(
          activeTasks.map((task) => ({
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
          })),
        )
      : requestedWorkspaceScopes;
    this.bootstrapWorkspaceGroupsForActiveTasks({
      scopes: workspaceScopes,
      activeTasks,
    });
    const bootstrapRows = this.getDatabase()
      .prepare(
        `SELECT workspace_key, group_id
        FROM task_group_workspace_bootstraps
        WHERE group_id IS NOT NULL`,
      )
      .all() as unknown as TaskGroupWorkspaceBootstrapRow[];
    const bootstrapWorkspaceKeyByGroupId = new Map(
      bootstrapRows
        .filter((row) => row.group_id)
        .map((row) => [row.group_id as string, row.workspace_key]),
    );
    const visibleWorkspaceKeys = new Set(
      includeAllWorkspaces ? activeTasks.map((task) => workspaceKey(task)) : workspaceKeys,
    );
    const groupRows = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          title,
          color,
          created_at,
          updated_at
        FROM task_groups`,
      )
      .all() as unknown as TaskGroupRow[];
    const groups = groupRows
      .filter((row) => {
        const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroupId.get(row.group_id);
        return !bootstrapWorkspaceKey || visibleWorkspaceKeys.has(bootstrapWorkspaceKey);
      })
      .map(rowToTaskGroup);
    const members = this.getDatabase()
      .prepare(
        `SELECT
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        FROM task_group_members`,
      )
      .all() as unknown as TaskGroupMemberRow[];
    const orderRows = this.getDatabase()
      .prepare(
        `SELECT
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        FROM task_group_view_node_orders`,
      )
      .all() as unknown as TaskGroupViewNodeOrderRow[];
    const orderByNodeKey = new Map(
      orderRows.map((row) => [`${row.node_type}:${row.node_key}`, row]),
    );
    const memberByTaskKey = new Map(
      members.map((member) => [`${member.workspace_key}\u0000${member.task_id}`, member]),
    );
    const membersByGroupId = new Map<string, TaskGroupMemberRow[]>();
    for (const member of members) {
      const groupMembers = membersByGroupId.get(member.group_id) ?? [];
      groupMembers.push(member);
      membersByGroupId.set(member.group_id, groupMembers);
    }

    const activeTaskByKey = new Map(
      activeTasks.map((task) => [`${workspaceKey(task)}\u0000${task.taskId}`, task]),
    );
    const groupedVisibleTaskKeys = new Set<string>();
    const nodes: ZCodeGroupedTaskViewNode[] = groups.map((group) => {
      const groupTasks = (membersByGroupId.get(group.id) ?? [])
        .map((member) => activeTaskByKey.get(`${member.workspace_key}\u0000${member.task_id}`))
        .filter((task): task is ZCodeTaskListItem => Boolean(task));
      if (group.id === CRON_DEFAULT_GROUP_ID) {
        // cron 系统分组不走用户手动排序，固定按创建时间倒序展示最新结果。
        groupTasks.sort(compareCronGroupTasks);
      } else {
        this.normalizeGroupMemberOrders(group.id, groupTasks, memberByTaskKey);
        groupTasks.sort((left, right) => compareGroupTasks(left, right, memberByTaskKey));
      }
      for (const task of groupTasks) {
        groupedVisibleTaskKeys.add(taskNodeKey(task));
      }
      const order = orderByNodeKey.get(`group:${group.id}`);
      return {
        type: "group",
        group,
        tasks: groupTasks,
        ...(order ? { sortOrder: order.sort_order } : {}),
      };
    });

    for (const task of activeTaskByKey.values()) {
      const key = taskNodeKey(task);
      if (memberByTaskKey.has(key) || groupedVisibleTaskKeys.has(key)) {
        continue;
      }
      const order = orderByNodeKey.get(`task:${taskOrderNodeKey(task)}`);
      nodes.push({
        type: "task",
        task,
        ...(order ? { sortOrder: order.sort_order } : {}),
      });
    }

    // 首次查询时把当前可见顶层节点全部补齐成用户排序，之后展示只认 sort_order。
    this.normalizeGroupedTopNodeOrders(nodes, orderByNodeKey);
    nodes.sort(compareGroupedNodes);
    return { nodes };
  }

  private bootstrapWorkspaceGroupsForActiveTasks(params: {
    scopes: WorkspaceBootstrapScope[];
    activeTasks: ZCodeTaskListItem[];
  }): void {
    if (params.scopes.length === 0 || this.hasGroupedWorkspaceBootstrapRunSync()) {
      return;
    }
    const database = this.getDatabase();
    const candidateRowsByWorkspaceKey = new Map<string, ZCodeTaskListItem[]>();
    for (const task of params.activeTasks) {
      const key = workspaceKey(task);
      const rows = candidateRowsByWorkspaceKey.get(key) ?? [];
      rows.push(task);
      candidateRowsByWorkspaceKey.set(key, rows);
    }
    const now = Date.now();
    const markBootstrapRun = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, NULL, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        updated_at = excluded.updated_at`,
    );
    if (candidateRowsByWorkspaceKey.size === 0) {
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      return;
    }
    const existingGroupOrderKeys = new Set(
      (
        database
          .prepare(
            `SELECT node_key
            FROM task_group_view_node_orders
            WHERE node_type = 'group'`,
          )
          .all() as Array<{ node_key: string }>
      ).map((row) => row.node_key),
    );
    const maxOrderRow = database
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { max_sort_order: number | null } | undefined;
    let nextGroupSortOrder = maxOrderRow?.max_sort_order ?? 0;
    const insertGroup = database.prepare(
      `INSERT OR IGNORE INTO task_groups (
        group_id,
        title,
        color,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertGroupOrder = database.prepare(
      `INSERT OR IGNORE INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES ('group', ?, ?, ?, ?)`,
    );
    const deleteExistingMember = database.prepare(
      `DELETE FROM task_group_members
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const insertMember = database.prepare(
      `INSERT INTO task_group_members (
        group_id,
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        sort_order,
        added_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_key, task_id) DO UPDATE SET
        group_id = excluded.group_id,
        workspace_path = excluded.workspace_path,
        workspace_identity = excluded.workspace_identity,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at`,
    );
    const deleteTopTaskOrder = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'task' AND node_key = ?`,
    );
    const insertBootstrap = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        group_id = excluded.group_id,
        updated_at = excluded.updated_at`,
    );
    const deleteEmptyGroups = database.prepare(
      `DELETE FROM task_groups
      WHERE group_id NOT IN (
        SELECT DISTINCT group_id
        FROM task_group_members
      )`,
    );
    const deleteDanglingGroupOrders = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'group'
        AND node_key NOT IN (
          SELECT group_id
          FROM task_groups
        )`,
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      // grouped workspace bootstrap 是迁移期的一次性初始化。记录全局 marker，
      // 避免后续新 workspace 出现时再次自动生成 workspace group。
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      for (const scope of params.scopes) {
        const rows = candidateRowsByWorkspaceKey.get(scope.workspaceKey);
        if (!rows) {
          continue;
        }
        // 初始化按没有分组功能时的 workspace 视角重建 membership，
        // 旧 group 不参与归属判断，避免历史分组把 task 留在非 workspace group 里。
        const groupedRows = rows.sort((left, right) => {
          if (right.updatedAt !== left.updatedAt) {
            return right.updatedAt - left.updatedAt;
          }
          if (right.createdAt !== left.createdAt) {
            return right.createdAt - left.createdAt;
          }
          return left.taskId.localeCompare(right.taskId);
        });
        if (groupedRows.length === 0) {
          continue;
        }
        const groupId = workspaceGroupId(scope.workspaceKey);
        const title = workspaceGroupTitle(scope.workspacePath);
        insertGroup.run(groupId, title, workspaceGroupColor(scope.workspaceKey), now, now);
        if (!existingGroupOrderKeys.has(groupId)) {
          nextGroupSortOrder += GROUPED_TASK_ORDER_STEP;
          insertGroupOrder.run(groupId, nextGroupSortOrder, now, now);
          existingGroupOrderKeys.add(groupId);
        }
        groupedRows.forEach((row, index) => {
          const rowWorkspaceKey = workspaceKey(row);
          deleteExistingMember.run(rowWorkspaceKey, row.taskId);
          insertMember.run(
            groupId,
            rowWorkspaceKey,
            row.workspacePath,
            row.workspaceIdentity ?? null,
            row.taskId,
            (index + 1) * GROUPED_TASK_ORDER_STEP,
            now,
            now,
            now,
          );
          deleteTopTaskOrder.run(
            taskOrderNodeKey({
              workspacePath: row.workspacePath,
              workspaceIdentity: row.workspaceIdentity ?? undefined,
              taskId: row.taskId,
            }),
          );
        });
        insertBootstrap.run(scope.workspaceKey, groupId, now, now);
      }
      deleteEmptyGroups.run();
      deleteDanglingGroupOrders.run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private hasGroupedWorkspaceBootstrapRunSync(): boolean {
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS found
        FROM task_group_workspace_bootstraps
        LIMIT 1`,
      )
      .get() as { found: number } | undefined;
    return Boolean(row);
  }

  private getNextGroupedTopSortOrder(): number {
    const row = this.getDatabase()
      .prepare(
        `SELECT MIN(sort_order) AS min_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { min_sort_order: number | null } | undefined;
    return (row?.min_sort_order ?? GROUPED_TASK_ORDER_STEP * 2) - GROUPED_TASK_ORDER_STEP;
  }

  private upsertGroupedTopOrder(params: {
    nodeType: "group" | "task";
    nodeKey: string;
    sortOrder: number;
    now: number;
  }): void {
    this.getDatabase()
      .prepare(
        `INSERT INTO task_group_view_node_orders (
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_type, node_key) DO UPDATE SET
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
      )
      .run(params.nodeType, params.nodeKey, params.sortOrder, params.now, params.now);
  }

  private normalizeGroupedTopNodeOrders(
    nodes: ZCodeGroupedTaskViewNode[],
    orderByNodeKey: Map<string, TaskGroupViewNodeOrderRow>,
  ): void {
    const missingNodes = nodes
      .filter((node) => !orderByNodeKey.has(groupedTopNodeOrderRef(node).mapKey))
      .sort((left, right) => {
        const leftCreated = left.type === "group" ? left.group.createdAt : left.task.createdAt;
        const rightCreated = right.type === "group" ? right.group.createdAt : right.task.createdAt;
        if (rightCreated !== leftCreated) {
          return rightCreated - leftCreated;
        }
        return groupedTopNodeOrderRef(left).mapKey.localeCompare(
          groupedTopNodeOrderRef(right).mapKey,
        );
      });
    if (missingNodes.length === 0) {
      return;
    }
    const row = this.getDatabase()
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { max_sort_order: number | null } | undefined;
    let nextSortOrder = row?.max_sort_order ?? 0;
    const now = Date.now();
    const insertOrder = this.getDatabase().prepare(
      `INSERT INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const node of missingNodes) {
        nextSortOrder += GROUPED_TASK_ORDER_STEP;
        const ref = groupedTopNodeOrderRef(node);
        insertOrder.run(ref.nodeType, ref.nodeKey, nextSortOrder, now, now);
        const rowValue: TaskGroupViewNodeOrderRow = {
          node_type: ref.nodeType,
          node_key: ref.nodeKey,
          sort_order: nextSortOrder,
          created_at: now,
          updated_at: now,
        };
        orderByNodeKey.set(ref.mapKey, rowValue);
        node.sortOrder = nextSortOrder;
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }

  private normalizeGroupMemberOrders(
    groupId: string,
    tasks: ZCodeTaskListItem[],
    memberByTaskKey: Map<string, TaskGroupMemberRow>,
  ): void {
    const missingTasks = tasks
      .filter((task) => {
        const member = memberByTaskKey.get(taskNodeKey(task));
        return Boolean(member) && member?.sort_order === null;
      })
      .sort((left, right) => {
        const leftMember = memberByTaskKey.get(taskNodeKey(left));
        const rightMember = memberByTaskKey.get(taskNodeKey(right));
        const leftAdded = leftMember?.added_at ?? left.createdAt;
        const rightAdded = rightMember?.added_at ?? right.createdAt;
        if (rightAdded !== leftAdded) {
          return rightAdded - leftAdded;
        }
        return taskNodeKey(left).localeCompare(taskNodeKey(right));
      });
    if (missingTasks.length === 0) {
      return;
    }
    const row = this.getDatabase()
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_members
        WHERE group_id = ?`,
      )
      .get(groupId) as { max_sort_order: number | null } | undefined;
    let nextSortOrder = row?.max_sort_order ?? 0;
    const now = Date.now();
    const updateMemberOrder = this.getDatabase().prepare(
      `UPDATE task_group_members
      SET sort_order = ?, updated_at = ?
      WHERE workspace_key = ? AND task_id = ?`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const task of missingTasks) {
        const memberKey = taskNodeKey(task);
        const member = memberByTaskKey.get(memberKey);
        if (!member) {
          continue;
        }
        nextSortOrder += GROUPED_TASK_ORDER_STEP;
        updateMemberOrder.run(nextSortOrder, now, member.workspace_key, member.task_id);
        member.sort_order = nextSortOrder;
        member.updated_at = now;
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }
}
