/**
 * 数据库看板 SQL 构建与校验（纯函数，无 IO；单元测试覆盖）。
 *
 * 安全口径（见 specs/services/db-board.md）：
 * - 表/列标识符先过白名单正则，再双引号插值；调用方还需校验其存在于元数据白名单。
 * - 值一律走 $n 参数，由服务端按目标列推断类型（node-pg 以未指定类型发送文本值）。
 * - 探索看板 SQL 强制只读：语句头校验 + 子查询外包装（多语句必然语法错误），
 *   运行期叠加 READ ONLY 事务与 statement_timeout 兜底。
 *
 * 各构建函数只返回 SQL 文本；位置参数顺序在 JSDoc 中约定，由服务层按序组装。
 */
import type { DbBoardColumnFamily, DbBoardColumnMeta } from "./dbBoard.js";

/** PG/Kingbase 标识符上限 63 字节；这里按保守 ASCII 白名单校验。 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export const DB_BOARD_MAX_PAGE_SIZE = 200;
export const DB_BOARD_DEFAULT_PAGE_SIZE = 50;
export const DB_BOARD_DASHBOARD_ROW_LIMIT = 1000;
export const DB_BOARD_STATEMENT_TIMEOUT_MS = 15_000;

/** bytea 等二进制列在 wire 数据中的占位标记（避免大对象穿越 RPC）。 */
export const DB_BOARD_BINARY_MARKER_PREFIX = "__binary__:";

export function isValidIdentifier(name: string): boolean {
  return IDENTIFIER_RE.test(name);
}

export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`非法标识符: ${name.slice(0, 64)}`);
  }
  return `"${name}"`;
}

export function quoteQualifiedName(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

// ============================================================================
// 类型分族
// ============================================================================

const FAMILY_BY_DATA_TYPE: Record<string, DbBoardColumnFamily> = {
  smallint: "number",
  integer: "number",
  bigint: "number",
  tinyint: "number",
  decimal: "number",
  numeric: "number",
  real: "number",
  "double precision": "number",
  money: "number",
  "character varying": "text",
  character: "text",
  text: "text",
  name: "text",
  cidr: "text",
  inet: "text",
  "mac addr": "text",
  bit: "text",
  "bit varying": "text",
  boolean: "boolean",
  date: "date",
  timestamp: "timestamp",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamp",
  time: "time",
  "time without time zone": "time",
  "time with time zone": "time",
  interval: "text",
  json: "json",
  jsonb: "json",
  uuid: "uuid",
  bytea: "binary",
  array: "array",
};

/** information_schema.columns 的 udt_name（如 int4、varchar、_int4 数组）。 */
const FAMILY_BY_UDT: Record<string, DbBoardColumnFamily> = {
  int2: "number",
  int4: "number",
  int8: "number",
  tinyint: "number",
  float4: "number",
  float8: "number",
  numeric: "number",
  bool: "boolean",
  date: "date",
  timestamp: "timestamp",
  timestamptz: "timestamp",
  time: "time",
  timetz: "time",
  varchar: "text",
  bpchar: "text",
  text: "text",
  name: "text",
  json: "json",
  jsonb: "json",
  uuid: "uuid",
  bytea: "binary",
};

export function resolveColumnFamily(dataType: string, udtName?: string): DbBoardColumnFamily {
  // Kingbase 的 information_schema 以全大写返回 data_type/udt_name（实测 V8R3），统一小写化后匹配。
  const normalizedDataType = dataType.trim().toLowerCase();
  const normalizedUdt = udtName?.trim().toLowerCase();
  // 数组类型的 udt_name 以下划线开头（如 _int4），在 PG/Kingbase 一致。
  if (normalizedUdt?.startsWith("_")) {
    return "array";
  }
  const byUdt = normalizedUdt ? FAMILY_BY_UDT[normalizedUdt] : undefined;
  if (byUdt) return byUdt;
  const byDataType = FAMILY_BY_DATA_TYPE[normalizedDataType];
  if (byDataType) return byDataType;
  if (normalizedDataType === "array") return "array";
  // 其余（枚举、自定义类型等）按文本编辑，类型转换交给服务端推断，失败时给出明确错误。
  return "other";
}

export function isReadOnlyColumn(column: Pick<DbBoardColumnMeta, "family">): boolean {
  return column.family === "binary" || column.family === "array";
}

// ============================================================================
// 行数据 wire 归一化
// ============================================================================

/** Date → ISO 字符串；Buffer → 占位标记；其余原样。保证 JSON/RPC 安全。 */
export function normalizeRowValueForWire(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return `${DB_BOARD_BINARY_MARKER_PREFIX}${value.byteLength}B`;
  }
  return value;
}

