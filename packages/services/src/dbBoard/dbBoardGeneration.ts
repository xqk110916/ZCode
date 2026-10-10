/**
 * 探索看板生成（纯函数：prompt 构建、模型输出解析、spec 校验；单元测试覆盖）。
 *
 * 设计依据《Claude-Dashboards-需求文档.docx》：
 * - 输入是问题句（"想知道什么"），不是图表类型；
 * - 每张图绑定一条可查看的只读 SQL + 口径说明；
 * - 修订 = 携带上一版 spec 重新生成。
 */
import { z } from "zod";
import type { DbBoardChartSpec, DbBoardColumnMeta, DbBoardDashboardSpec } from "./dbBoard.js";
import { validateDashboardSqlHead } from "./dbBoardSql.js";

export const DB_BOARD_DASHBOARD_QUERY_SOURCE = "db_board_dashboard";
export const DB_BOARD_EXPLAIN_QUERY_SOURCE = "db_board_explain_query";

const CHART_TYPES = ["bar", "line", "pie", "kpi", "table"] as const;

/** 模型被要求输出的草稿结构（不含 id 等本地元数据）。 */
const draftChartSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(CHART_TYPES),
  sql: z.string().min(1),
  description: z.string().max(500).optional(),
  dimension: z.string().max(200).optional(),
  measures: z.array(z.string().max(200)).max(8).optional(),
});

const draftDashboardSchema = z.object({
  title: z.string().min(1).max(200),
  charts: z.array(draftChartSchema).min(1).max(8),
});

export type DbBoardDashboardDraft = z.infer<typeof draftDashboardSchema>;

/** 已定稿 spec（持久化与 wire 传输）的 zod 校验。 */
export const dbBoardChartSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  type: z.enum(CHART_TYPES),
  sql: z.string().min(1),
  description: z.string().max(500).optional(),
  columnHints: z
    .object({
      dimension: z.string().max(200).optional(),
      measures: z.array(z.string().max(200)).max(8).optional(),
    })
    .optional(),
});

export const dbBoardDashboardSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(2000),
  charts: z.array(dbBoardChartSpecSchema).min(1).max(8),
  revisionHistory: z.array(z.string().max(2000)).max(50),
  updatedAt: z.string().min(1),
});

// ============================================================================
// 元数据摘要
// ============================================================================

export interface DbBoardPromptTable {
  schema: string;
  name: string;
  columns: readonly DbBoardColumnMeta[];
}

