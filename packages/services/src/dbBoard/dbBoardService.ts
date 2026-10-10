/**
 * 数据库看板服务实现（node-only）。
 *
 * 契约见 specs/services/db-board.md。要点：
 * - pg 连接池唯一所有者；配置变更时整池重建并清空元数据缓存。
 * - insert/update 与审计日志同事务；回退按行严格逆序 + 乐观校验 + 补偿日志。
 * - DELETE 仅存在于回退 insert 日志的事务内（本文件外无任何删行入口）。
 * - 探索看板生成走注入的 generateText（node.ts 包装 zcodeAgentService.generateWorkspaceText），
 *   模型取注入的 readCurrentModel（providerRuntime.modelSelection）。
 */
/* eslint-disable max-lines -- 单一连接池所有者 + 同事务审计/回退语义要求增改查/看板/持久化同文件内聚，
   拆分会迫使事务与连接池状态跨模块共享；与 customResourcesRepo/node.ts 的豁免口径一致。 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import pgDefault from "pg";
import type { ZCodeWorkspaceGenerateTextParams } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { DbBoardKnowledge } from "../dbBoardKnowledge/dbBoardKnowledge.js";
import {
  DB_BOARD_TABLE_SELECTION_QUERY_SOURCE,
  buildKnowledgeCardsText,
  buildTableSelectionPrompt,
  parseTableSelection,
} from "../dbBoardKnowledge/dbBoardKnowledgePrompt.js";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";
import { atomicWriteJson } from "../fs/atomicFileUtils.js";
import type {
  DbBoardColumnMeta,
  DbBoardConnectionConfig,
  DbBoardConnectionEntry,
  DbBoardConnectionSnapshot,
  DbBoardDashboardSpec,
  DbBoardDashboardSummary,
  DbBoardExplainQueryParams,
  DbBoardGenerateDashboardParams,
  DbBoardGenerationResult,
  DbBoardInsertRowParams,
  DbBoardListOpLogsParams,
  DbBoardOpLogEntry,
  DbBoardOpLogResult,
  DbBoardQueryResult,
  DbBoardQueryRowsParams,
  DbBoardRollbackParams,
  DbBoardRollbackResult,
  DbBoardSqlResult,
  DbBoardTableMeta,
  DbBoardBindingsInfo,
  DbBoardSetBindingParams,
  DbBoardTestConnectionResult,
  DbBoardUpdateRowParams,
  DbBoardUsageSummaryParams,
  DbBoardWriteResult,
  IDbBoardService,
} from "./dbBoard.js";
import {
  DB_BOARD_DASHBOARD_QUERY_SOURCE,
  DB_BOARD_EXPLAIN_QUERY_SOURCE,
  buildDashboardGenerationPrompt,
  buildExplainQueryPrompt,
  draftSqlValidation,
  finalizeDashboardSpec,
  parseDashboardDraft,
  type DbBoardPromptTable,
} from "./dbBoardGeneration.js";
import {
  DB_BOARD_DASHBOARD_ROW_LIMIT,
  DB_BOARD_DEFAULT_PAGE_SIZE,
  DB_BOARD_MAX_PAGE_SIZE,
  DB_BOARD_STATEMENT_TIMEOUT_MS,
  assertColumnsKnown,
  buildDeleteByPkSql,
  buildInsertReturningSql,
  buildPkObject,
  buildQueryRowsSql,
  buildSelectByPkSql,
  buildUpdateByPkReturningSql,
  containsBinaryMarker,
  getColumnMeta,
  isReadOnlyColumn,
  isValidIdentifier,
  normalizeRowForWire,
  normalizeRowValueForWire,
  quoteIdentifier,
  quoteQualifiedName,
  resolveColumnFamily,
  wrapReadOnlySelect,
} from "./dbBoardSql.js";
import { DbBoardDashboardStore } from "./dbBoardDashboardStore.js";
import {
  buildDbBoardUsageSummary,
  type DbBoardUsageSummary,
} from "./dbBoardUsageSummary.js";
import {
  normalizeWorkspaceKey,
  parseBindings,
  resolveWorkspaceAccess,
  workspaceBindingKey,
  type DbBoardBindingsMap,
} from "./dbBoardBindings.js";

export const DB_BOARD_PASSWORD_CREDENTIAL_KEY = "db-board:password";
const USAGE_SUMMARY_FILE_NAME = "db-board-usage.json";
/** 多连接模式：每个连接一份密码（key = db-board:password:<id>）。 */
function connectionCredentialKey(id: string): string {
  return `${DB_BOARD_PASSWORD_CREDENTIAL_KEY}:${id}`;
}
const AUDIT_TABLE_NAME = "zcode_db_board_op_log";
const CONFIG_FILE_NAME = "db-board.json";
const METADATA_CACHE_TTL_MS = 30_000;

/** Kingbase/PG 系统 schema 排除清单（另加 pg_% / sys_% 前缀过滤）。 */
const EXCLUDED_SCHEMAS = [
  "pg_catalog",
  "information_schema",
  "sys_catalog",
  "sys",
  "sysaudit",
  "sys_hm",
  "sysmac",
  "dbms_xplan",
  "anon",
];

