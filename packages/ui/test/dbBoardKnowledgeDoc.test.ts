import test from "node:test";
import assert from "node:assert/strict";
import { buildKnowledgeMarkdown, knowledgeExportFileName } from "../src/dbBoard/dbBoardKnowledgeDoc.js";
import type { DbBoardKnowledge } from "@zcode/services";

const knowledge: DbBoardKnowledge = {
  version: 1,
  builtAt: "2026-10-10T00:00:00.000Z",
  domains: { 收发文: ["oa_doc", "oa_doc_transfer"], 用户: ["xt_user"] },
  tables: {
    oa_doc: {
      table: "oa_doc",
      domain: "收发文",
      purpose: "公文主表，存储收文/发文的正文与流转状态",
      keyColumns: [
        { name: "written_time", meaning: "成文时间（varchar，需 ::timestamp 转换）" },
        { name: "doc_status", meaning: "公文状态" },
      ],
      relations: [{ target: "xt_user", on: "create_user = USER_ID", kind: "left-join" }],
      notes: "时间列为字符串存储",
      evidenceFiles: ["hbt-oa/oa-common/src/main/resources/mapper/doc/DocMapper.xml"],
      source: "distilled",
    },
    oa_doc_transfer: {
      table: "oa_doc_transfer",
      domain: "收发文",
      purpose: "公文传送表（发文的传送）",
      keyColumns: [],
      relations: [],
      evidenceFiles: [],
      source: "extracted",
    },
    xt_user: {
      table: "xt_user",
      domain: "用户",
      purpose: "系统用户账号表",
      keyColumns: [],
      relations: [],
      evidenceFiles: [],
      source: "db-comment",
    },
  },
  repoSnapshots: [{ path: "hbt-oa", head: "abc123" }],
  stats: {
    tableCount: 3,
    domainCount: 2,
    distilled: 1,
    extracted: 1,
    dbCommentOnly: 1,
    datasourceMapping: [{ service: "oa-admin", url: "jdbc:kingbase8://10.41.108.150:54321/hbt_test" }],
  },
};

test("知识库 Markdown 导出：域分组/卡片字段/统计/数据源映射", () => {
  const md = buildKnowledgeMarkdown(knowledge);
  assert.match(md, /# 数据库业务知识库/u);
  assert.match(md, /## 业务域：收发文（2 张表）/u);
  assert.match(md, /### oa_doc（收发文）/u);
  assert.match(md, /\*\*用途\*\*：公文主表/u);
  assert.match(md, /written_time=成文时间/u);
  assert.match(md, /xt_user（ON create_user = USER_ID）/u);
  assert.match(md, /\*\*备注\*\*：时间列为字符串存储/u);
  assert.match(md, /\*\*来源\*\*：LLM 蒸馏/u);
  assert.match(md, /oa-admin → jdbc:kingbase8/u);
  assert.match(md, /LLM 蒸馏 1 \/ 代码抽取 1 \/ 数据库注释 1/u);
  // 域按表数降序
  assert.ok(md.indexOf("收发文") < md.indexOf("## 业务域：用户"));
});

test("导出文件名含日期", () => {
  assert.match(knowledgeExportFileName(), /^数据库业务知识库-\d{8}\.md$/u);
});

test("导出携带数据库概览：指标行 + 常用业务表表格（仅 summary 存在时）", () => {
  const mdWithout = buildKnowledgeMarkdown(knowledge, null);
  assert.doesNotMatch(mdWithout, /## 数据库概览/u);

  const md = buildKnowledgeMarkdown(knowledge, {
    generatedAt: "2026-10-10T08:00:00.000Z",
    tableCount: 275,
    knowledgeTableCount: 3,
    domainCount: 2,
    countedTableCount: 3,
    rowCountSource: "count",
    frequentTables: [
      { table: "oa_doc", domain: "收发文", purpose: "公文主表", rowCount: 23751 },
      { table: "xt_user", domain: "用户", purpose: "含竖线|用途", rowCount: 1000 },
    ],
  });
  assert.match(md, /## 数据库概览/u);
  assert.match(md, /统计时间：2026-10-10T08:00:00\.000Z/u);
  assert.match(md, /表总数：275 · 知识覆盖：3 · 业务域：2 · 已统计行数表数：3/u);
  assert.match(md, /### 常用业务表（按行数降序，仅列行数 ≥1000 的前 20 张）/u);
  assert.match(md, /\| oa_doc \| 收发文 \| 公文主表 \| 23,751 \|/u);
  // 用途中的竖线转义，不破坏表格
  assert.match(md, /含竖线\\|用途/u);
  // 概览在业务域章节之前
  assert.ok(md.indexOf("## 数据库概览") < md.indexOf("## 业务域："));
});