/** 表/列元数据 → prompt 文本行；超出字符预算时截断并提示点名表。 */
export function summarizeTablesForPrompt(
  tables: readonly DbBoardPromptTable[],
  maxChars = 16_000,
): string {
  const lines: string[] = [];
  let total = 0;
  let truncated = false;
  for (const table of tables) {
    const columnText = table.columns
      .map((column) => {
        const flags = [
          column.isPrimaryKey ? "PK" : null,
          column.nullable ? null : "NOT NULL",
        ].filter(Boolean);
        return `${column.name} ${column.dataType}${flags.length ? `(${flags.join(",")})` : ""}`;
      })
      .join(", ");
    const line = `- ${table.schema}.${table.name}(${columnText})`;
    if (total + line.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  if (truncated) {
    lines.push(`- ...（表过多已截断，可在问题中点名具体表）`);
  }
  return lines.join("\n");
}

// ============================================================================
// Prompt 构建
// ============================================================================

export function buildDashboardGenerationPrompt(params: {
  tables: readonly DbBoardPromptTable[];
  question: string;
  previousSpec?: DbBoardDashboardSpec;
  revisionNote?: string;
  /** 知识库注入：选中表的业务知识卡片（Step A 产物）。 */
  knowledgeCards?: string;
}): string {
  const knowledgeMode = Boolean(params.knowledgeCards);
  const tableSummary = summarizeTablesForPrompt(
    params.tables,
    knowledgeMode ? 4_000 : 16_000,
  );
  const revisionBlock =
    params.previousSpec && params.revisionNote
      ? [
          "当前看板定义（JSON，将按用户修订指令更新它）：",
          JSON.stringify(
            {
              title: params.previousSpec.title,
              charts: params.previousSpec.charts.map((chart) => ({
                title: chart.title,
                type: chart.type,
                sql: chart.sql,
                ...(chart.description ? { description: chart.description } : {}),
              })),
            },
            null,
            1,
          ),
          `用户修订指令：${params.revisionNote}`,
          "按修订指令调整相关图表的 SQL 与定义，未涉及的图表原样保留。",
        ].join("\n")
      : "";

  return [
    "你是数据库看板生成器。根据数据库表结构与用户问题，产出一个看板定义。",
    "",
    "硬性要求：",
    "- 每张图一条只读 SELECT（禁止 INSERT/UPDATE/DELETE/DDL/事务语句）。",
    "- SQL 只能使用下方列出的表和列；聚合优先，结果行数控制在 1000 行以内。",
    "- 面向问题句作答：图表类型由你选择（bar/line/pie/kpi/table），kpi 用于单个关键数字。",
    "- 每张图给一句 description：它在数什么、统计口径是什么。",
    "- 时间趋势用 date_trunc 归并粒度；分类对比用 GROUP BY；占比用 pie。",
    "- 该库部分时间列以字符串存储（varchar）：date_trunc/比较前必须显式转换，如 written_time::timestamp。",
    "- SQL 末尾不要写分号；单条语句。",
    "- title/description 的语言跟随用户问题。",
    "- 只输出 JSON，不要输出其它文字。",
    "",
    "输出 JSON 结构：",
    '{"title":"看板标题","charts":[{"title":"图标题","type":"bar|line|pie|kpi|table","sql":"SELECT ...","description":"口径说明","dimension":"维度列名(可选)","measures":["度量列名"]}]}',
    "",
    params.knowledgeCards
      ? [
          "业务知识卡片（以下表已经确认与用户问题相关，优先使用；卡片中的「表关联」给出可用的 JOIN 条件）：",
          params.knowledgeCards,
        ].join("\n")
      : "",
    "数据库类型：PostgreSQL 兼容（KingbaseES）。",
    params.knowledgeCards
      ? "全库表结构索引（补充参考，仅当知识卡片不足以回答时使用）："
      : "可用表结构（schema.table(列 类型)）：",
    tableSummary || "-（无可用表）",
    "",
    params.previousSpec && params.revisionNote ? revisionBlock : `用户问题：${params.question}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildExplainQueryPrompt(params: {
  sql: string;
  chartTitle: string;
  question?: string;
}): string {
  return [
    "解释下面这条看板查询在数什么。用 2-4 句话说明：数据来源（表）、统计口径（过滤/分组/聚合方式）、结果列含义。语言跟随用户问题。",
    params.question ? `它要回答的问题：${params.question}` : "",
    `图表标题：${params.chartTitle}`,
    "",
    "SQL：",
    params.sql,
  ]
    .filter(Boolean)
    .join("\n");
}

// ============================================================================
// 模型输出解析
// ============================================================================

/** 剥离代码围栏与前后杂文，截取第一个 { 到最后一个 } 之间的 JSON 文本。 */
export function extractJsonObjectText(raw: string): string | null {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text);
  if (fenced?.[1]) {
    text = fenced[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

export function parseDashboardDraft(raw: string):
  | { ok: true; draft: DbBoardDashboardDraft }
  | { ok: false; reason: string } {
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
  const draft = draftDashboardSchema.safeParse(parsed);
  if (!draft.success) {
    return { ok: false, reason: `结构校验失败: ${draft.error.issues[0]?.message ?? "unknown"}` };
  }
  return { ok: true, draft: draft.data };
}

/** 校验草稿中每条 SQL 的语句头；全部非法才判 invalid。 */
export function draftSqlValidation(draft: DbBoardDashboardDraft):
  | { ok: true }
  | { ok: false; reason: string } {
  const invalid: string[] = [];
  for (const chart of draft.charts) {
    const validation = validateDashboardSqlHead(chart.sql);
    if (!validation.ok) {
      invalid.push(`${chart.title}: ${validation.reason}`);
    }
  }
  if (invalid.length === draft.charts.length && draft.charts.length > 0) {
    return { ok: false, reason: invalid.join("; ") };
  }
  return { ok: true };
}

/** 草稿 → 定稿 spec（过滤 SQL 非法的图；无 id 图表补随机 id）。 */
export function finalizeDashboardSpec(
  draft: DbBoardDashboardDraft,
  params: {
    id: string;
    question: string;
    previousSpec?: DbBoardDashboardSpec;
    revisionNote?: string;
    now: string;
    newChartId: () => string;
  },
): DbBoardDashboardSpec {
  const charts: DbBoardChartSpec[] = [];
  for (const chart of draft.charts) {
    if (!validateDashboardSqlHead(chart.sql).ok) {
      continue;
    }
    charts.push({
      id: params.newChartId(),
      title: chart.title,
      type: chart.type,
      sql: chart.sql,
      ...(chart.description ? { description: chart.description } : {}),
      ...(chart.dimension || chart.measures?.length
        ? {
            columnHints: {
              ...(chart.dimension ? { dimension: chart.dimension } : {}),
              ...(chart.measures?.length ? { measures: chart.measures } : {}),
            },
          }
        : {}),
    });
  }
  if (charts.length === 0) {
    throw new Error("生成的看板没有可执行的图表");
  }
  const revisionHistory = params.previousSpec
    ? [...params.previousSpec.revisionHistory, params.revisionNote ?? ""].filter(Boolean).slice(-50)
    : [params.question];
  return {
    id: params.id,
    title: draft.title,
    question: params.previousSpec?.question ?? params.question,
    charts,
    revisionHistory,
    updatedAt: params.now,
  };
}