export function normalizeRowForWire(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = normalizeRowValueForWire(value);
  }
  return result;
}

/** 值中是否含二进制占位标记（用于禁止无法忠实恢复的回退路径）。 */
export function containsBinaryMarker(value: unknown): boolean {
  if (typeof value === "string" && value.startsWith(DB_BOARD_BINARY_MARKER_PREFIX)) {
    return true;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>).some(containsBinaryMarker);
  }
  return false;
}

// ============================================================================
// 标识符白名单校验
// ============================================================================

export function getColumnMeta(
  columns: readonly DbBoardColumnMeta[],
  name: string,
): DbBoardColumnMeta | undefined {
  return columns.find((column) => column.name === name);
}

/** 校验请求的列都存在于元数据白名单。 */
export function assertColumnsKnown(
  requested: Iterable<string>,
  columns: readonly DbBoardColumnMeta[],
): void {
  for (const name of requested) {
    if (!getColumnMeta(columns, name)) {
      throw new Error(`列不存在或不可访问: ${name}`);
    }
  }
}

// ============================================================================
// SQL 构建（标识符已由调用方做元数据白名单校验）
// ============================================================================

/** 主键列按元数据顺序取值，构成稳定 pk 对象（用于 pk_json 文本比较与 wire 输出）。 */
export function buildPkObject(
  row: Record<string, unknown>,
  pkColumns: readonly DbBoardColumnMeta[],
): Record<string, unknown> {
  const pk: Record<string, unknown> = {};
  for (const column of pkColumns) {
    pk[column.name] = normalizeRowValueForWire(row[column.name]);
  }
  return pk;
}

/** 主键等值条件；参数顺序 = pkColumns 顺序（从 $startIndex 起）。 */
export function buildPkPredicateSql(
  pkColumns: readonly DbBoardColumnMeta[],
  startIndex = 1,
): string {
  if (pkColumns.length === 0) {
    throw new Error("表没有主键，无法按行定位");
  }
  return pkColumns
    .map((column, index) => `${quoteIdentifier(column.name)} = $${startIndex + index}`)
    .join(" AND ");
}

/** 按主键取整行；可选 FOR UPDATE（回退/更新的 before 快照读取）。参数顺序 = pkColumns。 */
export function buildSelectByPkSql(
  qualifiedTable: string,
  pkColumns: readonly DbBoardColumnMeta[],
  options?: { forUpdate?: boolean },
): string {
  return `SELECT * FROM ${qualifiedTable} WHERE ${buildPkPredicateSql(pkColumns)}${
    options?.forUpdate ? " FOR UPDATE" : ""
  }`;
}

/** 插入并返回整行。参数顺序 = columnNames 顺序。 */
export function buildInsertReturningSql(
  qualifiedTable: string,
  columnNames: readonly string[],
): string {
  if (columnNames.length === 0) {
    throw new Error("没有可写入的列");
  }
  const quoted = columnNames.map((name) => quoteIdentifier(name));
  const placeholders = columnNames.map((_, index) => `$${index + 1}`);
  return `INSERT INTO ${qualifiedTable} (${quoted.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`;
}

/** 按主键更新并返回整行。参数顺序 = setColumnNames 之后跟 pkColumns。 */
export function buildUpdateByPkReturningSql(
  qualifiedTable: string,
  pkColumns: readonly DbBoardColumnMeta[],
  setColumnNames: readonly string[],
): string {
  if (setColumnNames.length === 0) {
    throw new Error("没有要修改的列");
  }
  const setParts = setColumnNames.map(
    (name, index) => `${quoteIdentifier(name)} = $${index + 1}`,
  );
  const pkClause = buildPkPredicateSql(pkColumns, setColumnNames.length + 1);
  return `UPDATE ${qualifiedTable} SET ${setParts.join(", ")} WHERE ${pkClause} RETURNING *`;
}

