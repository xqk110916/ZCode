/* eslint-disable max-lines -- 14 个工具共享同一分发上下文、schema 组与展示辅助；
 * 拆散会让工具注册表跨多文件拼装，与 dbBoardService.ts 同口径保留单文件。 */
import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/server";
import type { IDbBoardService } from "../dbBoard/dbBoard.js";
import type {
  DbBoardKnowledgeTableCard,
  IDbBoardKnowledgeService,
} from "../dbBoardKnowledge/dbBoardKnowledge.js";
import { DB_BOARD_BINARY_MARKER_PREFIX } from "../dbBoard/dbBoardSql.js";

/**
 * 数据库助手的 MCP 工具面：包装既有 IDbBoardService / IDbBoardKnowledgeService。
 *
 * 输出统一为 markdown 文本（模型直接消费）。安全不变量（见 specs/services/db-board-agent.md）：
 * - 没有删除/回退/连接管理工具；
 * - 只读 SQL 的强制项在 dbBoardService.runDashboardSql 服务端执行；
 * - 写入 operator 由宿主注入，不接受调用方参数。
 */

export interface DbBoardAgentToolContext {
  dbBoardService: IDbBoardService;
  dbBoardKnowledgeService: IDbBoardKnowledgeService;
  /** 审计 operator 前缀的用户名（宿主注入）。 */
  getOperatorUsername(): string;
}

export interface DbBoardAgentTool {
  name: string;
  description: string;
  /** JSON Schema（MCP tools/list 原样下发）。 */
  inputSchema: Tool["inputSchema"];
  handler: (args: Record<string, unknown>) => Promise<string>;
}

// ============================================================================
// 展示辅助
// ============================================================================

const CELL_MAX_CHARS = 80;
const MARKDOWN_MAX_ROWS = 30;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") {
    if (value.startsWith(DB_BOARD_BINARY_MARKER_PREFIX)) return "<二进制>";
    const flattened = value.replace(/\s+/g, " ").trim();
    return flattened.length > CELL_MAX_CHARS
      ? `${flattened.slice(0, CELL_MAX_CHARS)}…`
      : flattened || '""';
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > CELL_MAX_CHARS ? `${text.slice(0, CELL_MAX_CHARS)}…` : text;
  }
  return String(value);
}