const AUDIT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE_NAME} (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  operator text NOT NULL,
  op_type text NOT NULL CHECK (op_type IN ('insert','update')),
  schema_name text NOT NULL,
  table_name text NOT NULL,
  pk_json text NOT NULL,
  before_json text,
  after_json text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','rolled_back')),
  rolled_back_at timestamptz,
  rollback_of bigint REFERENCES ${AUDIT_TABLE_NAME}(id)
)`;

/**
 * 时间类型保持原始文本：node-pg 默认把 timestamp without time zone 按本地时区解析成
 * Date，ISO 化回写时会偏移时区，破坏回退的精确恢复（实测 Kingbase V8R3 冒烟发现）。
 * 原样保留字符串后，快照值回写与库内字面量完全一致。
 */
const RAW_TEXT_PARSERS_OIDS = [1082, 1114, 1184, 1266] as const;

function createDbBoardPgTypes(): pg.CustomTypesConfig {
  const rawTextParser = (value: string) => value;
  return {
    getTypeParser(oid: number, format?: "text" | "binary") {
      if ((RAW_TEXT_PARSERS_OIDS as readonly number[]).includes(oid)) {
        return rawTextParser;
      }
      return pgDefault.types.getTypeParser(oid, format ?? "text");
    },
  };
}

export interface DbBoardServiceOptions {
  credentialService: ICredentialService;
  readCurrentModel(): Promise<ZCodeWorkspaceGenerateTextParams["selection"] | null>;
  generateText(params: {
    prompt: string;
    querySource: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    /**
     * 输出预算（token）。agent 侧对非 git 提交类 generateText 要求显式 maxOutputTokens，
     * 缺省会被模型选项校验直接拒绝（"outside the model option range"）。
     */
    maxOutputTokens?: number;
    /** 放宽 agent 侧 60s 默认超时（大 prompt + 4096 token 输出常超）。 */
    timeoutMs?: number;
  }): Promise<{ text: string }>;
  logger?: ServiceLogger;
  /** 测试注入：配置文件路径。 */
  configFilePath?: string;
  /** 测试注入：看板存储。 */
  dashboardStore?: DbBoardDashboardStore;
  now?: () => string;
  /**
   * 项目知识库读取端口（node.ts 懒装配到 dbBoardKnowledgeService）。
   * 存在且非空时看板生成走两步化（选表 → 注入知识卡片）；失败自动回退。
   */
  loadKnowledge?: () => Promise<DbBoardKnowledge | null>;
}

/** 看板 JSON（含 SQL）生成的输出预算；对齐 agent 辅助调用的 5000 上限惯例并留余量。 */
const DASHBOARD_MAX_OUTPUT_TOKENS = 4096;
/** 预算超出小上限模型时的降档重试值（仍足够容纳标题 + 若干图表 SQL）。 */
const FALLBACK_MAX_OUTPUT_TOKENS = 1024;
/** 查询解释是短文本。 */
const EXPLAIN_MAX_OUTPUT_TOKENS = 1024;
const MAX_OUTPUT_TOKENS_RANGE_ERROR = "maxOutputTokens is outside the model option range";

interface CatalogCache {
  tables: Map<string, { schema: string; name: string; columns: DbBoardColumnMeta[] }>;
  fetchedAt: number;
}

class DbBoardError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "not-connected"
      | "model-unavailable"
      | "invalid-output"
      | "conflict"
      | "request-failed"
      | "workspace-not-bound",
  ) {
    super(message);
    this.name = "DbBoardError";
  }
}

export function createDbBoardService(options: DbBoardServiceOptions): IDbBoardService {
  const logger = options.logger ?? createServiceLogger("dbBoard");
  const store = options.dashboardStore ?? new DbBoardDashboardStore();
  const now = options.now ?? (() => new Date().toISOString());
  const configFilePath = options.configFilePath ?? join(getAppConfigDir(), CONFIG_FILE_NAME);
  // 使用情况汇总按连接 id 持久化（重排数据浏览表列表依赖它，不能随进程重启丢失）。
  const usageFilePath = join(getAppConfigDir(), USAGE_SUMMARY_FILE_NAME);

  let connections: DbBoardConnectionEntry[] = [];
  let activeConnectionId: string | null = null;
  /** 工作区绑定（v3）：非空即严格模式——只有绑定了连接的工作区可用看板/助手。 */
  let bindings: DbBoardBindingsMap = {};
  let configLoaded = false;
  /** 连接 id → 已解析密码（进程内缓存）。 */
  const passwordCache = new Map<string, string>();
  let pool: pg.Pool | null = null;
  let poolCreatedUnder: string | null = null;
  let auditTableReady = false;
  let lastError: string | undefined;
  let connectedAt: string | undefined;
  let catalog: CatalogCache | null = null;
  /** 表清单缓存（连接切换/保存配置时失效）。 */
  let tablesListCache: DbBoardTableMeta[] | null = null;
  /** 使用情况汇总缓存（逐表计数昂贵，显式 compute/force；与表清单缓存同口径失效）。 */
  let usageSummaryCache: DbBoardUsageSummary | null = null;
  /** Kingbase all_*_comments 注释视图是否可用（探测一次；false 后跳过）。 */
  let dbCommentsSupported: boolean | null = null;
  /** 表名（小写）→ 表注释；注释视图不可用时为空 Map。 */
  let tableCommentsByName = new Map<string, string>();

  // --------------------------------------------------------------------------
  // 配置与连接（多连接：v2 {version, connections, activeConnectionId}；旧单份格式自动迁移）
  // --------------------------------------------------------------------------

  function activeConnection(): DbBoardConnectionEntry | null {
    return connections.find((entry) => entry.id === activeConnectionId) ?? null;
  }

  async function loadConfigFile(): Promise<void> {
    if (configLoaded) return;
    configLoaded = true;
    try {
      const raw = await readFile(configFilePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(parsed.connections)) {
        connections = parsed.connections.filter(
          (entry): entry is DbBoardConnectionEntry =>
            Boolean(entry) &&
            typeof (entry as DbBoardConnectionEntry).id === "string" &&
            typeof (entry as DbBoardConnectionEntry).host === "string" &&
            typeof (entry as DbBoardConnectionEntry).database === "string" &&
            typeof (entry as DbBoardConnectionEntry).username === "string" &&
            typeof (entry as DbBoardConnectionEntry).port === "number",
        );
        if (typeof parsed.activeConnectionId === "string") {
          activeConnectionId = parsed.activeConnectionId;
        }
        bindings = parseBindings(parsed.bindings);
      } else if (
        typeof parsed.host === "string" &&
        typeof parsed.database === "string" &&
        typeof parsed.username === "string" &&
        typeof parsed.port === "number"
      ) {
        // 旧单连接格式迁移为 id="default" 的连接（密码沿用旧凭据 key）
        connections = [
          {
            id: "default",
            host: parsed.host,
            port: parsed.port,
            database: parsed.database,
            username: parsed.username,
          },
        ];
        activeConnectionId = "default";
      }
      if (!activeConnectionId && connections.length > 0) {
        activeConnectionId = connections[0]!.id;
      }
    } catch {
      // 无配置文件视为未配置；损坏文件也按未配置处理。
    }
  }

  async function persistConfigFile(): Promise<void> {
    await atomicWriteJson(configFilePath, {
      version: 3,
      connections,
      ...(activeConnectionId ? { activeConnectionId } : {}),
      // bindings 非空即严格模式；为空保持 legacy（旧客户端读到多余键按未知字段忽略）。
      ...(Object.keys(bindings).length > 0 ? { bindings } : {}),
    });
  }

  async function loadPersistedUsageSummary(connectionId: string): Promise<DbBoardUsageSummary | null> {
    try {
      const parsed = JSON.parse(await readFile(usageFilePath, "utf-8")) as Record<string, unknown>;
      const entry = parsed[connectionId];
      if (
        !entry ||
        typeof entry !== "object" ||
        !Array.isArray((entry as DbBoardUsageSummary).frequentTables) ||
        typeof (entry as DbBoardUsageSummary).rowCounts !== "object"
      ) {
        return null;
      }
      return entry as DbBoardUsageSummary;
    } catch {
      return null;
    }
  }

  async function persistUsageSummary(connectionId: string, summary: DbBoardUsageSummary): Promise<void> {
    try {
      let map: Record<string, DbBoardUsageSummary> = {};
      try {
        map = JSON.parse(await readFile(usageFilePath, "utf-8")) as Record<string, DbBoardUsageSummary>;
      } catch {
        // 文件不存在/损坏时重建（其他连接的缓存可由重新生成恢复）。
      }
      map[connectionId] = summary;
      await atomicWriteJson(usageFilePath, map);
    } catch (error) {
      logger.warn(undefined, "数据库看板使用情况汇总持久化失败（不影响本次结果）", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function resolvePassword(id: string): Promise<string | null> {
    const cached = passwordCache.get(id);
    if (cached !== undefined) return cached;
    let password: string | null = null;
    try {
      password = await options.credentialService.load(connectionCredentialKey(id));
      if (!password && id === "default") {
        // 旧版单连接密码迁移
        password = await options.credentialService.load(DB_BOARD_PASSWORD_CREDENTIAL_KEY);
      }
    } catch {
      password = null;
    }
    passwordCache.set(id, password ?? "");
    return password;
  }

  function requireConnectionConfig(): DbBoardConnectionEntry {
    const active = activeConnection();
    if (!active) {
      throw new DbBoardError(
        "尚未配置数据库连接，请先在看板中保存连接配置。",
        "not-connected",
      );
    }
    return active;
  }

  function poolKeyOf(entry: DbBoardConnectionEntry, password: string | null): string {
    return JSON.stringify({ ...entry, hasPassword: Boolean(password) });
  }

  async function ensurePool(): Promise<pg.Pool> {
    // 面板挂载时 getConnectionState（含 loadConfigFile）与 queryRows/listOpLogs 并发，
    // 后者先到会把"配置尚未加载"误报为"尚未配置连接"——这里先等配置加载完成再判断。
    await loadConfigFile();
    const currentConfig = requireConnectionConfig();
    const password = await resolvePassword(currentConfig.id);
    if (!password) {
      throw new DbBoardError("缺少数据库密码，请在看板连接配置中填写。", "not-connected");
    }
    const poolKey = poolKeyOf(currentConfig, password);
    if (pool && poolCreatedUnder === poolKey) {
      return pool;
    }
    await closePool();
    const nextPool = new pgDefault.Pool({
      host: currentConfig.host,
      port: currentConfig.port,
      database: currentConfig.database,
      user: currentConfig.username,
      password,
      // Kingbase8 对 SSLRequest 回答 N（实测），必须显式关闭 SSL。
      ssl: false,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      types: createDbBoardPgTypes(),
    });
    pool = nextPool;
    poolCreatedUnder = poolKey;
    auditTableReady = false;
    catalog = null;
    try {
      await nextPool.query("SELECT 1");
      connectedAt = now();
      lastError = undefined;
      logger.info(undefined, "数据库看板连接已建立", {
        connectionId: currentConfig.id,
        host: currentConfig.host,
        port: currentConfig.port,
        database: currentConfig.database,
      });
    } catch (error) {
      lastError = normalizeDbError(error);
      await closePool();
      throw new DbBoardError(`数据库连接失败：${lastError}`, "not-connected");
    }
    return nextPool;
  }

  async function closePool(): Promise<void> {
    const closing = pool;
    pool = null;
    poolCreatedUnder = null;
    auditTableReady = false;
    connectedAt = undefined;
    tablesListCache = null;
    usageSummaryCache = null;
    if (closing) {
      await closing.end().catch(() => {
        // best-effort：连接池关闭失败不阻塞重建
      });
    }
  }

  /** 数据面服务端校验：严格模式下未绑定工作区拒绝触库；无 key 调用（脚本/内部/MCP 工具）不门控。 */
  async function assertWorkspaceAllowed(workspaceKey: string | undefined): Promise<void> {
    const key = normalizeWorkspaceKey(workspaceKey);
    if (!key) return;
    await loadConfigFile();
    const resolution = resolveWorkspaceAccess({ bindings, workspaceKey: key, activeConnectionId });
    if (resolution.access === "blocked") {
      throw new DbBoardError("当前项目未绑定数据库连接，禁止访问数据库。", "workspace-not-bound");
    }
  }

  /** 表清单进程内缓存：面板每次打开/切 tab 都拉全量表清单会放大 DB 压力，
   * 这里缓存到连接切换为止；UI「刷新」按钮显式传 force 回源。 */
  async function collectTables(force = false): Promise<DbBoardTableMeta[]> {
    if (!force && tablesListCache) {
      return tablesListCache.map((entry) => ({ ...entry }));
    }
    const currentCatalog = await loadCatalog(force);
    const tables: DbBoardTableMeta[] = [];
    for (const entry of currentCatalog.tables.values()) {
      const comment = tableCommentsByName.get(entry.name.toLowerCase());
      tables.push({
        schema: entry.schema,
        name: entry.name,
        hasPrimaryKey: pkColumnsOf(entry).length > 0,
        columnCount: entry.columns.length,
        queryOnly: !isWritableTable(entry),
        ...(comment ? { comment } : {}),
      });
    }
    tables.sort((a, b) => tableKey(a.schema, a.name).localeCompare(tableKey(b.schema, b.name)));
    tablesListCache = tables;
    return tables.map((entry) => ({ ...entry }));
  }

  async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const currentPool = await ensurePool();
    const client = await currentPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${DB_BOARD_STATEMENT_TIMEOUT_MS}`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // 连接已坏时 ROLLBACK 也可能失败，交还连接由池处理
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async function ensureAuditTable(client: pg.PoolClient): Promise<void> {
    if (auditTableReady) return;
    await client.query(AUDIT_TABLE_DDL);
    auditTableReady = true;
  }

  // --------------------------------------------------------------------------
  // 元数据
  // --------------------------------------------------------------------------

  async function loadCatalog(force = false): Promise<CatalogCache> {
    const currentPool = await ensurePool();
    if (!force && catalog && Date.now() - catalog.fetchedAt < METADATA_CACHE_TTL_MS) {
      return catalog;
    }
    const columnsResult = await currentPool.query(
      `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.udt_name,
              c.is_nullable, c.column_default, c.character_maximum_length
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema <> ALL($1)
         AND c.table_schema NOT LIKE 'pg\\_%'
         AND c.table_schema NOT LIKE 'sys\\_%'
         AND c.table_name <> $2
       ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
      [EXCLUDED_SCHEMAS, AUDIT_TABLE_NAME],
    );
    // Kingbase V8R3 没有 pg_catalog.pg_index（实测 42P01），主键统一走 information_schema。
    const pkResult = await currentPool.query(
      `SELECT tc.table_schema AS schema_name, tc.table_name AS table_name, kcu.column_name AS column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema <> ALL($1)
         AND tc.table_schema NOT LIKE 'pg\\_%'
         AND tc.table_schema NOT LIKE 'sys\\_%'
       ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
      [EXCLUDED_SCHEMAS],
    );
    const pkByTable = new Map<string, Set<string>>();
    for (const row of pkResult.rows as Array<{
      schema_name: string;
      table_name: string;
      column_name: string;
    }>) {
      const key = `${row.schema_name}.${row.table_name}`;
      let set = pkByTable.get(key);
      if (!set) {
        set = new Set();
        pkByTable.set(key, set);
      }
      set.add(row.column_name);
    }
    const tables = new Map<string, { schema: string; name: string; columns: DbBoardColumnMeta[] }>();
    for (const row of columnsResult.rows as Array<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
    }>) {
      const key = `${row.table_schema}.${row.table_name}`;
      let entry = tables.get(key);
      if (!entry) {
        entry = { schema: row.table_schema, name: row.table_name, columns: [] };
        tables.set(key, entry);
      }
      const pkSet = pkByTable.get(key);
      entry.columns.push({
        name: row.column_name,
        dataType: row.data_type,
        family: resolveColumnFamily(row.data_type, row.udt_name),
        nullable: row.is_nullable === "YES",
        isPrimaryKey: pkSet?.has(row.column_name) ?? false,
        hasDefault: row.column_default !== null,
        maxLength: row.character_maximum_length,
      });
    }
    await mergeDbComments(currentPool, tables);
    catalog = { tables, fetchedAt: Date.now() };
    return catalog;
  }

  /**
   * 合并 Kingbase Oracle 兼容注释视图（all_tab_comments / all_col_comments，实测 V8R3 可用）。
   * 视图缺失（非 Kingbase 或未来版本变动）时置 false 并跳过，注释字段留空。
   */
  async function mergeDbComments(
    currentPool: pg.Pool,
    tables: Map<string, { schema: string; name: string; columns: DbBoardColumnMeta[] }>,
  ): Promise<void> {
    if (dbCommentsSupported === false) {
      return;
    }
    try {
      const tableComments = await currentPool.query(
        `SELECT table_name, comments FROM all_tab_comments WHERE comments IS NOT NULL`,
      );
      const tableCommentByName = new Map<string, string>();
      for (const row of tableComments.rows as Array<{ table_name: string; comments: string }>) {
        tableCommentByName.set(row.table_name.toLowerCase(), row.comments);
      }
      const columnComments = await currentPool.query(
        `SELECT table_name, column_name, comments FROM all_col_comments WHERE comments IS NOT NULL`,
      );
      const columnCommentsByTable = new Map<string, Map<string, string>>();
      for (const row of columnComments.rows as Array<{
        table_name: string;
        column_name: string;
        comments: string;
      }>) {
        const key = row.table_name.toLowerCase();
        let columnMap = columnCommentsByTable.get(key);
        if (!columnMap) {
          columnMap = new Map();
          columnCommentsByTable.set(key, columnMap);
        }
        columnMap.set(row.column_name.toLowerCase(), row.comments);
      }
      for (const entry of tables.values()) {
        const lowerName = entry.name.toLowerCase();
        const columnMap = columnCommentsByTable.get(lowerName);
        if (columnMap) {
          for (const column of entry.columns) {
            const comment = columnMap.get(column.name.toLowerCase());
            if (comment) {
              column.comment = comment;
            }
          }
        }
      }
      // 表注释单独存放（listTables 输出时合并）
      tableCommentsByName = tableCommentByName;
      dbCommentsSupported = true;
    } catch {
      dbCommentsSupported = false;
      tableCommentsByName = new Map();
    }
  }

  function tableKey(schema: string, table: string): string {
    return `${schema}.${table}`;
  }

  function requireTableEntry(
    currentCatalog: CatalogCache,
    schema: string,
    table: string,
  ): { schema: string; name: string; columns: DbBoardColumnMeta[] } {
    if (!isValidIdentifier(schema) || !isValidIdentifier(table)) {
      throw new DbBoardError("非法的表标识符。", "request-failed");
    }
    const entry = currentCatalog.tables.get(tableKey(schema, table));
    if (!entry) {
      throw new DbBoardError(`表不存在或不可访问: ${schema}.${table}`, "request-failed");
    }
    return entry;
  }

  function pkColumnsOf(entry: { columns: DbBoardColumnMeta[] }): DbBoardColumnMeta[] {
    return entry.columns.filter((column) => column.isPrimaryKey);
  }

  function isWritableTable(entry: { columns: DbBoardColumnMeta[] }): boolean {
    const pks = pkColumnsOf(entry);
    return pks.length > 0 && !pks.some(isReadOnlyColumn);
  }

  // --------------------------------------------------------------------------
  // 审计日志写入
  // --------------------------------------------------------------------------

  async function insertOpLog(
    client: pg.PoolClient,
    input: {
      operator: string;
      opType: "insert" | "update";
      schemaName: string;
      tableName: string;
      pkJson: string;
      beforeJson: string | null;
      afterJson: string;
      rollbackOf?: number;
    },
  ): Promise<number> {
    const result = await client.query(
      `INSERT INTO ${AUDIT_TABLE_NAME}
        (operator, op_type, schema_name, table_name, pk_json, before_json, after_json, rollback_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.operator,
        input.opType,
        input.schemaName,
        input.tableName,
        input.pkJson,
        input.beforeJson,
        input.afterJson,
        input.rollbackOf ?? null,
      ],
    );
    return Number((result.rows[0] as { id: string | number }).id);
  }

  // --------------------------------------------------------------------------
  // 服务实现
  // --------------------------------------------------------------------------

  const service: IDbBoardService = {
    async getConnectionState(workspaceKey): Promise<DbBoardConnectionSnapshot> {
      await loadConfigFile();
      // 严格模式下：已绑定工作区把激活连接拉齐到绑定连接（幂等；面板打开与周期对账都会走到这里，
      // 多窗口并发时后打开者生效——轻量版的既定取舍）；未绑定工作区只返回 blocked 结论，不动连接。
      const resolution = resolveWorkspaceAccess({
        bindings,
        workspaceKey: normalizeWorkspaceKey(workspaceKey),
        activeConnectionId,
      });
      if (resolution.shouldActivateConnectionId) {
        const bound = connections.find((item) => item.id === resolution.shouldActivateConnectionId);
        if (bound) {
          activeConnectionId = bound.id;
          await persistConfigFile();
          await closePool();
        }
      }
      const accessFields =
        resolution.access === "legacy"
          ? {}
          : {
              workspaceAccess: resolution.access,
              ...(resolution.boundConnectionId ? { boundConnectionId: resolution.boundConnectionId } : {}),
            };
      const active = activeConnection();
      if (!active) {
        return { state: "disconnected", config: null, ...accessFields };
      }
      // 连接池懒建立本是为省资源，但保存配置后状态条会长期停在"未连接"，看起来像配置
      // 没生效。这里改为：有激活连接时主动探测（ensurePool 幂等，配置已就绪时直接复用），
      // 让保存/切换/打开面板/重新检测都立即反映真实连接状态（失败则带出错误信息）。
      let currentPool: pg.Pool;
      try {
        currentPool = await ensurePool();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return {
          state: "error",
          config: active,
          activeConnectionId: active.id,
          error: lastError,
          ...accessFields,
        };
      }
      try {
        await currentPool.query("SELECT 1");
        return {
          state: "connected",
          config: active,
          activeConnectionId: active.id,
          connectedAt,
          ...accessFields,
        };
      } catch (error) {
        lastError = normalizeDbError(error);
        return {
          state: "error",
          config: active,
          activeConnectionId: active.id,
          error: lastError,
          ...accessFields,
        };
      }
    },

    async getBindings(): Promise<DbBoardBindingsInfo> {
      await loadConfigFile();
      return {
        mode: Object.keys(bindings).length > 0 ? "strict" : "legacy",
        bindings: { ...bindings },
      };
    },

    async setBinding(params: DbBoardSetBindingParams): Promise<void> {
      await loadConfigFile();
      const workspaceKey = normalizeWorkspaceKey(params.workspaceKey);
      if (!workspaceKey) {
        throw new DbBoardError("workspaceKey 不能为空。", "request-failed");
      }
      const bindingKey = workspaceBindingKey(workspaceKey);
      // 解绑按归一化匹配删除，兼容历史原样存储的键（含斜杠/大小写形态差异）。
      for (const storedKey of Object.keys(bindings)) {
        if (workspaceBindingKey(storedKey) === bindingKey) {
          delete bindings[storedKey];
        }
      }
      if (params.connectionId === null) {
        await persistConfigFile();
        logger.info(undefined, "数据库看板工作区已解绑", { workspaceKey: bindingKey });
        return;
      }
      const target = connections.find((item) => item.id === params.connectionId);
      if (!target) {
        throw new DbBoardError(`连接 ${params.connectionId} 不存在，无法绑定。`, "request-failed");
      }
      bindings[bindingKey] = target.id;
      // 绑定即激活：本工作区立即用上该连接（全局单激活，轻量版语义）。
      if (activeConnectionId !== target.id) {
        activeConnectionId = target.id;
        await closePool();
      }
      await persistConfigFile();
      logger.info(undefined, "数据库看板工作区已绑定连接", { workspaceKey, connectionId: target.id });
    },

    async saveConnection(entry, password): Promise<void> {
      validateConnectionConfig(entry);
      if (!entry.id?.trim()) {
        throw new DbBoardError("连接 id 不能为空。", "request-failed");
      }
      await loadConfigFile();
      const id = entry.id.trim();
      const next: DbBoardConnectionEntry = {
        id,
        host: entry.host,
        port: entry.port,
        database: entry.database,
        username: entry.username,
        ...(entry.name?.trim() ? { name: entry.name.trim() } : {}),
        ...(entry.env?.trim() ? { env: entry.env.trim() } : {}),
      };
      connections = [...connections.filter((item) => item.id !== id), next];
      activeConnectionId = id;
      await persistConfigFile();
      if (typeof password === "string" && password.length > 0) {
        await options.credentialService.save(connectionCredentialKey(id), password);
        passwordCache.set(id, password);
      }
      await closePool();
      logger.info(undefined, "数据库看板连接配置已保存", {
        connectionId: id,
        host: next.host,
        port: next.port,
        database: next.database,
      });
    },

    async deleteConnection(id): Promise<void> {
      await loadConfigFile();
      const exists = connections.some((item) => item.id === id);
      if (!exists) {
        return;
      }
      connections = connections.filter((item) => item.id !== id);
      if (activeConnectionId === id) {
        activeConnectionId = connections[0]?.id ?? null;
        await closePool();
      }
      await persistConfigFile();
      await options.credentialService.delete(connectionCredentialKey(id)).catch(() => {
        // 凭据删除失败不阻塞配置删除
      });
      passwordCache.delete(id);
    },

    async listConnections(): Promise<DbBoardConnectionEntry[]> {
      await loadConfigFile();
      return connections.map((entry) => ({ ...entry }));
    },

    async setActiveConnection(id): Promise<void> {
      await loadConfigFile();
      if (!connections.some((item) => item.id === id)) {
        throw new DbBoardError(`连接不存在: ${id}`, "request-failed");
      }
      if (activeConnectionId === id) {
        return;
      }
      activeConnectionId = id;
      await persistConfigFile();
      await closePool();
      logger.info(undefined, "数据库看板激活连接已切换", { connectionId: id });
    },

    async testConnection(nextConfig, password, connectionId): Promise<DbBoardTestConnectionResult> {
      validateConnectionConfig(nextConfig);
      let effectivePassword = password;
      if (!effectivePassword && connectionId) {
        effectivePassword = (await resolvePassword(connectionId)) || undefined;
      }
      if (!effectivePassword) {
        return { ok: false, error: "缺少数据库密码" };
      }
      const client = new pgDefault.Client({
        host: nextConfig.host,
        port: nextConfig.port,
        database: nextConfig.database,
        user: nextConfig.username,
        password: effectivePassword,
        ssl: false,
        connectionTimeoutMillis: 8_000,
        types: createDbBoardPgTypes(),
      });
      try {
        await client.connect();
        const version = await client.query("SELECT version()");
        const versionText = String((version.rows[0] as { version?: string }).version ?? "");
        return { ok: true, serverVersion: versionText.slice(0, 120) };
      } catch (error) {
        return { ok: false, error: normalizeDbError(error) };
      } finally {
        await client.end().catch(() => {
          // best-effort
        });
      }
    },

    async listTables(force = false, workspaceKey): Promise<DbBoardTableMeta[]> {
      await assertWorkspaceAllowed(workspaceKey);
      return collectTables(force);
    },

    async getUsageSummary(params: DbBoardUsageSummaryParams): Promise<DbBoardUsageSummary | null> {
      await assertWorkspaceAllowed(params.workspaceKey);
      // 计数昂贵（无统计快表可用，见 dbBoardUsageSummary.ts 注释）：显式 compute 才执行，
      // 打开面板只读缓存；force 重算。缓存随连接切换失效。
      if (!params.compute && !params.force && !usageSummaryCache) {
        // 进程重启后内存缓存为空：从磁盘恢复当前激活连接的汇总（数据浏览排序依赖）。
        // 先加载连接配置——此时连接清单尚未就绪，activeConnection() 会误判为空。
        await loadConfigFile();
        const active = activeConnection();
        usageSummaryCache = active ? await loadPersistedUsageSummary(active.id) : null;
      }
      if ((!params.compute || usageSummaryCache) && !params.force) {
        return usageSummaryCache
          ? {
              ...usageSummaryCache,
              frequentTables: [...usageSummaryCache.frequentTables],
              rowCounts: { ...usageSummaryCache.rowCounts },
            }
          : null;
      }
      const currentPool = await ensurePool();
      const [tables, knowledge] = await Promise.all([
        collectTables(false),
        options.loadKnowledge ? options.loadKnowledge().catch(() => null) : Promise.resolve(null),
      ]);
      // 知识表名（小写）→ schema 定位；幻影表（知识里有但库里没有）直接跳过。
      const schemaByTableLower = new Map<string, string>();
      for (const table of tables) {
        schemaByTableLower.set(table.name.toLowerCase(), table.schema);
      }
      const knowledgeTables = knowledge ? [...new Set(Object.keys(knowledge.tables))] : [];
      const targets = knowledgeTables
        .map((table) => ({ table, schema: schemaByTableLower.get(table.trim().toLowerCase()) }))
        .filter((entry): entry is { table: string; schema: string } => Boolean(entry.schema));
      const rowCountByTableLower = new Map<string, number>();
      // 有界并发逐表 count：每表独立事务 + 8s 超时；失败/超时的表记为未知（不阻塞整批）。
      const concurrency = 6;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < targets.length) {
          const target = targets[cursor++]!;
          const client = await currentPool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL statement_timeout = 8000");
            const result = await client.query(
              `SELECT count(*)::int AS n FROM ${quoteIdentifier(target.schema)}.${quoteIdentifier(target.table)}`,
            );
            const rowCount = Number((result.rows[0] as { n?: number | string }).n ?? 0);
            if (Number.isFinite(rowCount)) {
              rowCountByTableLower.set(target.table.trim().toLowerCase(), rowCount);
            }
          } catch {
            // 单表失败（超时/权限）不阻塞其余表；该表不进汇总。
          } finally {
            await client.query("ROLLBACK").catch(() => undefined);
            client.release();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
      usageSummaryCache = buildDbBoardUsageSummary({
        now: now(),
        tableCount: tables.length,
        knowledge,
        rowCountByTableLower,
      });
      const persistedFor = activeConnection()?.id;
      if (persistedFor) {
        await persistUsageSummary(persistedFor, usageSummaryCache);
      }
      logger.info(undefined, "数据库看板使用情况汇总已生成", {
        tableCount: usageSummaryCache.tableCount,
        knowledgeTableCount: usageSummaryCache.knowledgeTableCount,
        countedTableCount: usageSummaryCache.countedTableCount,
        frequentTableCount: usageSummaryCache.frequentTables.length,
      });
      return {
          ...usageSummaryCache,
          frequentTables: [...usageSummaryCache.frequentTables],
          rowCounts: { ...usageSummaryCache.rowCounts },
        };
    },

    async getTableColumns(schema, table, workspaceKey): Promise<DbBoardColumnMeta[]> {
      await assertWorkspaceAllowed(workspaceKey);
      const currentCatalog = await loadCatalog();
      return requireTableEntry(currentCatalog, schema, table).columns;
    },

    async queryRows(params: DbBoardQueryRowsParams): Promise<DbBoardQueryResult> {
      await assertWorkspaceAllowed(params.workspaceKey);
      const currentPool = await ensurePool();
      const currentCatalog = await loadCatalog();
      const entry = requireTableEntry(currentCatalog, params.schema, params.table);
      const pageSize = clampPageSize(params.pageSize);
      const page = Math.max(1, Math.floor(params.page) || 1);
      if (params.searchColumn) {
        assertColumnsKnown([params.searchColumn], entry.columns);
      }
      const { listSql, countSql, hasSearch } = buildQueryRowsSql({
        qualifiedTable: quoteQualifiedName(entry.schema, entry.name),
        pkColumns: pkColumnsOf(entry),
        searchColumn: params.searchColumn,
      });
      const searchValue = params.searchValue?.trim()
        ? `%${params.searchValue.trim().replace(/[%_\\]/gu, (ch) => `\\${ch}`)}%`
        : undefined;
      const listParams: unknown[] = [];
      const countParams: unknown[] = [];
      if (hasSearch && searchValue !== undefined) {
        listParams.push(searchValue);
        countParams.push(searchValue);
      } else if (hasSearch) {
        // 有搜索列但无搜索值时退化为无条件查询
        listParams.push("%%");
        countParams.push("%%");
      }
      listParams.push(pageSize, (page - 1) * pageSize);
      const [listResult, countResult] = await Promise.all([
        currentPool.query(listSql, listParams),
        currentPool.query(countSql, countParams),
      ]);
      const total = Number((countResult.rows[0] as { total?: string }).total ?? 0);
      return {
        columns: entry.columns,
        rows: (listResult.rows as Array<Record<string, unknown>>).map(normalizeRowForWire),
        total,
        page,
        pageSize,
      };
    },

    async insertRow(params: DbBoardInsertRowParams): Promise<DbBoardWriteResult> {
      await assertWorkspaceAllowed(params.workspaceKey);
      const entry = requireTableEntry(await loadCatalog(), params.schema, params.table);
      if (!isWritableTable(entry)) {
        throw new DbBoardError("该表没有可用主键，仅支持查询。", "request-failed");
      }
      const requestedColumns = Object.keys(params.values);
      if (requestedColumns.length === 0) {
        throw new DbBoardError("没有提供任何列值。", "request-failed");
      }
      assertColumnsKnown(requestedColumns, entry.columns);
      for (const name of requestedColumns) {
        const meta = getColumnMeta(entry.columns, name)!;
        if (isReadOnlyColumn(meta)) {
          throw new DbBoardError(`列 ${name} 为二进制/数组类型，不能通过看板写入。`, "request-failed");
        }
      }
      const qualified = quoteQualifiedName(entry.schema, entry.name);
      const sql = buildInsertReturningSql(qualified, requestedColumns);
      const values = requestedColumns.map((name) => params.values[name] ?? null);

      const result = await withTransaction(async (client) => {
        await ensureAuditTable(client);
        const inserted = await client.query(sql, values);
        const row = normalizeRowForWire(inserted.rows[0] as Record<string, unknown>);
        const pk = buildPkObject(inserted.rows[0] as Record<string, unknown>, pkColumnsOf(entry));
        const logId = await insertOpLog(client, {
          operator: params.operator || "local",
          opType: "insert",
          schemaName: entry.schema,
          tableName: entry.name,
          pkJson: JSON.stringify(pk),
          beforeJson: null,
          afterJson: JSON.stringify(row),
        });
        return { row, logId };
      });
      logger.info(undefined, "看板新增行", {
        table: tableKey(entry.schema, entry.name),
        logId: result.logId,
      });
      return result;
    },

    async updateRow(params: DbBoardUpdateRowParams): Promise<DbBoardWriteResult> {
      await assertWorkspaceAllowed(params.workspaceKey);
      const entry = requireTableEntry(await loadCatalog(), params.schema, params.table);
      if (!isWritableTable(entry)) {
        throw new DbBoardError("该表没有可用主键，仅支持查询。", "request-failed");
      }
      const pks = pkColumnsOf(entry);
      const pkNames = new Set(pks.map((column) => column.name));
      const pkInputNames = Object.keys(params.pk);
      if (pkInputNames.length !== pkNames.size || !pkInputNames.every((name) => pkNames.has(name))) {
        throw new DbBoardError("主键列不完整或包含非主键列。", "request-failed");
      }
      const setColumnNames = Object.keys(params.values).filter((name) => !pkNames.has(name));
      if (setColumnNames.length === 0) {
        throw new DbBoardError("没有要修改的列。", "request-failed");
      }
      assertColumnsKnown([...setColumnNames, ...pkInputNames], entry.columns);
      for (const name of setColumnNames) {
        const meta = getColumnMeta(entry.columns, name)!;
        if (isReadOnlyColumn(meta)) {
          throw new DbBoardError(`列 ${name} 为二进制/数组类型，不能通过看板写入。`, "request-failed");
        }
      }
      const qualified = quoteQualifiedName(entry.schema, entry.name);
      const selectSql = buildSelectByPkSql(qualified, pks, { forUpdate: true });
      const pkValues = pks.map((column) => params.pk[column.name] ?? null);
      const updateSql = buildUpdateByPkReturningSql(qualified, pks, setColumnNames);
      const setValues = setColumnNames.map((name) => params.values[name] ?? null);

      const result = await withTransaction(async (client) => {
        await ensureAuditTable(client);
        const before = await client.query(selectSql, pkValues);
        if (before.rows.length === 0) {
          throw new DbBoardError("目标行不存在（可能已被回退或外部修改）。", "conflict");
        }
        const beforeRow = before.rows[0] as Record<string, unknown>;
        const updated = await client.query(updateSql, [...setValues, ...pkValues]);
        if (updated.rows.length === 0) {
          throw new DbBoardError("目标行不存在（可能已被回退或外部修改）。", "conflict");
        }
        const afterRow = normalizeRowForWire(updated.rows[0] as Record<string, unknown>);
        const beforeChanged: Record<string, unknown> = {};
        const afterChanged: Record<string, unknown> = {};
        for (const name of setColumnNames) {
          beforeChanged[name] = normalizeRowValueForWire(beforeRow[name]);
          afterChanged[name] = afterRow[name];
        }
        const pk = buildPkObject(updated.rows[0] as Record<string, unknown>, pks);
        const logId = await insertOpLog(client, {
          operator: params.operator || "local",
          opType: "update",
          schemaName: entry.schema,
          tableName: entry.name,
          pkJson: JSON.stringify(pk),
          beforeJson: JSON.stringify(beforeChanged),
          afterJson: JSON.stringify(afterChanged),
        });
        return { row: afterRow, logId };
      });
      logger.info(undefined, "看板修改行", {
        table: tableKey(entry.schema, entry.name),
        logId: result.logId,
        columns: setColumnNames,
      });
      return result;
    },

    async listOpLogs(params: DbBoardListOpLogsParams): Promise<DbBoardOpLogResult> {
      await assertWorkspaceAllowed(params.workspaceKey);
      const currentPool = await ensurePool();
      const pageSize = clampPageSize(params.pageSize);
      const page = Math.max(1, Math.floor(params.page) || 1);
      const conditions: string[] = [];
      const values: unknown[] = [];
      if (params.schema) {
        values.push(params.schema);
        conditions.push(`schema_name = $${values.length}`);
      }
      if (params.table) {
        values.push(params.table);
        conditions.push(`table_name = $${values.length}`);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const limitIndex = values.length + 1;
      const countResult = await currentPool.query(
        `SELECT count(*)::text AS total FROM ${AUDIT_TABLE_NAME} ${whereClause}`,
        values,
      );
      const total = Number((countResult.rows[0] as { total: string }).total);
      const result = await currentPool.query(
        `SELECT id, created_at, operator, op_type, schema_name, table_name, pk_json,
                before_json, after_json, status, rolled_back_at, rollback_of
         FROM ${AUDIT_TABLE_NAME} ${whereClause}
         ORDER BY id DESC
         LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`,
        [...values, pageSize, (page - 1) * pageSize],
      );
      const entries: DbBoardOpLogEntry[] = [];
      for (const row of result.rows as Array<Record<string, unknown>>) {
        entries.push({
          id: Number(row.id),
          createdAt: String(normalizeRowValueForWire(row.created_at)),
          operator: String(row.operator),
          opType: row.op_type as "insert" | "update",
          schemaName: String(row.schema_name),
          tableName: String(row.table_name),
          pk: safeParseJson<Record<string, unknown>>(row.pk_json, {}),
          before:
            row.before_json == null
              ? null
              : safeParseJson<Record<string, unknown> | null>(row.before_json, null),
          after: safeParseJson<Record<string, unknown>>(row.after_json, {}),
          status: row.status as "active" | "rolled_back",
          rolledBackAt:
            row.rolled_back_at == null
              ? null
              : String(normalizeRowValueForWire(row.rolled_back_at)),
          rollbackOf: row.rollback_of == null ? null : Number(row.rollback_of),
        });
      }
      return { entries, total, page, pageSize };
    },

    async rollback(params: DbBoardRollbackParams): Promise<DbBoardRollbackResult> {
      await assertWorkspaceAllowed(params.workspaceKey);
      const compensationLogId = await withTransaction(async (client) => {
        await ensureAuditTable(client);
        const logResult = await client.query(
          `SELECT id, op_type, schema_name, table_name, pk_json, before_json, after_json, status, rollback_of
           FROM ${AUDIT_TABLE_NAME} WHERE id = $1 FOR UPDATE`,
          [params.logId],
        );
        const logRow = logResult.rows[0] as
          | {
              id: string;
              op_type: "insert" | "update";
              schema_name: string;
              table_name: string;
              pk_json: string;
              before_json: string | null;
              after_json: string;
              status: string;
              rollback_of: string | null;
            }
          | undefined;
        if (!logRow) {
          throw new DbBoardError("操作日志不存在。", "request-failed");
        }
        if (logRow.status !== "active") {
          throw new DbBoardError("该日志已回退，不能重复回退。", "conflict");
        }
        // 按行严格逆序。update 回退需要精确恢复值：任何更新的 active 日志（含补偿）都挡。
        // insert 回退是删行，行的当前值不影响正确性：只被更新的「非补偿」日志（用户真实
        // 操作）阻挡——否则补偿链会让最初的新增永远无法回退（E2E 实测发现的死锁）。
        const newerGenuineOnly = logRow.op_type === "insert";
        const newerResult = await client.query(
          `SELECT count(*)::text AS total FROM ${AUDIT_TABLE_NAME}
           WHERE schema_name = $1 AND table_name = $2 AND pk_json = $3 AND id > $4 AND status = 'active'
             ${newerGenuineOnly ? "AND rollback_of IS NULL" : ""}`,
          [logRow.schema_name, logRow.table_name, logRow.pk_json, Number(logRow.id)],
        );
        if (Number((newerResult.rows[0] as { total: string }).total) > 0) {
          throw new DbBoardError("该行存在更晚的未回退操作，请先回退更新的日志。", "conflict");
        }
        const entry = requireTableEntry(
          await loadCatalog(),
          logRow.schema_name,
          logRow.table_name,
        );
        const pks = pkColumnsOf(entry);
        const qualified = quoteQualifiedName(entry.schema, entry.name);
        const pkObject = safeParseJson<Record<string, unknown>>(logRow.pk_json, {});
        const afterObject = safeParseJson<Record<string, unknown>>(logRow.after_json, {});
        const beforeObject = logRow.before_json
          ? safeParseJson<Record<string, unknown>>(logRow.before_json, {})
          : null;
        const pkValues = pks.map((column) => pkObject[column.name] ?? null);

        if (logRow.op_type === "insert") {
          // insert 型日志的回退分两种：
          // - 原始 insert（rollback_of 为空）：逆操作 = 按 PK 删行（全仓库唯一 DELETE 路径）；
          // - insert 回退产生的补偿（rollback_of 非空）：它描述"行已被回退删除"，逆操作 =
          //   按 after 快照重新插入该行（undo 的 undo = redo）。
          if (containsBinaryMarker(afterObject)) {
            throw new DbBoardError("行内含二进制列快照，无法通过看板回退恢复。", "conflict");
          }
          const selectSql = buildSelectByPkSql(qualified, pks, { forUpdate: true });
          if (logRow.rollback_of == null) {
            const existing = await client.query(selectSql, pkValues);
            if (existing.rows.length === 0) {
              throw new DbBoardError("目标行已不存在，无法回退。", "conflict");
            }
            await client.query(buildDeleteByPkSql(qualified, pks), pkValues);
            await client.query(
              `UPDATE ${AUDIT_TABLE_NAME} SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1`,
              [Number(logRow.id)],
            );
            // 行已删除：该行残留的 active 补偿日志（若因并发产生）一并标记，避免悬挂的"未回退"状态。
            await client.query(
              `UPDATE ${AUDIT_TABLE_NAME} SET status = 'rolled_back', rolled_back_at = now()
               WHERE schema_name = $1 AND table_name = $2 AND pk_json = $3 AND id > $4 AND status = 'active'`,
              [logRow.schema_name, logRow.table_name, logRow.pk_json, Number(logRow.id)],
            );
            // 补偿日志：再回退它 = 重新插入该行（快照为删除时的完整行）。
            return insertOpLog(client, {
              operator: params.operator || "local",
              opType: "insert",
              schemaName: entry.schema,
              tableName: entry.name,
              pkJson: logRow.pk_json,
              beforeJson: null,
              afterJson: logRow.after_json,
              rollbackOf: Number(logRow.id),
            });
          }
          // 补偿 insert 的回退：行必须已不存在（被回退删除）；存在说明已被外部重建，报冲突。
          const existing = await client.query(selectSql, pkValues);
          if (existing.rows.length > 0) {
            throw new DbBoardError("目标行已存在（可能被外部重建），无法执行恢复插入。", "conflict");
          }
          const insertColumns = entry.columns
            .filter((column) => Object.prototype.hasOwnProperty.call(afterObject, column.name))
            .map((column) => column.name);
          if (insertColumns.length === 0) {
            throw new DbBoardError("日志快照缺少可恢复的列。", "request-failed");
          }
          const insertSql = buildInsertReturningSql(qualified, insertColumns);
          const insertValues = insertColumns.map((name) => afterObject[name] ?? null);
          await client.query(insertSql, insertValues);
          await client.query(
            `UPDATE ${AUDIT_TABLE_NAME} SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1`,
            [Number(logRow.id)],
          );
          // 再回退本次恢复插入 = 再次删行，因此补偿仍是 insert 型（after = 同一快照）。
          return insertOpLog(client, {
            operator: params.operator || "local",
            opType: "insert",
            schemaName: entry.schema,
            tableName: entry.name,
            pkJson: logRow.pk_json,
            beforeJson: null,
            afterJson: logRow.after_json,
            rollbackOf: Number(logRow.id),
          });
        }

        // update 回退：乐观校验当前值 == after，再恢复 before。
        const changedColumns = Object.keys(afterObject);
        if (changedColumns.length === 0) {
          throw new DbBoardError("日志缺少变更列，无法回退。", "request-failed");
        }
        const selectSql = buildSelectByPkSql(qualified, pks, { forUpdate: true });
        const current = await client.query(selectSql, pkValues);
        if (current.rows.length === 0) {
          throw new DbBoardError("目标行已不存在，无法回退。", "conflict");
        }
        const currentRow = current.rows[0] as Record<string, unknown>;
        for (const name of changedColumns) {
          const currentValue = normalizeRowValueForWire(currentRow[name]);
          if (!deepEquals(currentValue, afterObject[name])) {
            throw new DbBoardError(
              `列 ${name} 的当前值与日志记录不一致（可能被再次修改），禁止回退。`,
              "conflict",
            );
          }
        }
        const restoreColumns = changedColumns;
        const restoreSql = buildUpdateByPkReturningSql(qualified, pks, restoreColumns);
        const restoreValues = restoreColumns.map((name) => beforeObject?.[name] ?? null);
        await client.query(restoreSql, [...restoreValues, ...pkValues]);
        await client.query(
          `UPDATE ${AUDIT_TABLE_NAME} SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1`,
          [Number(logRow.id)],
        );
        // 补偿日志：before/after 对调，再回退它 = 重新应用原 update。
        const compensationBefore: Record<string, unknown> = {};
        const compensationAfter: Record<string, unknown> = {};
        for (const name of changedColumns) {
          compensationBefore[name] = afterObject[name];
          compensationAfter[name] = beforeObject?.[name] ?? null;
        }
        return insertOpLog(client, {
          operator: params.operator || "local",
          opType: "update",
          schemaName: entry.schema,
          tableName: entry.name,
          pkJson: logRow.pk_json,
          beforeJson: JSON.stringify(compensationBefore),
          afterJson: JSON.stringify(compensationAfter),
          rollbackOf: Number(logRow.id),
        });
      });
      logger.info(undefined, "看板回退完成", {
        logId: params.logId,
        compensationLogId,
      });
      return { compensationLogId };
    },

    // 探索看板 --------------------------------------------------------------

    async generateDashboard(
      params: DbBoardGenerateDashboardParams,
    ): Promise<DbBoardGenerationResult> {
      await assertWorkspaceAllowed(params.workspaceKey);
      const question = params.question?.trim();
      if (!question) {
        throw new DbBoardError("问题不能为空。", "request-failed");
      }
      const currentCatalog = await loadCatalog();
      const tables: DbBoardPromptTable[] = [...currentCatalog.tables.values()].map((entry) => ({
        schema: entry.schema,
        name: entry.name,
        columns: entry.columns,
      }));
      if (tables.length === 0) {
        throw new DbBoardError("数据库中没有可用的业务表。", "not-connected");
      }
      const selection = await resolveCurrentModel();
      // 知识库两步化：Step A 轻调用选表 → Step B 注入选中表的知识卡片。
      // 无知识库 / 选表失败均回退现有裸元数据行为。
      let knowledgeCards: string | undefined;
      if (options.loadKnowledge) {
        const knowledge = await options.loadKnowledge().catch(() => null);
        if (knowledge && knowledge.stats.tableCount > 0) {
          try {
            const selectionRaw = await completeText(
              buildTableSelectionPrompt(knowledge, question),
              DB_BOARD_TABLE_SELECTION_QUERY_SOURCE,
              selection,
              1024,
            );
            const selectedTables = parseTableSelection(selectionRaw);
            if (selectedTables && selectedTables.length > 0) {
              knowledgeCards = buildKnowledgeCardsText(knowledge, selectedTables);
            }
          } catch (error) {
            logger.warn(undefined, "知识库选表失败，回退裸元数据生成", {
              error: error instanceof Error ? error.message.slice(0, 120) : String(error),
            });
          }
        }
      }
      const basePrompt = buildDashboardGenerationPrompt({
        tables,
        question,
        previousSpec: params.previousSpec,
        revisionNote: params.revisionNote,
        ...(knowledgeCards ? { knowledgeCards } : {}),
      });
      let draft = await generateDraft(basePrompt, selection);
      let sqlValidation = draftSqlValidation(draft);
      if (!sqlValidation.ok) {
        // 首次输出含非法 SQL 时，带错误反馈重试一次。
        const retryPrompt = [
          basePrompt,
          "",
          `上一次输出存在以下问题，请修正后重新输出完整 JSON：${sqlValidation.reason}`,
        ].join("\n");
        draft = await generateDraft(retryPrompt, selection);
        sqlValidation = draftSqlValidation(draft);
      }
      const spec = finalizeDashboardSpec(draft, {
        id: params.previousSpec?.id ?? randomUUID(),
        question,
        previousSpec: params.previousSpec,
        revisionNote: params.revisionNote,
        now: now(),
        newChartId: () => randomUUID().slice(0, 8),
      });
      return {
        spec,
        modelInfo: { providerId: selection.providerId, modelId: selection.modelId },
      };
    },

    async runDashboardSql(sql: string, workspaceKey?: string): Promise<DbBoardSqlResult> {
      await assertWorkspaceAllowed(workspaceKey);
      const wrapped = wrapReadOnlySelect(sql, DB_BOARD_DASHBOARD_ROW_LIMIT);
      const startedAt = Date.now();
      const currentPool = await ensurePool();
      const client = await currentPool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query(`SET LOCAL statement_timeout = ${DB_BOARD_STATEMENT_TIMEOUT_MS}`);
        const result = await client.query(wrapped);
        await client.query("COMMIT");
        const rows = (result.rows as Array<Record<string, unknown>>).map(normalizeRowForWire);
        return {
          columns: result.fields.map((field) => ({ name: field.name })),
          rows,
          rowCount: rows.length,
          truncated: rows.length >= DB_BOARD_DASHBOARD_ROW_LIMIT,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          // best-effort
        });
        throw new DbBoardError(`查询执行失败：${normalizeDbError(error)}`, "request-failed");
      } finally {
        client.release();
      }
    },

    async explainQuery(params: DbBoardExplainQueryParams): Promise<{ explanation: string }> {
      await assertWorkspaceAllowed(params.workspaceKey);
      const selection = await resolveCurrentModel();
      const prompt = buildExplainQueryPrompt({
        sql: params.sql,
        chartTitle: params.chartTitle,
        question: params.question,
      });
      const explanation = (
        await completeText(prompt, DB_BOARD_EXPLAIN_QUERY_SOURCE, selection, EXPLAIN_MAX_OUTPUT_TOKENS)
      ).trim();
      if (!explanation) {
        throw new DbBoardError("模型没有返回解释内容。", "invalid-output");
      }
      return { explanation };
    },

    async listDashboards(): Promise<DbBoardDashboardSummary[]> {
      return store.list();
    },

    async getDashboard(id: string): Promise<DbBoardDashboardSpec | null> {
      return store.get(id);
    },

    async saveDashboard(spec: DbBoardDashboardSpec): Promise<DbBoardDashboardSpec> {
      const next: DbBoardDashboardSpec = { ...spec, updatedAt: now() };
      await store.save(next);
      return next;
    },

    async deleteDashboardDefinition(id: string): Promise<void> {
      await store.delete(id);
    },
  };

  async function resolveCurrentModel(): Promise<
    ZCodeWorkspaceGenerateTextParams["selection"]
  > {
    const current = await options.readCurrentModel();
    const providerId = current?.providerId?.trim();
    const modelId = current?.modelId?.trim();
    if (!providerId || !modelId) {
      throw new DbBoardError(
        "未读取到当前模型，请先在模型选择中配置模型。", "model-unavailable",
      );
    }
    return current!;
  }

  async function generateDraft(
    prompt: string,
    selection: ZCodeWorkspaceGenerateTextParams["selection"],
  ) {
    const text = await completeText(
      prompt,
      DB_BOARD_DASHBOARD_QUERY_SOURCE,
      selection,
      DASHBOARD_MAX_OUTPUT_TOKENS,
    );
    const parsed = parseDashboardDraft(text);
    if (!parsed.ok) {
      throw new DbBoardError(`模型输出不可用：${parsed.reason}`, "invalid-output");
    }
    return parsed.draft;
  }

  /**
   * 带输出预算的一次式生成；预算超过模型上限（小上限模型）时降档到 1024 重试一次。
   * timeoutMs 放宽 agent 默认 60s（蒸馏级 prompt + 4096 token 输出）。
   */
  async function completeText(
    prompt: string,
    querySource: string,
    selection: ZCodeWorkspaceGenerateTextParams["selection"],
    budget: number,
    timeoutMs = 150_000,
  ): Promise<string> {
    try {
      const result = await options.generateText({
        prompt,
        querySource,
        selection,
        maxOutputTokens: budget,
        timeoutMs,
      });
      return result.text;
    } catch (error) {
      if (error instanceof DbBoardError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        budget > FALLBACK_MAX_OUTPUT_TOKENS &&
        message.includes(MAX_OUTPUT_TOKENS_RANGE_ERROR)
      ) {
        const result = await options.generateText({
          prompt,
          querySource,
          selection,
          maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
          timeoutMs,
        });
        return result.text;
      }
      throw new DbBoardError(`模型请求失败：${message.slice(0, 160)}`, "request-failed");
    }
  }

  return service;
}

// ============================================================================
// 内部工具
// ============================================================================

function validateConnectionConfig(config: DbBoardConnectionConfig): void {
  if (!config.host?.trim()) throw new DbBoardError("数据库主机不能为空。", "request-failed");
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new DbBoardError("端口不合法。", "request-failed");
  }
  if (!config.database?.trim()) throw new DbBoardError("数据库名不能为空。", "request-failed");
  if (!config.username?.trim()) throw new DbBoardError("用户名不能为空。", "request-failed");
}
function clampPageSize(pageSize: number): number {
  const value = Math.floor(pageSize);
  if (!Number.isFinite(value) || value <= 0) return DB_BOARD_DEFAULT_PAGE_SIZE;
  return Math.min(value, DB_BOARD_MAX_PAGE_SIZE);
}

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeDbError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\bpassword=\S+/gi, "password=***").slice(0, 300);
  }
  return String(error).slice(0, 300);
}

/** JSON 值级比较（乐观校验用；数字/字符串区分严格）。 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      deepEquals(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}
