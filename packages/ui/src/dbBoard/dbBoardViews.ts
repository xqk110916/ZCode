/**
 * 数据库看板视图辅助：单元格值格式化、审计 diff、状态标签键。
 * 仅做纯展示投影，不含数据获取。
 */
import {
  DB_BOARD_BINARY_MARKER_PREFIX,
  type DbBoardOpLogEntry,
  type DbBoardTableMeta,
} from "@zcode/services";

export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

export function isNullValue(value: unknown): boolean {
  return value === null || value === undefined;
}

export function isBinaryPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(DB_BOARD_BINARY_MARKER_PREFIX);
}

export function binaryPlaceholderLabel(value: string): string {
  return value.slice(DB_BOARD_BINARY_MARKER_PREFIX.length);
}

/** 审计日志条目的变更列 diff 行（update：before → after；insert：全部列 after）。 */
export interface OpLogDiffRow {
  column: string;
  before: string;
  after: string;
  beforeNull: boolean;
  afterNull: boolean;
}

export function buildOpLogDiffRows(entry: DbBoardOpLogEntry): OpLogDiffRow[] {
  const rows: OpLogDiffRow[] = [];
  const afterKeys = Object.keys(entry.after ?? {});
  const beforeKeys = entry.before ? Object.keys(entry.before) : [];
  const columns = [...new Set([...beforeKeys, ...afterKeys])];
  for (const column of columns) {
    const before = entry.before?.[column];
    const after = entry.after?.[column];
    rows.push({
      column,
      before: formatCellValue(before),
      after: formatCellValue(after),
      beforeNull: isNullValue(before),
      afterNull: isNullValue(after),
    });
  }
  return rows;
}

export function opLogTargetLabel(entry: DbBoardOpLogEntry): string {
  return `${entry.schemaName}.${entry.tableName}`;
}

export function formatPkLabel(entry: DbBoardOpLogEntry): string {
  const pk = entry.pk ?? {};
  const parts = Object.entries(pk).map(([key, value]) => `${key}=${formatCellValue(value)}`);
  return parts.join(", ") || "-";
}

export function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/**
 * 数据浏览表列表排序：已统计行数的表按行数降序（并列按限定名），
 * 未统计的表（无概览或非知识表）排在后面并保持原有字母序。
 * rowCounts 键为小写表名（来自使用情况汇总）。
 */
export function sortTablesByRowCount(
  tables: readonly DbBoardTableMeta[],
  rowCounts: Record<string, number> | null | undefined,
): DbBoardTableMeta[] {
  const next = [...tables];
  if (!rowCounts) return next;
  const countOf = (table: DbBoardTableMeta): number | undefined =>
    rowCounts[table.name.trim().toLowerCase()];
  const byName = (a: DbBoardTableMeta, b: DbBoardTableMeta): number =>
    `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`);
  next.sort((a, b) => {
    const countA = countOf(a);
    const countB = countOf(b);
    if (countA !== undefined && countB !== undefined) {
      return countB - countA || byName(a, b);
    }
    if (countA !== undefined) return -1;
    if (countB !== undefined) return 1;
    return byName(a, b);
  });
  return next;
}
