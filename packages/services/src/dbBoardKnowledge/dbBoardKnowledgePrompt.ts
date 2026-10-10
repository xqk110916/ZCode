/**
 * 知识库蒸馏与使用的 prompt 构建 / 输出解析（纯函数；单元测试覆盖）。
 * 复用 dbBoardGeneration 的 JSON 提取工具，语义理解全部交给模型。
 */
import { z } from "zod";
import type {
  DbBoardKnowledge,
  DbBoardKnowledgeTableCard,
} from "./dbBoardKnowledge.js";
import { extractJsonObjectText } from "../dbBoard/dbBoardGeneration.js";

export const DB_BOARD_KNOWLEDGE_QUERY_SOURCE = "db_board_knowledge";
export const DB_BOARD_TABLE_SELECTION_QUERY_SOURCE = "db_board_table_selection";

// ============================================================================
// 蒸馏：证据包 → 表卡片
// ============================================================================

export interface DistillTableEvidence {
  table: string;
  domain: string;
  /** 实体类名 + 类注释。 */
  entity?: { className: string; classComment: string };
  /** 实体字段 javadoc（列名 → 中文含义）。 */
  entityFields: Array<{ column: string; comment: string }>;
  /** DDL COMMENT。 */
  ddlComments: { tableComment?: string; columns: Record<string, string> };
  /** 数据库注释（all_col_comments / all_tab_comments）。 */
  dbComments: { tableComment?: string; columns: Record<string, string> };
  /** Mapper SQL 摘录（含 join）。 */
  mapperSql?: string;
  /** Controller/Service 提供的业务操作名。 */
  operations: string[];
  /** 前端业务叫法（中文页面/功能名 → 接口路径）。 */
  frontendPages?: string[];
}

const tableCardDraftSchema = z.object({
  table: z.string().min(1).max(200),
  domain: z.string().min(1).max(100),
  purpose: z.string().min(1).max(300),
  keyColumns: z
    .array(z.object({ name: z.string().min(1).max(200), meaning: z.string().min(1).max(200) }))
    .max(24),
  relations: z
    .array(
      z.object({
        target: z.string().min(1).max(200),
        on: z.string().max(200).optional(),
        kind: z.string().max(50).optional(),
      }),
    )
    .max(10),
  notes: z.string().max(300).optional(),
});

export type DbBoardTableCardDraft = z.infer<typeof tableCardDraftSchema>;

export function buildDistillPrompt(tables: readonly DistillTableEvidence[]): string {
  const blocks = tables.map((evidence) => {
    const columnMeanings = mergeColumnMeanings(evidence);
    const lines: string[] = [];
    lines.push(`### 表 ${evidence.table}（建议业务域：${evidence.domain}）`);
    if (evidence.entity?.classComment || evidence.ddlComments.tableComment || evidence.dbComments.tableComment) {
      lines.push(
        `表注释: ${evidence.ddlComments.tableComment ?? evidence.dbComments.tableComment ?? evidence.entity?.classComment ?? ""}`,
      );
    }
    if (evidence.entity) {
      lines.push(`实体类: ${evidence.entity.className}`);
    }
    if (evidence.operations.length > 0) {
      lines.push(`业务操作(Controller/Service/Mapper 语句): ${evidence.operations.slice(0, 20).join(", ")}`);
    }
    if (evidence.frontendPages && evidence.frontendPages.length > 0) {
      lines.push(`前端页面/业务叫法(用户视角的词汇，如"收文/发文"即来自这里):`);
      for (const page of evidence.frontendPages.slice(0, 12)) {
        lines.push(`- ${page}`);
      }
    }
    if (columnMeanings.length > 0) {
      lines.push(`字段含义:`);
      for (const column of columnMeanings.slice(0, 40)) {
        lines.push(`- ${column.name}: ${column.meaning}`);
      }
    }
    if (evidence.mapperSql) {
      lines.push(`Mapper SQL 摘录(含表关联):`);
      lines.push(evidence.mapperSql.slice(0, 2_000));
    }
    return lines.join("\n");
  });

  return [
    "你是数据库业务知识整理器。根据每张表的代码证据与数据库注释，产出业务知识卡片。",
    "",
    "要求：",
    "- purpose 用一句中文说明这张表在业务里存什么、怎么用（不要复述表名）。",
    "- keyColumns 只收录对理解业务有价值的列（业务状态/类型/外键/时间口径等，含中文含义），不要罗列全部列。",
    "- relations 依据 Mapper SQL 中的 JOIN 提取本表与其他表的关联（target 表名 + on 条件简述）。",
    "- domain 用中文业务域名（如 车辆管理、收发文、会议管理）；证据不足时用建议业务域。",
    "- 语言一律中文。",
    "- 只输出 JSON，不要输出其它文字。",
    "",
    "输出 JSON 结构：",
    '{"cards":[{"table":"表名","domain":"业务域","purpose":"一句话用途","keyColumns":[{"name":"列名","meaning":"含义"}],"relations":[{"target":"关联表","on":"关联条件","kind":"left-join等"}],"notes":"口径或注意事项(可选)"}]}',
    "",
    "以下是各表证据：",
    ...blocks,
  ].join("\n");
}

