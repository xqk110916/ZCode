import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDashboardGenerationPrompt,
  buildExplainQueryPrompt,
  dbBoardDashboardSpecSchema,
  draftSqlValidation,
  extractJsonObjectText,
  finalizeDashboardSpec,
  parseDashboardDraft,
  summarizeTablesForPrompt,
  type DbBoardPromptTable,
} from "../src/dbBoard/dbBoardGeneration.js";

const validDraftJson = JSON.stringify({
  title: "注册趋势看板",
  charts: [
    {
      title: "本月各渠道注册",
      type: "bar",
      sql: "SELECT channel, count(*) AS total FROM users GROUP BY channel",
      description: "按渠道统计本月注册量",
      dimension: "channel",
      measures: ["total"],
    },
    {
      title: "总注册数",
      type: "kpi",
      sql: "SELECT count(*) AS total FROM users",
    },
  ],
});

test("extractJsonObjectText 剥离围栏与前后杂文", () => {
  assert.equal(extractJsonObjectText('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonObjectText('好的，如下：\n{"a": 1}\n希望有帮助'), '{"a": 1}');
  assert.equal(extractJsonObjectText("没有 json"), null);
});

test("parseDashboardDraft 校验模型输出", () => {
  const ok = parseDashboardDraft(`\`\`\`json\n${validDraftJson}\n\`\`\``);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.draft.charts.length, 2);
    assert.equal(ok.draft.charts[0]!.type, "bar");
  }
  assert.equal(parseDashboardDraft("not json at all").ok, false);
  assert.equal(parseDashboardDraft('{"title":"x","charts":[]}').ok, false);
  assert.equal(parseDashboardDraft('{"title":"x","charts":[{"title":"a","type":"magic","sql":"SELECT 1"}]}').ok, false);
});

test("draftSqlValidation：全部非法才拒绝", () => {
  const ok = parseDashboardDraft(validDraftJson);
  assert.ok(ok.ok);
  if (!ok.ok) return;
  assert.equal(draftSqlValidation(ok.draft).ok, true);
  const invalid = parseDashboardDraft(
    JSON.stringify({
      title: "x",
      charts: [
        { title: "a", type: "bar", sql: "DELETE FROM t" },
        { title: "b", type: "line", sql: "SELECT 1" },
      ],
    }),
  );
  assert.ok(invalid.ok);
  if (invalid.ok) {
    // 存在合法图 → 通过（finalize 阶段过滤非法图）
    assert.equal(draftSqlValidation(invalid.draft).ok, true);
  }
  const allInvalid = parseDashboardDraft(
    JSON.stringify({
      title: "x",
      charts: [{ title: "a", type: "bar", sql: "DROP TABLE t" }],
    }),
  );
  assert.ok(allInvalid.ok);
  if (allInvalid.ok) {
    assert.equal(draftSqlValidation(allInvalid.draft).ok, false);
  }
});

test("finalizeDashboardSpec：过滤非法图、保留问题、追加修订历史", () => {
  const draft = parseDashboardDraft(
    JSON.stringify({
      title: "看板",
      charts: [
        { title: "合法", type: "bar", sql: "SELECT 1 AS a", dimension: "a", measures: ["a"] },
        { title: "非法", type: "bar", sql: "TRUNCATE TABLE t" },
      ],
    }),
  );
  assert.ok(draft.ok);
  if (!draft.ok) return;
  let chartIdSeq = 0;
  const spec = finalizeDashboardSpec(draft.draft, {
    id: "dash-1",
    question: "本月注册怎么样？",
    now: "2026-10-09T00:00:00.000Z",
    newChartId: () => `c${++chartIdSeq}`,
  });
  assert.equal(spec.charts.length, 1);
  assert.equal(spec.charts[0]!.title, "合法");
  assert.equal(spec.charts[0]!.id, "c1");
  assert.deepEqual(spec.revisionHistory, ["本月注册怎么样？"]);

  // 修订：保留原问题与 id，追加修订记录
  const revised = finalizeDashboardSpec(draft.draft, {
    id: spec.id,
    question: "ignored-on-revision",
    previousSpec: spec,
    revisionNote: "改成按周",
    now: "2026-10-09T01:00:00.000Z",
    newChartId: () => `c${++chartIdSeq}`,
  });
  assert.equal(revised.id, "dash-1");
  assert.equal(revised.question, "本月注册怎么样？");
  assert.deepEqual(revised.revisionHistory, ["本月注册怎么样？", "改成按周"]);
});