/**
 * 仅回退 insert 日志时使用的按主键删行语句。整个仓库中唯一的 DELETE 构建点，
 * 只能由 rollback 事务调用（产品规则：删除不暴露为用户能力）。参数顺序 = pkColumns。
 */
export function buildDeleteByPkSql(
  qualifiedTable: string,
  pkColumns: readonly DbBoardColumnMeta[],
): string {
  return `DELETE FROM ${qualifiedTable} WHERE ${buildPkPredicateSql(pkColumns)}`;
}

export interface QueryRowsSql {
  listSql: string;
  countSql: string;
  /** list 参数顺序：[searchValue?] → limit → offset；count 参数顺序：[searchValue?]。 */
  hasSearch: boolean;
}

export function buildQueryRowsSql(params: {
  qualifiedTable: string;
  pkColumns: readonly DbBoardColumnMeta[];
  searchColumn?: string;
}): QueryRowsSql {
  const hasSearch = Boolean(params.searchColumn);
  const searchCondition = hasSearch
    ? `WHERE ${quoteIdentifier(params.searchColumn!)}::text ILIKE $1`
    : "";
  const limitIndex = hasSearch ? 2 : 1;
  // 有主键按主键排序保证翻页稳定；无主键退化为物理序（此类表仅支持查询）。
  const orderBy = params.pkColumns.length
    ? params.pkColumns.map((column) => quoteIdentifier(column.name)).join(", ")
    : "ctid";
  return {
    listSql: `SELECT * FROM ${params.qualifiedTable} ${searchCondition} ORDER BY ${orderBy} LIMIT $${limitIndex} OFFSET $${limitIndex + 1}`,
    countSql: `SELECT count(*)::text AS total FROM ${params.qualifiedTable} ${searchCondition}`,
    hasSearch,
  };
}

// ============================================================================
// 探索看板只读 SQL
// ============================================================================

/** 去掉 SQL 头部与尾部的注释/空白与结尾分号，返回用于语句头判断的正文。 */
export function stripSqlCommentsAndTrim(sql: string): string {
  let text = sql.trim();
  // 循环剥离头部注释（-- 行注释 / 块注释）
  for (;;) {
    if (text.startsWith("--")) {
      const newlineIndex = text.indexOf("\n");
      text = newlineIndex === -1 ? "" : text.slice(newlineIndex + 1).trim();
      continue;
    }
    if (text.startsWith("/*")) {
      const endIndex = text.indexOf("*/");
      if (endIndex === -1) return "";
      text = text.slice(endIndex + 2).trim();
      continue;
    }
    break;
  }
  // 去掉结尾分号（允许单个收尾分号）
  text = text.replace(/;+\s*$/u, "");
  return text.trim();
}

/** 单条只读 SELECT 校验：SELECT/WITH 开头、无 NUL、剥离收尾分号后无内部分号。 */
export function validateDashboardSqlHead(
  sql: string,
): { ok: true; body: string } | { ok: false; reason: string } {
  if (!sql || !sql.trim()) {
    return { ok: false, reason: "SQL 为空" };
  }
  if (sql.includes("\0")) {
    return { ok: false, reason: "SQL 含非法字符" };
  }
  const body = stripSqlCommentsAndTrim(sql);
  if (!/^(select|with)\b/i.test(body)) {
    return { ok: false, reason: "只允许 SELECT 或 WITH 开头的查询语句" };
  }
  if (body.includes(";")) {
    return { ok: false, reason: "只允许单条语句" };
  }
  return { ok: true, body };
}

/**
 * 只读包装：`SELECT * FROM (<body>) AS _db_board_sub LIMIT <limit>`。
 * - 多语句与 SELECT ... INTO 在子查询内必然语法错误；
 * - 行数硬上限防止模型生成无界查询。
 */
export function wrapReadOnlySelect(sql: string, limit: number): string {
  const validation = validateDashboardSqlHead(sql);
  if (!validation.ok) {
    throw new Error(`看板 SQL 校验失败：${validation.reason}`);
  }
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), DB_BOARD_DASHBOARD_ROW_LIMIT));
  return `SELECT * FROM (\n${validation.body}\n) AS _db_board_sub LIMIT ${safeLimit}`;
}
