import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IDbBoardService } from "../src/dbBoard/dbBoard.js";
import type {
  DbBoardKnowledge,
  DbBoardKnowledgeTableCard,
  IDbBoardKnowledgeService,
} from "../src/dbBoardKnowledge/dbBoardKnowledge.js";
import { buildDbBoardAgentPreamble } from "../src/dbBoardAgent/dbBoardAgentPrompt.js";
import { createDbBoardAgentTools } from "../src/dbBoardAgent/dbBoardAgentTools.js";

function fakeCard(overrides: Partial<DbBoardKnowledgeTableCard>): DbBoardKnowledgeTableCard {
  return {
    table: "oa_doc",
    domain: "收发文",
    purpose: "收发文单据主表",
    keyColumns: [{ name: "doc_no", meaning: "文号" }],
    relations: [{ target: "xt_user", on: "oa_doc.create_by = xt_user.id", kind: "many-to-one" }],
    evidenceFiles: [],
    source: "distilled",
    ...overrides,
  };
}

function makeContext(overrides?: {
  dbBoard?: Partial<IDbBoardService>;
  knowledge?: DbBoardKnowledge | null;
  username?: string;
  knowledgeService?: Partial<IDbBoardKnowledgeService>;
}): { tools: ReturnType<typeof createDbBoardAgentTools>; operatorsRef: string[] } {
  const operators: string[] = [];
  let username = overrides?.username ?? "tester";
  const dbBoard = {
    listTables: async () => [
      { schema: "public", name: "oa_doc", hasPrimaryKey: true, columnCount: 5, queryOnly: false, comment: "收发文" },
      { schema: "public", name: "xt_user", hasPrimaryKey: true, columnCount: 3, queryOnly: false },
    ],
    getTableColumns: async () => [],
    queryRows: async () => ({ columns: [], rows: [], total: 0, page: 1, pageSize: 20 }),
    runDashboardSql: async () => ({ columns: [{ name: "n" }], rows: [{ n: 1 }], rowCount: 1, truncated: false, elapsedMs: 3 }),
    insertRow: async (params: { operator: string }) => {
      operators.push(params.operator);
      return { row: { id: 1 }, logId: 9 };
    },
    updateRow: async (params: { operator: string }) => {
      operators.push(params.operator);
      return { row: { id: 1 }, logId: 10 };
    },
    listOpLogs: async () => ({ entries: [], total: 0, page: 1, pageSize: 20 }),
    generateDashboard: async () => ({
      spec: {
        id: "d1",
        title: "收发文统计",
        question: "q",
        charts: [{ id: "c1", title: "按月", type: "bar", sql: "SELECT 1" }],
        revisionHistory: ["q"],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    }),
    getDashboard: async () => null,
    saveDashboard: async (spec: unknown) => spec,
    listDashboards: async () => [],
    getConnectionState: async () => ({ state: "connected", config: null }),
    ...overrides?.dbBoard,
  } as unknown as IDbBoardService;
  const knowledge = {
    getKnowledge: async () => overrides?.knowledge === undefined ? null : overrides.knowledge,
    distillTableCard: async () =>
      fakeCard({ source: "distilled" }),
    saveTableCard: async () => undefined,
    ...overrides?.knowledgeService,
  } as unknown as IDbBoardKnowledgeService;
  return {
    tools: createDbBoardAgentTools({
      dbBoardService: dbBoard,
      dbBoardKnowledgeService: knowledge,
      getOperatorUsername: () => username,
    }),
    get operatorsRef() {
      return operators;
    },
    set username(value: string) {
      username = value;
    },
  };
}

describe("dbBoardAgent tools", () => {
  it("list_tables 按知识域分组，未覆盖表落到无知识卡分组", async () => {
    const knowledge: DbBoardKnowledge = {
      version: 1,
      builtAt: "2026-01-01T00:00:00Z",
      domains: { 收发文: ["oa_doc"] },
      tables: { oa_doc: fakeCard({}) },
      repoSnapshots: [],
      stats: { tableCount: 1, domainCount: 1, distilled: 1, extracted: 0, dbCommentOnly: 0 },
    };
    const ctx = makeContext({ knowledge });
    const tool = ctx.tools.find((t) => t.name === "list_tables")!;
    const text = await tool.handler({});
    assert.match(text, /### 收发文/);
    assert.match(text, /oa_doc：收发文/);
    assert.match(text, /（无知识卡）/);
    assert.match(text, /知识库覆盖 1 张/);
  });

  it("insert_row / update_row 的 operator 由宿主注入，参数走私被 schema 拒绝", async () => {
    const ctx = makeContext({ username: "alice" });
    const insert = ctx.tools.find((t) => t.name === "insert_row")!;
    await assert.rejects(
      () => insert.handler({ schema: "public", table: "oa_doc", values: { doc_no: "1" }, operator: "evil" }),
      /Unrecognized key/,
    );
    await insert.handler({ schema: "public", table: "oa_doc", values: { doc_no: "1" } });
    const update = ctx.tools.find((t) => t.name === "update_row")!;
    await update.handler({ schema: "public", table: "oa_doc", pk: { id: 1 }, values: {} });
    assert.deepEqual(ctx.operatorsRef, ["alice via db-agent", "alice via db-agent"]);
  });

  it("run_readonly_sql 展示行数与耗时，超过展示上限截断", async () => {
    const ctx = makeContext({
      dbBoard: {
        runDashboardSql: async () => ({
          columns: [{ name: "n" }],
          rows: Array.from({ length: 150 }, (_, i) => ({ n: i })),
          rowCount: 150,
          truncated: false,
          elapsedMs: 12,
        }),
      },
    });
    const tool = ctx.tools.find((t) => t.name === "run_readonly_sql")!;
    const text = await tool.handler({ sql: "SELECT n FROM t", max_rows: 10 });
    assert.match(text, /返回 150 行/);
    assert.match(text, /耗时 12ms/);
    assert.match(text, /展示前 10 行/);
    assert.doesNotMatch(text, /\| 10\n/);
  });

  it("get_table_card 命中知识卡；未命中时回退表注释", async () => {
    const knowledge: DbBoardKnowledge = {
      version: 1,
      builtAt: "2026-01-01T00:00:00Z",
      domains: { 收发文: ["OA_DOC"] },
      tables: { OA_DOC: fakeCard({}) },
      repoSnapshots: [],
      stats: { tableCount: 1, domainCount: 1, distilled: 1, extracted: 0, dbCommentOnly: 0 },
    };
    const ctx = makeContext({ knowledge });
    const tool = ctx.tools.find((t) => t.name === "get_table_card")!;
    const hit = await tool.handler({ table: "public.oa_doc" });
    assert.match(hit, /用途：收发文单据主表/);
    assert.match(hit, /doc_no：文号/);
    assert.match(hit, /→ xt_user ON oa_doc\.create_by = xt_user\.id/);
    const miss = await tool.handler({ table: "xt_user" });
    assert.match(miss, /没有知识卡/);
  });

  it("search_knowledge 命中排序与未命中提示", async () => {
    const knowledge: DbBoardKnowledge = {
      version: 1,
      builtAt: "2026-01-01T00:00:00Z",
      domains: { 收发文: ["oa_doc"], 用户组织: ["xt_user"] },
      tables: {
        oa_doc: fakeCard({}),
        xt_user: fakeCard({ table: "xt_user", domain: "用户组织", purpose: "用户账号表" }),
      },
      repoSnapshots: [],
      stats: { tableCount: 2, domainCount: 2, distilled: 2, extracted: 0, dbCommentOnly: 0 },
    };
    const ctx = makeContext({ knowledge });
    const tool = ctx.tools.find((t) => t.name === "search_knowledge")!;
    const hit = await tool.handler({ keywords: "收发文 文号" });
    assert.match(hit, /1\. oa_doc/);
    const miss = await tool.handler({ keywords: "不存在域" });
    assert.match(miss, /没有命中/);
    assert.match(miss, /用户组织/);
  });

  it("save_table_card 映射 snake_case 参数为知识卡结构", async () => {
    const saved: unknown[] = [];
    const ctx = makeContext({
      knowledgeService: {
        saveTableCard: async (card) => {
          saved.push(card);
        },
      },
    });
    const tool = ctx.tools.find((t) => t.name === "save_table_card")!;
    const text = await tool.handler({
      table: "oa_doc",
      domain: "收发文",
      purpose: "主表",
      key_columns: [{ name: "doc_no", meaning: "文号" }],
      relations: [{ target: "xt_user" }],
    });
    assert.match(text, /已保存/);
    const card = saved[0] as DbBoardKnowledgeTableCard;
    assert.equal(card.table, "oa_doc");
    assert.deepEqual(card.keyColumns, [{ name: "doc_no", meaning: "文号" }]);
    assert.deepEqual(card.relations, [{ target: "xt_user" }]);
    assert.equal(card.source, "distilled");
  });

  it("generate_dashboard 输出 spec JSON 与 SQL，供 save_dashboard 回传", async () => {
    const ctx = makeContext();
    const generate = ctx.tools.find((t) => t.name === "generate_dashboard")!;
    const text = await generate.handler({ question: "今年产生了多少收发文" });
    assert.match(text, /收发文统计/);
    assert.match(text, /```json/);
    assert.match(text, /SELECT 1/);
  });

  it("知识库缺失时 search_knowledge 引导构建", async () => {
    const ctx = makeContext({ knowledge: null });
    const tool = ctx.tools.find((t) => t.name === "search_knowledge")!;
    const text = await tool.handler({ keywords: "收发文" });
    assert.match(text, /知识库尚未构建/);
  });
});

describe("buildDbBoardAgentPreamble", () => {
  it("包含边界、两步确认、连接标注与用户问题", () => {
    const preamble = buildDbBoardAgentPreamble({
      connection: { state: "connected", label: "hbt 测试库（dev）" },
      username: "alice",
      question: "今年产生了多少收发文？",
    });
    assert.match(preamble, /hbt 测试库（dev）/);
    assert.match(preamble, /两步/);
    assert.match(preamble, /删除/);
    assert.match(preamble, /操作日志/);
    assert.match(preamble, /今年产生了多少收发文？/);
    assert.match(preamble, /mcp__db_board__/);
  });

  it("未连接时引导先配置连接", () => {
    const preamble = buildDbBoardAgentPreamble({
      connection: { state: "disconnected", label: "未配置" },
      username: "local",
      question: "看下数据",
    });
    assert.match(preamble, /尚未配置数据库连接/);
  });
});