function rowsToMarkdown(columns: string[], rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "（无数据行）";
  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((c) => formatCell(row[c])).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function clipRows(rows: Array<Record<string, unknown>>): {
  shown: Array<Record<string, unknown>>;
  clippedNote: string;
} {
  if (rows.length <= MARKDOWN_MAX_ROWS) return { shown: rows, clippedNote: "" };
  return {
    shown: rows.slice(0, MARKDOWN_MAX_ROWS),
    clippedNote: `\n（仅展示前 ${MARKDOWN_MAX_ROWS} 行，共 ${rows.length} 行；需要更多请分页或收窄条件）`,
  };
}

function escapePipe(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function formatTableCard(card: DbBoardKnowledgeTableCard): string {
  const lines = [
    `### ${card.table}（域：${card.domain}）`,
    `用途：${card.purpose}`,
  ];
  if (card.keyColumns.length > 0) {
    lines.push("关键字段：");
    for (const column of card.keyColumns) lines.push(`- ${column.name}：${column.meaning}`);
  }
  if (card.relations.length > 0) {
    lines.push("关联关系：");
    for (const relation of card.relations) {
      lines.push(`- → ${relation.target}${relation.on ? ` ON ${relation.on}` : ""}${relation.kind ? `（${relation.kind}）` : ""}`);
    }
  }
  if (card.notes) lines.push(`备注：${card.notes}`);
  lines.push(`来源：${card.source}`);
  return lines.join("\n");
}

/** 知识卡按表名匹配（大小写不敏感；容忍 schema.table 形式的输入）。 */
function findKnowledgeCard(
  knowledge: { tables: Record<string, DbBoardKnowledgeTableCard> } | null,
  table: string,
): DbBoardKnowledgeTableCard | undefined {
  if (!knowledge) return undefined;
  const bare = table.includes(".") ? table.split(".").slice(1).join(".") : table;
  const lower = bare.trim().toLowerCase();
  for (const [key, card] of Object.entries(knowledge.tables)) {
    const keyBare = key.includes(".") ? key.split(".").slice(1).join(".") : key;
    if (keyBare.trim().toLowerCase() === lower) return card;
  }
  return undefined;
}

// ============================================================================
// 工具 schema
// ============================================================================

const listTablesArgs = z
  .object({ force: z.boolean().optional() })
  .strict();

const getTableColumnsArgs = z
  .object({ schema: z.string().min(1), table: z.string().min(1) })
  .strict();

const queryRowsArgs = z
  .object({
    schema: z.string().min(1),
    table: z.string().min(1),
    search_column: z.string().min(1).optional(),
    search_value: z.string().optional(),
    page: z.number().int().min(1).max(1_000_000).optional(),
    page_size: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const runReadonlySqlArgs = z
  .object({
    sql: z.string().min(1).max(20_000),
    max_rows: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

const getTableCardArgs = z
  .object({ table: z.string().min(1) })
  .strict();

const searchKnowledgeArgs = z
  .object({ keywords: z.string().min(1).max(500) })
  .strict();

const insertRowArgs = z
  .object({
    schema: z.string().min(1),
    table: z.string().min(1),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

const updateRowArgs = z
  .object({
    schema: z.string().min(1),
    table: z.string().min(1),
    pk: z.record(z.string(), z.unknown()),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

const generateDashboardArgs = z
  .object({
    question: z.string().min(1).max(2000),
    previous_dashboard_id: z.string().min(1).optional(),
    revision_note: z.string().min(1).max(2000).optional(),
  })
  .strict();

const chartSpecArgs = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    type: z.enum(["bar", "line", "pie", "kpi", "table"]),
    sql: z.string().min(1),
    description: z.string().optional(),
    column_hints: z
      .object({ dimension: z.string().optional(), measures: z.array(z.string()).optional() })
      .optional(),
  })
  .strict();

const saveDashboardArgs = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    question: z.string().min(1),
    charts: z.array(chartSpecArgs).min(1),
    revision_history: z.array(z.string()).optional(),
  })
  .strict();

const distillTableCardArgs = z
  .object({ schema: z.string().min(1), table: z.string().min(1) })
  .strict();

const saveTableCardArgs = z
  .object({
    table: z.string().min(1),
    domain: z.string().min(1),
    purpose: z.string().min(1),
    key_columns: z
      .array(z.object({ name: z.string().min(1), meaning: z.string() }))
      .default([]),
    relations: z
      .array(
        z.object({
          target: z.string().min(1),
          on: z.string().optional(),
          kind: z.string().optional(),
        }),
      )
      .default([]),
    notes: z.string().optional(),
  })
  .strict();

const listOpLogsArgs = z
  .object({
    schema: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
    page: z.number().int().min(1).max(1_000_000).optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  })
  .strict();

// ============================================================================
// 工具定义
// ============================================================================

export function createDbBoardAgentTools(ctx: DbBoardAgentToolContext): DbBoardAgentTool[] {
  const { dbBoardService, dbBoardKnowledgeService } = ctx;
  const operator = () => `${ctx.getOperatorUsername()} via db-agent`;

  return [
    {
      name: "list_tables",
      description:
        "列出当前连接下的所有表（含中文注释与知识域分组）。回答业务问题前先看这里与 search_knowledge，" +
        "结合知识卡选表。返回按业务域分组的表清单；无知识卡时按 schema 分组。",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean", description: "true 时强制回源刷新缓存（默认 false）" },
        },
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = listTablesArgs.parse(raw);
        const [tables, knowledge] = await Promise.all([
          dbBoardService.listTables(args.force ?? false),
          dbBoardKnowledgeService.getKnowledge(),
        ]);
        const header = `共 ${tables.length} 张表。`;
        if (knowledge) {
          const byDomain = new Map<string, typeof tables>();
          const ungrouped: typeof tables = [];
          for (const table of tables) {
            const card = findKnowledgeCard(knowledge, table.name);
            if (card) {
              const list = byDomain.get(card.domain) ?? [];
              list.push(table);
              byDomain.set(card.domain, list);
            } else {
              ungrouped.push(table);
            }
          }
          const sections = [`共 ${tables.length} 张表（知识库覆盖 ${tables.length - ungrouped.length} 张，域 ${byDomain.size} 个）。`];
          for (const [domain, domainTables] of byDomain) {
            sections.push(
              `### ${domain}\n${domainTables
                .map((t) => `- ${t.schema}.${t.name}${t.comment ? `：${t.comment}` : ""}`)
                .join("\n")}`,
            );
          }
          if (ungrouped.length > 0) {
            sections.push(
              `### （无知识卡）\n${ungrouped
                .map((t) => `- ${t.schema}.${t.name}${t.comment ? `：${t.comment}` : ""}`)
                .join("\n")}`,
            );
          }
          return sections.join("\n\n");
        }
        return [
          header,
          ...Object.entries(
            tables.reduce<Record<string, typeof tables>>((acc, table) => {
              const list = acc[table.schema] ?? [];
              list.push(table);
              acc[table.schema] = list;
              return acc;
            }, {}),
          ).map(
            ([schema, schemaTables]) =>
              `### ${schema}\n${schemaTables
                .map((t) => `- ${t.name}${t.comment ? `：${t.comment}` : ""}`)
                .join("\n")}`,
          ),
        ].join("\n\n");
      },
    },
    {
      name: "get_table_columns",
      description:
        "获取表的列元数据：列名、类型、可空、主键、默认值与中文注释。写 SQL 前先看列类型，" +
        "varchar 存储的时间列做时间比较时必须显式 ::timestamp 转换。",
      inputSchema: {
        type: "object",
        properties: {
          schema: { type: "string" },
          table: { type: "string" },
        },
        required: ["schema", "table"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = getTableColumnsArgs.parse(raw);
        const columns = await dbBoardService.getTableColumns(args.schema, args.table);
        return [
          `${args.schema}.${args.table} 共 ${columns.length} 列：`,
          rowsToMarkdown(
            ["列", "类型", "可空", "主键", "默认值", "注释"],
            columns.map((column) => ({
              列: column.name,
              类型: column.dataType,
              可空: column.nullable ? "是" : "否",
              主键: column.isPrimaryKey ? "是" : "",
              默认值: column.hasDefault ? "有" : "",
              注释: column.comment ?? "",
            })),
          ),
        ].join("\n");
      },
    },
    {
      name: "query_rows",
      description:
        "分页浏览表数据（支持单列模糊搜索 ILIKE %value%）。适合快速看几行样例；" +
        "需要精确 WHERE 条件、排序、聚合时改用 run_readonly_sql。",
      inputSchema: {
        type: "object",
        properties: {
          schema: { type: "string" },
          table: { type: "string" },
          search_column: { type: "string", description: "搜索目标列名（先用 get_table_columns 确认存在）" },
          search_value: { type: "string", description: "模糊匹配值" },
          page: { type: "number", description: "页码，从 1 开始（默认 1）" },
          page_size: { type: "number", description: "每页行数 1-200（默认 20）" },
        },
        required: ["schema", "table"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = queryRowsArgs.parse(raw);
        const result = await dbBoardService.queryRows({
          schema: args.schema,
          table: args.table,
          page: args.page ?? 1,
          pageSize: args.page_size ?? 20,
          ...(args.search_column ? { searchColumn: args.search_column } : {}),
          ...(args.search_value !== undefined ? { searchValue: args.search_value } : {}),
        });
        const { shown, clippedNote } = clipRows(result.rows);
        return [
          `${args.schema}.${args.table} 第 ${result.page} 页（每页 ${result.pageSize}，共 ${result.total} 行）：`,
          rowsToMarkdown(
            result.columns.map((column) => column.name),
            shown,
          ),
          clippedNote,
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "run_readonly_sql",
      description:
        "执行只读 SELECT 查询（服务端强制：READ ONLY 事务、单条 SELECT 语句包装、statement_timeout、行上限 1000）。" +
        "适用于精确过滤、JOIN、聚合。注意：varchar 存储的时间列与时间字面量比较时必须 ::timestamp 显式转换，" +
        "否则会全表扫描或语法错误；表名/列名以 list_tables / get_table_columns 为准。",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "单条 SELECT 语句（不含分号结尾的多语句）" },
          max_rows: { type: "number", description: "返回展示的最大行数 1-1000（默认 100；超出仅截断展示）" },
        },
        required: ["sql"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = runReadonlySqlArgs.parse(raw);
        const result = await dbBoardService.runDashboardSql(args.sql);
        const maxRows = args.max_rows ?? 100;
        const shown = result.rows.slice(0, maxRows);
        const notes = [
          `返回 ${result.rowCount} 行${result.truncated ? "（达到行上限被截断，请收窄条件）" : ""}，耗时 ${result.elapsedMs}ms。`,
          shown.length < result.rows.length ? `（展示前 ${shown.length} 行）` : "",
        ];
        return [
          ...notes.filter(Boolean),
          rowsToMarkdown(
            result.columns.map((column) => column.name),
            shown,
          ),
        ].join("\n");
      },
    },
    {
      name: "get_table_card",
      description:
        "获取一张表的项目业务知识卡：中文用途、关键字段含义、表关联、备注（来自后端实体/Mapper/DDL/前端代码蒸馏）。" +
        "回答业务问题前优先查这张卡，确认表选对了再写 SQL。",
      inputSchema: {
        type: "object",
        properties: { table: { type: "string", description: "表名（可带或不带 schema 前缀）" } },
        required: ["table"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = getTableCardArgs.parse(raw);
        const knowledge = await dbBoardKnowledgeService.getKnowledge();
        const card = findKnowledgeCard(knowledge, args.table);
        if (card) return formatTableCard(card);
        const tables = await dbBoardService.listTables();
        const match = tables.find(
          (table) => table.name.toLowerCase() === args.table.split(".").pop()?.toLowerCase(),
        );
        return match?.comment
          ? `「${args.table}」没有知识卡。数据库表注释：${match.comment}。可用 distill_table_card 现场蒸馏，或结合列注释判断。`
          : `「${args.table}」没有知识卡，也没有数据库表注释。可用 get_table_columns 看列注释，或 distill_table_card 现场蒸馏。`;
      },
    },
    {
      name: "search_knowledge",
      description:
        "按关键词检索项目知识库（匹配业务域、表名、表用途、关键字段含义）。" +
        "业务问题（如「今年的收发文」）先来这里找对应的域和表，再深入 get_table_card。",
      inputSchema: {
        type: "object",
        properties: { keywords: { type: "string", description: "空格分隔的多个关键词" } },
        required: ["keywords"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = searchKnowledgeArgs.parse(raw);
        const knowledge = await dbBoardKnowledgeService.getKnowledge();
        if (!knowledge) return "知识库尚未构建。可引导我在「数据库看板 → 知识库」注册项目并构建；在此之前用 list_tables + 表注释判断。";
        const terms = args.keywords.toLowerCase().split(/\s+/).filter(Boolean);
        const scoreCard = (card: DbBoardKnowledgeTableCard): number => {
          const haystack = [
            card.domain,
            card.table,
            card.purpose,
            card.notes ?? "",
            ...card.keyColumns.map((column) => `${column.name} ${column.meaning}`),
          ]
            .join("\n")
            .toLowerCase();
          return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        };
        const matched = Object.values(knowledge.tables)
          .map((card) => ({ card, score: scoreCard(card) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 30);
        if (matched.length === 0) {
          const domains = Object.entries(knowledge.domains)
            .map(([domain, tables]) => `- ${domain}：${tables.slice(0, 5).join("、")}${tables.length > 5 ? " 等" : ""}`)
            .join("\n");
          return `没有命中「${args.keywords}」。现有业务域：\n${domains}`;
        }
        return [
          `命中 ${matched.length} 张表（按相关度排序）：`,
          ...matched.map(
            (entry, index) =>
              `${index + 1}. ${entry.card.table}（域：${entry.card.domain}）— ${entry.card.purpose}`,
          ),
          "",
          "用 get_table_card 查看完整知识卡。",
        ].join("\n");
      },
    },
    {
      name: "insert_row",
      description:
        "向表插入一行（同事务写审计日志）。调用前必须已在对话中向用户展示完整新值预览并获得明确确认。" +
        "values 键为列名（先经 get_table_columns 确认），值为 JSON 值（多为字符串，服务端按列类型推断）；" +
        "有默认值/自增的列可省略。操作者由服务端固定记录，不接受参数指定。",
      inputSchema: {
        type: "object",
        properties: {
          schema: { type: "string" },
          table: { type: "string" },
          values: { type: "object", description: "列名 → 新值" },
        },
        required: ["schema", "table", "values"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = insertRowArgs.parse(raw);
        const result = await dbBoardService.insertRow({
          schema: args.schema,
          table: args.table,
          values: args.values,
          operator: operator(),
        });
        return [
          `已插入 ${args.schema}.${args.table} 1 行（审计日志 #${result.logId}，操作者 ${operator()}）。`,
          rowsToMarkdown(Object.keys(result.row), [result.row]),
          "如需撤销，请在「数据库看板 → 操作日志」中回退该条记录。",
        ].join("\n");
      },
    },
    {
      name: "update_row",
      description:
        "按主键修改一行（同事务写审计日志）。调用前必须已在对话中向用户展示目标行当前值与新旧值对比并获得明确确认。" +
        "pk 必须覆盖全部主键列（用 query_rows 或 run_readonly_sql 查出主键值）；values 只含待修改列。",
      inputSchema: {
        type: "object",
        properties: {
          schema: { type: "string" },
          table: { type: "string" },
          pk: { type: "object", description: "主键列 → 值（必须覆盖全部主键列）" },
          values: { type: "object", description: "待修改列 → 新值（不含主键列）" },
        },
        required: ["schema", "table", "pk", "values"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = updateRowArgs.parse(raw);
        const result = await dbBoardService.updateRow({
          schema: args.schema,
          table: args.table,
          pk: args.pk,
          values: args.values,
          operator: operator(),
        });
        return [
          `已修改 ${args.schema}.${args.table} 1 行（审计日志 #${result.logId}，操作者 ${operator()}）。`,
          `修改后整行：`,
          rowsToMarkdown(Object.keys(result.row), [result.row]),
          "如需撤销，请在「数据库看板 → 操作日志」中回退该条记录。",
        ].join("\n");
      },
    },
    {
      name: "generate_dashboard",
      description:
        "根据业务问题生成探索看板（多个图表，每个含只读 SELECT）。修订已有看板时传 previous_dashboard_id 与 revision_note。" +
        "返回 spec 摘要与完整 JSON（保存时原样传给 save_dashboard）。生成依赖模型链路，可能需要数十秒。",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "看板要回答的业务问题（修订时也传原问题或新表述）" },
          previous_dashboard_id: { type: "string", description: "修订模式：已有看板 id" },
          revision_note: { type: "string", description: "修订指令（如「把时间范围改为最近三个月」）" },
        },
        required: ["question"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = generateDashboardArgs.parse(raw);
        let previousSpec;
        if (args.previous_dashboard_id) {
          previousSpec =
            (await dbBoardService.getDashboard(args.previous_dashboard_id)) ?? undefined;
          if (!previousSpec) return `看板 ${args.previous_dashboard_id} 不存在，无法修订；可用 list_dashboards 查看已有看板。`;
        }
        const result = await dbBoardService.generateDashboard({
          question: args.question,
          ...(previousSpec ? { previousSpec } : {}),
          ...(args.revision_note ? { revisionNote: args.revision_note } : {}),
        });
        const summary = [
          `看板「${result.spec.title}」：${result.spec.charts.length} 个图表。`,
          ...result.spec.charts.map(
            (chart, index) =>
              `${index + 1}. 【${chart.type}】${chart.title}${chart.description ? ` — ${chart.description}` : ""}\nSQL：\n\`\`\`sql\n${chart.sql}\n\`\`\``,
          ),
          "请向用户展示每个图表的 SQL 与口径，确认后调用 save_dashboard 保存。",
          "完整 spec JSON（保存时原样传入 save_dashboard 的 spec 参数）：",
          "```json",
          JSON.stringify(result.spec),
          "```",
        ];
        if (result.modelInfo) {
          summary.push(`（生成模型：${result.modelInfo.providerId}/${result.modelInfo.modelId}）`);
        }
        return summary.join("\n");
      },
    },
    {
      name: "save_dashboard",
      description: "保存探索看板定义（用户在对话确认后调用；spec 来自 generate_dashboard 返回的 JSON，不要手工拼改）。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          question: { type: "string" },
          charts: { type: "array", description: "图表数组（来自 generate_dashboard 的 spec.charts）" },
          revision_history: { type: "array", items: { type: "string" } },
        },
        required: ["id", "title", "question", "charts"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = saveDashboardArgs.parse(raw);
        const now = new Date().toISOString();
        const spec = {
          id: args.id,
          title: args.title,
          question: args.question,
          charts: args.charts.map((chart) => ({
            id: chart.id,
            title: chart.title,
            type: chart.type,
            sql: chart.sql,
            ...(chart.description ? { description: chart.description } : {}),
            ...(chart.column_hints
              ? {
                  columnHints: {
                    ...(chart.column_hints.dimension ? { dimension: chart.column_hints.dimension } : {}),
                    ...(chart.column_hints.measures ? { measures: chart.column_hints.measures } : {}),
                  },
                }
              : {}),
          })),
          revisionHistory: args.revision_history ?? [args.question],
          updatedAt: now,
        };
        const saved = await dbBoardService.saveDashboard(spec);
        return `看板「${saved.title}」已保存（${saved.charts.length} 个图表）。用户可在「数据库看板 → 探索看板」查看。`;
      },
    },
    {
      name: "list_dashboards",
      description: "列出已保存的探索看板（id、标题、图表数、更新时间）。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        const dashboards = await dbBoardService.listDashboards();
        if (dashboards.length === 0) return "还没有已保存的看板。可用 generate_dashboard 生成。";
        return dashboards
          .map(
            (dashboard) =>
              `- ${escapePipe(dashboard.title)}（${dashboard.chartCount} 图，更新于 ${dashboard.updatedAt}，id：${dashboard.id}）`,
          )
          .join("\n");
      },
    },
    {
      name: "distill_table_card",
      description:
        "现场蒸馏一张表的知识卡（汇集数据库注释与既有卡片，一次模型调用；不落盘）。耗时可能 1-2 分钟，仅在用户明确要求时调用。" +
        "返回的卡片内容经用户确认后用 save_table_card 保存。",
      inputSchema: {
        type: "object",
        properties: { schema: { type: "string" }, table: { type: "string" } },
        required: ["schema", "table"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = distillTableCardArgs.parse(raw);
        const card = await dbBoardKnowledgeService.distillTableCard({
          schema: args.schema,
          table: args.table,
        });
        return [formatTableCard(card), "", "（草稿未保存；确认后用 save_table_card 保存）"].join("\n");
      },
    },
    {
      name: "save_table_card",
      description: "保存一张表的知识卡到项目知识库（用户在对话中确认蒸馏结果后调用）。",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string" },
          domain: { type: "string", description: "业务域（如「收发文」「用户组织」）" },
          purpose: { type: "string", description: "表的中文业务用途（一句话）" },
          key_columns: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, meaning: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: { target: { type: "string" }, on: { type: "string" }, kind: { type: "string" } },
              required: ["target"],
              additionalProperties: false,
            },
          },
          notes: { type: "string" },
        },
        required: ["table", "domain", "purpose"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = saveTableCardArgs.parse(raw);
        await dbBoardKnowledgeService.saveTableCard({
          table: args.table,
          domain: args.domain,
          purpose: args.purpose,
          keyColumns: args.key_columns,
          relations: args.relations,
          ...(args.notes ? { notes: args.notes } : {}),
          evidenceFiles: [],
          source: "distilled",
        });
        return `「${args.table}」知识卡已保存（域：${args.domain}）。`;
      },
    },
    {
      name: "list_op_logs",
      description:
        "查看审计日志（所有 insert/update 写入记录，含操作者与状态）。用于回答「刚才改了什么」「谁改的」。回退操作本身不可通过本工具执行。",
      inputSchema: {
        type: "object",
        properties: {
          schema: { type: "string" },
          table: { type: "string" },
          page: { type: "number", description: "页码，从 1 开始（默认 1）" },
          page_size: { type: "number", description: "每页 1-100（默认 20）" },
        },
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = listOpLogsArgs.parse(raw);
        const result = await dbBoardService.listOpLogs({
          ...(args.schema ? { schema: args.schema } : {}),
          ...(args.table ? { table: args.table } : {}),
          page: args.page ?? 1,
          pageSize: args.page_size ?? 20,
        });
        const { shown, clippedNote } = clipRows(
          result.entries.map((entry) => ({
            id: entry.id,
            时间: entry.createdAt,
            操作者: entry.operator,
            操作: entry.opType,
            表: `${entry.schemaName}.${entry.tableName}`,
            主键: Object.entries(entry.pk)
              .map(([key, value]) => `${key}=${formatCell(value)}`)
              .join(","),
            状态: entry.status === "active" ? "有效" : `已回退(${entry.rolledBackAt ?? ""})`,
          })),
        );
        return [
          `审计日志第 ${result.page} 页（共 ${result.total} 条）：`,
          rowsToMarkdown(
            ["id", "时间", "操作者", "操作", "表", "主键", "状态"],
            shown,
          ),
          clippedNote,
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
  ];
}