test("finalizeDashboardSpec 全非法图时报错", () => {
  const draft = parseDashboardDraft(
    JSON.stringify({ title: "x", charts: [{ title: "a", type: "bar", sql: "DROP TABLE t" }] }),
  );
  assert.ok(draft.ok);
  if (!draft.ok) return;
  assert.throws(() =>
    finalizeDashboardSpec(draft.draft, {
      id: "dash-2",
      question: "q",
      now: "now",
      newChartId: () => "c",
    }),
  );
});

test("定稿 spec zod 校验往返", () => {
  const spec = {
    id: "dash-1",
    title: "看板",
    question: "q",
    charts: [{ id: "c1", title: "t", type: "bar", sql: "SELECT 1" }],
    revisionHistory: ["q"],
    updatedAt: "2026-10-09T00:00:00.000Z",
  };
  assert.equal(dbBoardDashboardSpecSchema.safeParse(spec).success, true);
  assert.equal(
    dbBoardDashboardSpecSchema.safeParse({ ...spec, charts: [] }).success,
    false,
  );
  assert.equal(dbBoardDashboardSpecSchema.safeParse({ ...spec, id: "" }).success, false);
});

test("prompt 构建包含元数据、问题与修订上下文", () => {
  const tables: DbBoardPromptTable[] = [
    {
      schema: "PUBLIC",
      name: "users",
      columns: [
        { name: "id", dataType: "BIGINT", family: "number", nullable: false, isPrimaryKey: true, hasDefault: true },
        { name: "channel", dataType: "CHARACTER VARYING", family: "text", nullable: true, isPrimaryKey: false, hasDefault: false },
      ],
    },
  ];
  const prompt = buildDashboardGenerationPrompt({ tables, question: "本月注册怎么样？" });
  assert.match(prompt, /PUBLIC\.users\(id BIGINT\(PK,NOT NULL\), channel CHARACTER VARYING\)/);
  assert.match(prompt, /用户问题：本月注册怎么样？/);
  assert.match(prompt, /只读 SELECT/);

  const revisionPrompt = buildDashboardGenerationPrompt({
    tables,
    question: "本月注册怎么样？",
    previousSpec: {
      id: "d1",
      title: "看板",
      question: "本月注册怎么样？",
      charts: [{ id: "c1", title: "t", type: "bar", sql: "SELECT 1" }],
      revisionHistory: ["本月注册怎么样？"],
      updatedAt: "now",
    },
    revisionNote: "改成按周",
  });
  assert.match(revisionPrompt, /用户修订指令：改成按周/);
  assert.match(revisionPrompt, /当前看板定义/);
});

test("元数据摘要超限截断并提示点名表", () => {
  const manyTables: DbBoardPromptTable[] = Array.from({ length: 500 }, (_, index) => ({
    schema: "PUBLIC",
    name: `table_${index}`,
    columns: [
      { name: "id", dataType: "BIGINT", family: "number", nullable: false, isPrimaryKey: true, hasDefault: true },
    ],
  }));
  const summary = summarizeTablesForPrompt(manyTables, 2_000);
  assert.match(summary, /表过多已截断/);
});

test("explain prompt 包含 SQL 与问题", () => {
  const prompt = buildExplainQueryPrompt({
    sql: "SELECT channel, count(*) FROM users GROUP BY channel",
    chartTitle: "渠道分布",
    question: "注册来源分布？",
  });
  assert.match(prompt, /渠道分布/);
  assert.match(prompt, /GROUP BY channel/);
  assert.match(prompt, /注册来源分布？/);
});
