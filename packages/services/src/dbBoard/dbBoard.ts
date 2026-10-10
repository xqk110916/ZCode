import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { DbBoardUsageSummary } from "./dbBoardUsageSummary.js";
import type {
  DbBoardBindingsMap,
  DbBoardBindingMode,
  DbBoardWorkspaceAccess,
} from "./dbBoardBindings.js";

/**
 * 数据库看板：数据操作 + 探索看板（browser-safe 接口层）。
 *
 * 行为契约见 specs/services/db-board.md。核心不变量：
 * - 接口层没有任何删除数据行的方法；回退 insert 日志产生的 DELETE 仅存在于回退事务内部。
 * - insert/update 与审计日志同事务写入目标库 zcode_db_board_op_log。
 * - 探索看板 SQL 在 READ ONLY 事务中执行（叠加 statement_timeout 与行上限）。
 */

// ============================================================================
// 连接
// ============================================================================

export interface DbBoardConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
}

/** 具名连接：多项目/多环境（dev/test/prod）各一份，激活其一。 */
export interface DbBoardConnectionEntry extends DbBoardConnectionConfig {
  id: string;
  /** 显示名（如 "hbt 测试库"）。 */
  name?: string;
  /** 环境标签（dev/test/prod…）。 */
  env?: string;
}

export type DbBoardConnectionState = "disconnected" | "connected" | "error";

export interface DbBoardConnectionSnapshot {
  state: DbBoardConnectionState;
  /** 当前激活连接的配置（不含密码）；未配置时为 null。 */
  config: DbBoardConnectionConfig | null;
  /** 当前激活连接 id（多连接模式下）。 */
  activeConnectionId?: string;
  /** state=error 时的最近错误摘要（不含凭据）。 */
  error?: string;
  connectedAt?: string;
  /** 工作区准入（携带 workspaceKey 查询时）：legacy=未启用绑定；bound=已绑定；blocked=严格模式下未绑定。 */
  workspaceAccess?: DbBoardWorkspaceAccess;
  /** workspaceAccess=bound 时该工作区绑定的连接 id。 */
  boundConnectionId?: string;
}

// ============================================================================
// 工作区绑定（准入控制，轻量版）
// ============================================================================

export interface DbBoardBindingsInfo {
  mode: DbBoardBindingMode;
  bindings: DbBoardBindingsMap;
}

export interface DbBoardSetBindingParams {
  /** 统一为 workspaceIdentity?.trim() || workspacePath。 */
  workspaceKey: string;
  /** 绑定的连接 id；null = 解绑（清空最后一条回到 legacy 模式）。 */
  connectionId: string | null;
}

export interface DbBoardTestConnectionResult {
  ok: boolean;
  error?: string;
  serverVersion?: string;
}

// ============================================================================
// 表与列元数据
// ============================================================================

/** 列的编辑语义分族：readonly 列在增改表单中只读展示。 */
export type DbBoardColumnFamily =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "timestamp"
  | "time"
  | "json"
  | "uuid"
  | "binary"
  | "array"
  | "other";

export interface DbBoardColumnMeta {
  name: string;
  /** information_schema 的 data_type（如 character varying、integer）。 */
  dataType: string;
  family: DbBoardColumnFamily;
  nullable: boolean;
  isPrimaryKey: boolean;
  /** 有列默认值（含自增/序列），insert 表单中可留空。 */
  hasDefault: boolean;
  maxLength?: number | null;
  /** 数据库列注释（Kingbase all_col_comments；视图缺失时为空）。 */
  comment?: string;
}

export interface DbBoardTableMeta {
  schema: string;
  name: string;
  hasPrimaryKey: boolean;
  columnCount: number;
  /** 无主键或主键含二进制列的表仅支持查询。 */
  queryOnly: boolean;
  /** 数据库表注释（Kingbase all_tab_comments；视图缺失时为空）。 */
  comment?: string;
}

// ============================================================================
// 数据浏览
// ============================================================================

export interface DbBoardQueryRowsParams {
  /** 调用方工作区（严格模式下未绑定即拒绝；缺省不校验，见 spec）。 */
  workspaceKey?: string;
  schema: string;
  table: string;
  page: number;
  pageSize: number;
  /** 可选单列模糊搜索（ILIKE %value%）。 */
  searchColumn?: string;
  searchValue?: string;
}

export interface DbBoardQueryResult {
  columns: DbBoardColumnMeta[];
  /** JSON-safe 行数据（时间 → ISO 字符串，bytea → 占位标记）。 */
  rows: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
}