export function parseTableCardsDraft(
  raw: string,
): { ok: true; cards: DbBoardTableCardDraft[] } | { ok: false; reason: string } {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) {
    return { ok: false, reason: "模型输出中未找到 JSON" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, reason: `JSON 解析失败: ${String(error).slice(0, 120)}` };
  }
  const cardsSchema = z.object({ cards: z.array(tableCardDraftSchema).min(1) });
  const validated = cardsSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, reason: `结构校验失败: ${validated.error.issues[0]?.message ?? "unknown"}` };
  }
  return { ok: true, cards: validated.data.cards };
}

// ============================================================================
// 使用：知识索引 → 选表 → 注入生成
// ============================================================================

/** Step A：域→表→用途 索引文本。 */
export function buildKnowledgeIndexText(knowledge: DbBoardKnowledge): string {
  const lines: string[] = [];
  for (const [domain, tables] of Object.entries(knowledge.domains)) {
    lines.push(`## 业务域：${domain}`);
    for (const table of tables) {
      const card = knowledge.tables[table];
      if (!card) continue;
      lines.push(`- ${card.table}：${card.purpose}`);
    }
  }
  return lines.join("\n");
}

export function buildTableSelectionPrompt(knowledge: DbBoardKnowledge, question: string): string {
  return [
    "你是数据库选表器。根据业务域/表用途索引和用户问题，选出回答该问题需要查询的表（1-6 张，宁缺毋滥）。",
    "只输出 JSON：{\"tables\":[\"表名\"]}",
    "",
    "业务域/表用途索引：",
    buildKnowledgeIndexText(knowledge).slice(0, 24_000),
    "",
    `用户问题：${question}`,
  ].join("\n");
}

const tableSelectionSchema = z.object({
  tables: z.array(z.string().min(1).max(200)).min(1).max(12),
});

export function parseTableSelection(raw: string): string[] | null {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) return null;
  try {
    const validated = tableSelectionSchema.safeParse(JSON.parse(jsonText));
    return validated.success ? validated.data.tables : null;
  } catch {
    return null;
  }
}

/** Step B：选中表的知识卡片文本（注入看板生成 prompt）。 */
export function buildKnowledgeCardsText(
  knowledge: DbBoardKnowledge,
  tables: readonly string[],
): string {
  const blocks: string[] = [];
  for (const table of tables) {
    const card = knowledge.tables[table];
    if (!card) continue;
    const lines: string[] = [];
    lines.push(`### ${card.table}（${card.domain}）`);
    lines.push(card.purpose);
    if (card.keyColumns.length > 0) {
      lines.push(
        `关键字段: ${card.keyColumns
          .slice(0, 16)
          .map((column) => `${column.name}(${column.meaning})`)
          .join(", ")}`,
      );
    }
    if (card.relations.length > 0) {
      lines.push(
        `表关联: ${card.relations
          .slice(0, 6)
          .map((relation) => `${relation.target}${relation.on ? ` ON ${relation.on}` : ""}`)
          .join("; ")}`,
      );
    }
    if (card.notes) {
      lines.push(`注意: ${card.notes}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/** 证据合并：DDL COMMENT > DB 注释 > 实体 javadoc（同一列取最先命中）。 */
export function mergeColumnMeanings(
  evidence: DistillTableEvidence,
): Array<{ name: string; meaning: string }> {
  const merged = new Map<string, string>();
  for (const field of evidence.entityFields) {
    if (field.comment && !merged.has(field.column)) {
      merged.set(field.column, field.comment);
    }
  }
  for (const [column, comment] of Object.entries(evidence.dbComments.columns)) {
    if (comment && !merged.has(column)) {
      merged.set(column, comment);
    }
  }
  for (const [column, comment] of Object.entries(evidence.ddlComments.columns)) {
    if (comment && !merged.has(column)) {
      merged.set(column, comment);
    }
  }
  return [...merged.entries()].map(([name, meaning]) => ({ name, meaning }));
}

/** 纯抽取降级卡：不经 LLM，直接由证据拼装（表卡片兜底）。 */
export function buildFallbackCard(
  evidence: DistillTableEvidence,
  evidenceFiles: readonly string[],
): DbBoardKnowledgeTableCard {
  const meanings = mergeColumnMeanings(evidence);
  const tableComment =
    evidence.ddlComments.tableComment ?? evidence.dbComments.tableComment ?? evidence.entity?.classComment ?? "";
  return {
    table: evidence.table,
    domain: evidence.domain,
    purpose: tableComment || `${evidence.entity?.className ?? evidence.table}（未蒸馏，来自代码/注释抽取）`,
    keyColumns: meanings.slice(0, 24).map((item) => ({ name: item.name, meaning: item.meaning })),
    relations: [],
    evidenceFiles: [...evidenceFiles],
    source: meanings.length > 0 || tableComment ? "extracted" : "db-comment",
  };
}
