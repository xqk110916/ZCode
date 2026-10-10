/**
 * 知识库 Markdown 文档导出（纯函数，供下载与单测复用）。
 * 结构：数据库概览（可选，来自使用情况汇总）→ 按业务域分组 → 表卡片（用途/关键字段/关联/备注/来源/证据文件）。
 */
import type {
  DbBoardKnowledge,
  DbBoardKnowledgeTableCard,
  DbBoardUsageSummary,
} from "@zcode/services";

const SOURCE_LABELS: Record<DbBoardKnowledgeTableCard["source"], string> = {
  distilled: "LLM 蒸馏",
  extracted: "代码抽取",
  "db-comment": "数据库注释",
};

function formatCard(card: DbBoardKnowledgeTableCard): string[] {
  const lines: string[] = [];
  lines.push(`### ${card.table}（${card.domain}）`);
  lines.push("");
  lines.push(`- **用途**：${card.purpose}`);
  if (card.keyColumns.length > 0) {
    lines.push(
      `- **关键字段**：${card.keyColumns.map((column) => `${column.name}=${column.meaning}`).join("；")}`,
    );
  }
  if (card.relations.length > 0) {
    lines.push(
      `- **表关联**：${card.relations
        .map((relation) => `${relation.target}${relation.on ? `（ON ${relation.on}）` : ""}`)
        .join("；")}`,
    );
  }
  if (card.notes) {
    lines.push(`- **备注**：${card.notes}`);
  }
  lines.push(`- **来源**：${SOURCE_LABELS[card.source] ?? card.source}`);
  if (card.evidenceFiles.length > 0) {
    lines.push(`- **证据文件**：${card.evidenceFiles.slice(0, 8).join("、")}`);
  }
  lines.push("");
  return lines;
}

export function buildKnowledgeMarkdown(
  knowledge: DbBoardKnowledge,
  summary?: DbBoardUsageSummary | null,
): string {
  const lines: string[] = [];
  lines.push(`# 数据库业务知识库`);
  lines.push("");
  lines.push(
    `- 构建时间：${knowledge.builtAt}`,
    `- 表数量：${knowledge.stats.tableCount}（LLM 蒸馏 ${knowledge.stats.distilled} / 代码抽取 ${knowledge.stats.extracted} / 数据库注释 ${knowledge.stats.dbCommentOnly}）`,
    `- 业务域数量：${knowledge.stats.domainCount}`,
  );
  if (knowledge.stats.datasourceMapping && knowledge.stats.datasourceMapping.length > 0) {
    lines.push(
      `- 数据源映射：${knowledge.stats.datasourceMapping
        .map((item) => `${item.service} → ${item.url}`)
        .join("；")}`,
    );
  }
  lines.push("");
  if (summary) {
    lines.push("## 数据库概览");
    lines.push("");
    lines.push(
      `- 统计时间：${summary.generatedAt}（行数为逐表 count，作为表使用频繁度的近似）`,
      `- 表总数：${summary.tableCount} · 知识覆盖：${summary.knowledgeTableCount} · 业务域：${summary.domainCount} · 已统计行数表数：${summary.countedTableCount}`,
    );
    if (summary.frequentTables.length > 0) {
      lines.push("");
      lines.push("### 常用业务表（按行数降序，仅列行数 ≥1000 的前 20 张）");
      lines.push("");
      lines.push("| 表 | 业务域 | 用途 | 行数 |");
      lines.push("| --- | --- | --- | --- |");
      for (const table of summary.frequentTables) {
        lines.push(
          `| ${table.table} | ${table.domain} | ${table.purpose.replace(/\|/g, "\\|")} | ${table.rowCount.toLocaleString()} |`,
        );
      }
    }
    lines.push("");
  }
  const domains = Object.entries(knowledge.domains).sort((a, b) => b[1].length - a[1].length);
  for (const [domain, tables] of domains) {
    lines.push(`## 业务域：${domain}（${tables.length} 张表）`);
    lines.push("");
    for (const table of tables) {
      const card = knowledge.tables[table];
      if (card) {
        lines.push(...formatCard(card));
      }
    }
  }
  return lines.join("\n");
}

/** 导出文件名（含日期）。 */
export function knowledgeExportFileName(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `数据库业务知识库-${date}.md`;
}