export interface DbBoardInsertRowParams {
  /** 调用方工作区（严格模式下未绑定即拒绝；缺省不校验，见 spec）。 */
  workspaceKey?: string;
  schema: string;
  table: string;
  /** 键为列名（必须通过元数据白名单），值为 JSON-safe 输入（多为字符串，由服务端推断类型）。 */
  values: Record<string, unknown>;
  /** 客户端自报的操作者（advisory，非安全边界）。 */
  operator: string;
}

export interface DbBoardUpdateRowParams {
  /** 调用方工作区（严格模式下未绑定即拒绝；缺省不校验，见 spec）。 */
  workspaceKey?: string;
  schema: string;
  table: string;
  /** 主键列 → 值；必须覆盖全部主键列。 */
  pk: Record<string, unknown>;
  /** 待修改列 → 新值（不含主键列）。 */
  values: Record<string, unknown>;
  operator: string;
}

export interface DbBoardWriteResult {
  /** 写入后的完整行（JSON-safe）。 */
  row: Record<string, unknown>;
  /** 本次操作写入的审计日志 id。 */
  logId: number;
}

// ============================================================================
// 审计日志与回退
// ============================================================================

export interface DbBoardOpLogEntry {
  id: number;
  createdAt: string;
  operator: string;
  opType: "insert" | "update";
  schemaName: string;
  tableName: string;
  pk: Record<string, unknown>;
  /** insert 日志为 null；update 日志为「变更列 → 旧值」。 */
  before: Record<string, unknown> | null;
  /** insert 日志为完整行；update 日志为「变更列 → 新值」。 */
  after: Record<string, unknown>;
  status: "active" | "rolled_back";
  rolledBackAt: string | null;
  /** 本条若是回退产生的补偿日志，指向被回退的原日志 id。 */
  rollbackOf: number | null;
}

export interface DbBoardListOpLogsParams {
  /** 调用方工作区（严格模式下未绑定即拒绝；缺省不校验，见 spec）。 */
  workspaceKey?: string;
  schema?: string;
  table?: string;
  page: number;
  pageSize: number;
}

export interface DbBoardOpLogResult {
  entries: DbBoardOpLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DbBoardRollbackParams {
  /** 调用方工作区（严格模式下未绑定即拒绝；缺省不校验，见 spec）。 */
  workspaceKey?: string;
  logId: number;
  operator: string;
}

export interface DbBoardRollbackResult {
  /** 回退产生的补偿日志 id（该日志本身可再回退）。 */
  compensationLogId: number;
}

// ============================================================================
// 探索看板（Claude Dashboards 最小复刻）
// ============================================================================

export type DbBoardChartType = "bar" | "line" | "pie" | "kpi" | "table";

export interface DbBoardChartSpec {
  id: string;
  title: string;
  type: DbBoardChartType;
  /** 只读 SELECT；执行时强制 READ ONLY 事务 + 行上限。 */
  sql: string;
  description?: string;
  /** 图表列映射提示（维度/度量列名），由生成侧给出，UI 兜底用。 */
  columnHints?: {
    dimension?: string;
    measures?: string[];
  };
}

export interface DbBoardDashboardSpec {
  id: string;
  title: string;
  /** 最初的问题句。 */
  question: string;
  charts: DbBoardChartSpec[];
  /** 修订历史（含初始问题，最新在末尾）。 */
  revisionHistory: string[];
  updatedAt: string;
}

export interface DbBoardDashboardSummary {
  id: string;
  title: string;
  chartCount: number;
  updatedAt: string;
}

export interface DbBoardGenerateDashboardParams {
  /** 调用方工作区（严格模式下未绑定即拒绝；缺省不校验，见 spec）。 */
  workspaceKey?: string;
  question: string;
  /** 修订模式：携带上一版 spec 与修订指令重新生成。 */
  previousSpec?: DbBoardDashboardSpec;
  revisionNote?: string;
  locale?: string;
}

export interface DbBoardGenerationResult {
  spec: DbBoardDashboardSpec;
  modelInfo?: { providerId: string; modelId: string };
}

export interface DbBoardSqlResultColumn {
  name: string;
}

export interface DbBoardSqlResult {
  columns: DbBoardSqlResultColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** 是否被行上限截断。 */
  truncated: boolean;
  elapsedMs: number;
}

export interface DbBoardExplainQueryParams {
  /** 调用方工作区（严格模式下未绑定即拒绝；缺省不校验，见 spec）。 */
  workspaceKey?: string;
  sql: string;
  chartTitle: string;
  /** 该图回答的原始问题（帮助解释对齐口径）。 */
  question?: string;
  locale?: string;
}

// ============================================================================
// 使用情况汇总（知识库汇总看板数据源）
// ============================================================================

export interface DbBoardUsageSummaryParams {
  /** false（缺省）只读缓存；true 执行逐表计数（有界并发 + 每表超时，可能耗时）。 */
  compute?: boolean;
  /** 绕过缓存重算。 */
  force?: boolean;
  /** 调用方工作区（严格模式下未绑定即拒绝；缺省不校验，见 spec）。 */
  workspaceKey?: string;
}

// ============================================================================
// 服务接口
// ============================================================================

export interface IDbBoardService {
  // 连接 -----------------------------------------------------------------
  /**
   * 连接状态快照；携带 workspaceKey 时附加准入结论（workspaceAccess/boundConnectionId），
   * 严格模式下已绑定且与激活不一致会先自动切到绑定连接（幂等）。
   */
  getConnectionState(workspaceKey?: string): Promise<DbBoardConnectionSnapshot>;
  /** 保存/更新一个具名连接（按 entry.id upsert）；password 缺省时保留已存密码。保存后激活该连接。 */
  saveConnection(entry: DbBoardConnectionEntry, password?: string): Promise<void>;
  /** 删除具名连接（含其凭据）；删除激活连接时清空激活。 */
  deleteConnection(id: string): Promise<void>;
  /** 具名连接清单（不含密码）。 */
  listConnections(): Promise<DbBoardConnectionEntry[]>;
  /** 切换激活连接（重建连接池）。 */
  setActiveConnection(id: string): Promise<void>;

