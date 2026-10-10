import type { DbBoardKnowledgeTableCard } from "../dbBoardKnowledge/dbBoardKnowledge.js";

/**
 * 使用情况汇总（知识库汇总看板的数据源）：纯构建，无 IO。
 *
 * 行数语义：活跃度近似——Kingbase V8R3 Oracle 兼容模式没有可用的统计快表
 * （all_tables.num_rows 恒 0、pg_class/table_rows 不存在），只能逐表 count；
 * 因此「常用业务表」按行数 ≥ 阈值过滤 + 取前 N，行数未知的表不参与。
 */

export const DB_BOARD_USAGE_MIN_ROWS = 1000;
export const DB_BOARD_USAGE_TOP_N = 20;

export interface DbBoardUsageSummaryTable {
  table: string;
  domain: string;
  purpose: string;
  rowCount: number;
}

export interface DbBoardUsageSummary {
  generatedAt: string;
  /** 全库表数（listTables 口径，非系统表）。 */
  tableCount: number;
  /** 知识覆盖表数。 */
  knowledgeTableCount: number;
  domainCount: number;
  /** 实际拿到行数的知识表数（超时/失败的表不计）。 */
  countedTableCount: number;
  /** 行数来源说明：逐表 count。 */
  rowCountSource: "count";
  /** 常用业务表：行数 ≥ 阈值的知识表，按行数降序取前 N。 */
  frequentTables: DbBoardUsageSummaryTable[];
  /** 全量行数（小写表名 → 行数，仅成功统计的知识表）；数据浏览表列表据此排序。 */
  rowCounts: Record<string, number>;
}

export function buildDbBoardUsageSummary(params: {
  now: string;
  tableCount: number;
  knowledge: { domains: Record<string, string[]>; tables: Record<string, DbBoardKnowledgeTableCard> } | null;
  /** 小写表名 → 行数（仅含成功统计的表）。 */
  rowCountByTableLower: Map<string, number>;
  minRows?: number;
  topN?: number;
}): DbBoardUsageSummary {
  const { now, tableCount, knowledge, rowCountByTableLower } = params;
  const minRows = params.minRows ?? DB_BOARD_USAGE_MIN_ROWS;
  const topN = params.topN ?? DB_BOARD_USAGE_TOP_N;
  const cards = knowledge ? Object.values(knowledge.tables) : [];
  const frequent: DbBoardUsageSummaryTable[] = [];
  let counted = 0;
  for (const card of cards) {
    const rowCount = rowCountByTableLower.get(card.table.trim().toLowerCase());
    if (rowCount === undefined) continue;
    counted += 1;
    if (rowCount >= minRows) {
      frequent.push({ table: card.table, domain: card.domain, purpose: card.purpose, rowCount });
    }
  }
  frequent.sort((a, b) => b.rowCount - a.rowCount || a.table.localeCompare(b.table));
  return {
    generatedAt: now,
    tableCount,
    knowledgeTableCount: cards.length,
    domainCount: knowledge ? Object.keys(knowledge.domains).length : 0,
    countedTableCount: counted,
    rowCountSource: "count",
    frequentTables: frequent.slice(0, topN),
    rowCounts: Object.fromEntries(rowCountByTableLower),
  };
}