  // 工作区绑定（准入控制） -------------------------------------------------
  /** 绑定表查询；mode=strict（非空）时未绑定工作区不可用。 */
  getBindings(): Promise<DbBoardBindingsInfo>;
  /** 绑定/解绑（connectionId 校验存在；立即落盘并同步激活）。 */
  setBinding(params: DbBoardSetBindingParams): Promise<void>;
  testConnection(
    config: DbBoardConnectionConfig,
    password?: string,
    connectionId?: string,
  ): Promise<DbBoardTestConnectionResult>;

  // 元数据 ---------------------------------------------------------------
  /** 表清单（进程内缓存，连接切换失效；force=true 强制回源刷新）。 */
  listTables(force?: boolean, workspaceKey?: string): Promise<DbBoardTableMeta[]>;
  getTableColumns(schema: string, table: string, workspaceKey?: string): Promise<DbBoardColumnMeta[]>;

  // 使用情况汇总 -----------------------------------------------------------
  /** 知识库汇总看板数据源；compute=false 只读缓存（可能 null），compute=true 才计数。 */
  getUsageSummary(params: DbBoardUsageSummaryParams): Promise<DbBoardUsageSummary | null>;

  // 数据浏览（查询 / 新增 / 修改；无删除） ---------------------------------
  queryRows(params: DbBoardQueryRowsParams): Promise<DbBoardQueryResult>;
  insertRow(params: DbBoardInsertRowParams): Promise<DbBoardWriteResult>;
  updateRow(params: DbBoardUpdateRowParams): Promise<DbBoardWriteResult>;

  // 审计日志与回退 ---------------------------------------------------------
  listOpLogs(params: DbBoardListOpLogsParams): Promise<DbBoardOpLogResult>;
  rollback(params: DbBoardRollbackParams): Promise<DbBoardRollbackResult>;

  // 探索看板 ---------------------------------------------------------------
  generateDashboard(params: DbBoardGenerateDashboardParams): Promise<DbBoardGenerationResult>;
  /** 只读执行看板 SQL（READ ONLY 事务 + statement_timeout + 行上限 + 单语句包装）。 */
  runDashboardSql(sql: string, workspaceKey?: string): Promise<DbBoardSqlResult>;
  explainQuery(params: DbBoardExplainQueryParams): Promise<{ explanation: string }>;
  listDashboards(): Promise<DbBoardDashboardSummary[]>;
  getDashboard(id: string): Promise<DbBoardDashboardSpec | null>;
  saveDashboard(spec: DbBoardDashboardSpec): Promise<DbBoardDashboardSpec>;
  /** 仅删除看板定义（应用态资源），不触碰数据库数据。 */
  deleteDashboardDefinition(id: string): Promise<void>;
}

export const IDbBoardService = createServiceDescriptor<IDbBoardService>(
  ServiceChannels.DbBoard,
);
